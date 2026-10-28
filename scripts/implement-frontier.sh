#!/usr/bin/env bash
# One pass of the implement loop over the frontier, without the typing. See lessons/09.
#
# For every open ticket whose blockers are all closed, up to --max of them:
#   reset the dev database, branch from main, run one headless Kiro session on
#   the ticket, report the pull request it opened (or that it didn't), go back
#   to main, next ticket.
#
# It never merges, never closes a ticket, and never computes a frontier that
# GitHub doesn't report. A human runs it from a terminal: the agent guard
# refuses it to agents, because the reset inside it would otherwise run
# unguarded.
set -euo pipefail

max=20
spec=""
effort="high"
dry_run=0

usage() {
  cat <<'EOF'
Usage: pnpm implement:frontier [--max N] [--spec N] [--effort LEVEL] [--dry-run]

  --max N        tickets to build in this pass, lowest numbers first (default 3)
  --spec N       the spec issue; default: the oldest open ready-for-agent issue
  --effort LEVEL reasoning effort for the implementer (default high)
  --dry-run      print the frontier and the plan, build nothing
EOF
}

fail() {
  echo "implement-frontier: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --max) max="$2"; shift 2 ;;
    --spec) spec="$2"; shift 2 ;;
    --effort) effort="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
mkdir -p .ai-runs

# --- Preflight: everything the loop assumes, checked before the first ticket.
for cmd in gh kiro-cli pnpm node docker jq; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"
done
gh auth status >/dev/null 2>&1 || fail "gh is not logged in"
repo=$(gh repo set-default --view 2>/dev/null || true)
[ -n "$repo" ] || fail "no default repository; run 'gh repo set-default' and pick your fork"
kiro-cli agent validate --path .kiro/agents/implementer.json >/dev/null 2>&1 ||
  fail ".kiro/agents/implementer.json does not validate"
[ -f .kiro/prompts/implement-unattended.md ] || fail ".kiro/prompts/implement-unattended.md is missing"
[ "$(git branch --show-current)" = "main" ] || fail "switch to main first"
[ -z "$(git status --short)" ] || fail "the working tree is not clean"
docker compose ps --services --status running 2>/dev/null | grep -qx postgres ||
  fail "Postgres is not running; start it with 'pnpm dev:local' or 'docker compose up'"

git pull --ff-only --quiet

if [ -z "$spec" ]; then
  spec=$(gh issue list --label ready-for-agent --limit 1 --search "sort:created-asc" \
    --json number --jq '.[0].number')
  [ -n "$spec" ] && [ "$spec" != "null" ] || fail "no spec found; pass --spec N"
fi

# --- The frontier: open sub-issues of the spec with zero open blockers.
frontier=$(gh api "repos/{owner}/{repo}/issues/$spec/sub_issues" --paginate \
  --jq '.[] | select(.state=="open" and .issue_dependencies_summary.blocked_by==0) | .number' |
  sort -n | head -n "$max")

echo "Repository: $repo"
echo "Spec:       #$spec"
if [ -z "$frontier" ]; then
  echo "Frontier:   empty. Nothing is unblocked; merge something or fix the edges."
  exit 0
fi
echo "Frontier:   $(echo "$frontier" | sed 's/^/#/' | tr '\n' ' ')(max $max)"
echo

# --- The narrator. Headless Kiro's text output names the tool and not the
# command ("[tool] Run Command", "status: InProgress"), which says nothing about
# what the run is doing. Its stream-json output is one event per line, and the
# tool_call event carries the command or the path. This turns that stream into
# one line per thing the agent does, and the agent's own words in between.
narrate() {
  jq -nrj --unbuffered --arg root "$PWD" '
    def short: tostring | gsub("\n"; " ") | ltrimstr($root + "/") | .[0:200];
    def line:
      if .type == "runFinished" then "[run] \(.data.status), \(.data.stopReason)"
      else (.data.update // {}) |
        if .sessionUpdate == "tool_call" then
          "[\(.kind // "tool")] \(.rawInput.command // .rawInput.path // .title // "?" | short)"
        elif .sessionUpdate == "tool_call_update" and .status == "failed" then
          "[failed] \(.title // "")  \([.content[]?.content.text? // empty] | join(" ") | short)"
        else null end
      end;
    foreach inputs as $e ({newline: true, out: ""};
      ($e.data.update // {}) as $u |
      if $u.sessionUpdate == "agent_message_chunk" then
        ($u.content.text // "") as $t | {newline: ($t | endswith("\n")), out: $t}
      else ($e | line) as $l |
        if $l == null then {newline, out: ""}
        else {newline: true, out: ((if .newline then "" else "\n" end) + $l + "\n")} end
      end;
      .out)'
}

# --- One ticket at a time, each from main, each in a fresh process.
results=()
for n in $frontier; do
  title=$(gh issue view "$n" --json title --jq .title)
  slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' |
    sed 's/^-//; s/-$//' | cut -c1-50 | sed 's/-$//')
  branch="ticket/$n-$slug"
  log=".ai-runs/$n.log"
  events=".ai-runs/$n.events.jsonl"

  echo "== #$n  $title"
  echo "   branch $branch, log $log, events $events"

  if git show-ref --verify --quiet "refs/heads/$branch" ||
    git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "   skipped: $branch already exists. A previous run left it; a human decides."
    results+=("#$n  skipped, branch exists")
    continue
  fi

  if [ "$dry_run" = 1 ]; then
    results+=("#$n  would build on $branch")
    continue
  fi

  # The reset the guard refuses to the agent. Each ticket branches from main,
  # so the database must not carry the previous ticket's migration.
  pnpm --filter @erp/database exec prisma migrate reset --force >"$log" 2>&1 ||
    fail "database reset failed for #$n; see $log"
  : >"$events"

  git switch -c "$branch" --quiet

  # The run. The saved prompt carries the skill and the headless changes to it.
  # No --trust-all-tools: the agent file says what is allowed, and the guard
  # runs inside the session exactly as it does in an interactive one.
  # Every event goes to $events as it arrives; the narrated version goes to
  # the screen and $log; Kiro's own stderr (startup info, denials) to $log.
  set +e
  kiro-cli chat --v3 --no-interactive --output-format stream-json --agent implementer \
    --effort "$effort" --trust-workspace "/implement-unattended #$n" 2>>"$log" |
    tee -a "$events" | narrate | tee -a "$log"
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" = 0 ] || echo "   kiro-cli exited $status" | tee -a "$log"

  if [ -n "$(git status --short)" ]; then
    echo "   stopped: the run left uncommitted changes on $branch. Look before going on." | tee -a "$log"
    results+=("#$n  stopped, uncommitted changes on $branch")
    break
  fi

  pr=$(gh pr list --head "$branch" --json url --jq '.[0].url // empty')
  if [ -n "$pr" ]; then
    results+=("#$n  $pr")
  else
    results+=("#$n  no PR; see $log")
  fi

  git switch main --quiet
  echo
done

git switch main --quiet 2>/dev/null || true

echo
echo "Pass finished. Nothing merged, nothing closed."
printf '  %s\n' "${results[@]}"
echo
echo "Next: for each PR, switch to its branch, reset the database, run the Demo: line, read the diff"
echo "against the criteria, tick the boxes, wait for CI and the AI review, and let a colleague merge."
