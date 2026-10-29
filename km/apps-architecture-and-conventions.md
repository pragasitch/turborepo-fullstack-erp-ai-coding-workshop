# Apps: สถาปัตยกรรม, เทคโนโลยี และ Conventions

> สรุปความเข้าใจฝั่ง `apps/` ของ monorepo นี้ — ใครเป็นคน implement อะไร, เทคโนโลยี, โครงสร้างโฟลเดอร์, การเขียน API path และการ test
> อ้างอิงจาก root `AGENTS.md` และ `AGENTS.md` ของแต่ละแอป

## ภาพรวม apps

Monorepo นี้ใช้ Turborepo + pnpm workspaces (รันใน Docker) มี 3 แอป:

| Path       | Package    | เทคโนโลยี                                                             |
| ---------- | ---------- | --------------------------------------------------------------------- |
| `apps/web` | `@erp/web` | Vite + React 19, React Router, TanStack Query, Tailwind v4, shadcn/ui |
| `apps/api` | `@erp/api` | NestJS 12 (native ESM), oRPC ผ่าน `@orpc/nest`, Prisma                |
| `apps/e2e` | `@erp/e2e` | Playwright browser tests (รันทุก PR)                                  |

Shared packages:

| Path                 | Package          | หน้าที่                                                    |
| -------------------- | ---------------- | ---------------------------------------------------------- |
| `packages/contracts` | `@erp/contracts` | oRPC routes + Zod schemas — single source of truth ของ API |
| `packages/database`  | `@erp/database`  | Prisma 7 schema, migrations, seed, generated client        |

## ใครเป็นคน implement อะไร (Contract-first)

หัวใจของสถาปัตยกรรมคือ **contract-first**:

- `packages/contracts` คือ **single source of truth** ของ API เขียนด้วย oRPC routes + Zod schemas
- `apps/api` ไม่ประกาศ route เอง แต่ **implement** ตาม contract
- `apps/web` **เรียกใช้** contract เดียวกันผ่าน typed client
- ทั้งสองฝั่ง derive types จาก contract ด้วย `z.infer`
- **ห้าม** เขียน request/response type หรือ validation ด้วยมือในแอป

พูดอีกแบบ: contract นิยาม "สัญญา", api เป็นคน implement ฝั่ง server, web เป็นคนใช้ฝั่ง client

## โครงสร้างโฟลเดอร์ถูกกำหนดที่ไหน

กำหนดในไฟล์ `AGENTS.md` ของแต่ละระดับ (root + per-app)

### apps/api (`apps/api/AGENTS.md`)

- หนึ่ง Nest module ต่อหนึ่ง feature ใน `src/<feature>/` ประกอบด้วย `<feature>.module.ts` และ `<feature>.controller.ts` แล้ว register ใน `src/app.module.ts`
- ของจริงใน `src/`: `sales/`, `products/`, `purchase-orders/`, `inventory/`, `suppliers/`, `stores/`, `reports/`, `adjustments/`, `auth/`, `health/`, `database/`, `config/`, `openapi/`

### apps/web (`apps/web/AGENTS.md`)

- routes → `src/router.tsx`
- pages → `src/routes/`
- feature components → `src/components/`
- shadcn/ui primitives → `src/components/ui` (generated, ห้ามแก้มือ)
- lib/utilities → `src/lib/`

## การเขียน API path

Path ถูกกำหนด **ในฝั่ง contract ไม่ใช่ในแอป**

ตัวอย่างจาก `packages/contracts/src/health.ts`:

```typescript
export const healthContract = {
  check: oc
    .route({
      method: 'GET',
      path: '/health', // ← path ประกาศที่นี่
      summary: '...',
      tags: ['Health'],
    })
    .output(HealthCheckSchema),
};
```

ฝั่ง api แค่ implement route นั้น (`apps/api/src/health/health.controller.ts`):

```typescript
@Public()
@Implement(contract.health.check)
check() {
  return implement(contract.health.check).handler(async () => { ... });
}
```

กฎสำคัญเรื่อง path (จาก `apps/api/AGENTS.md`):

- global prefix คือ `/api` (ตั้งใน `apps/api/src/main.ts`) — **contract path ไม่ต้องใส่ `/api` ซ้ำ** เช่น contract เขียน `/health` → จริง ๆ คือ `/api/health`
- ทุก route ต้องมี user ที่ login แล้ว (global `AuthGuard`)
  - เปิด public ด้วย `@Public()`
  - จำกัด role ด้วย `@Roles('ADMIN')`
  - อ่าน user ด้วยพารามิเตอร์ `@CurrentUser() user: User`
  - ทั้งหมดอยู่ใน `apps/api/src/auth/auth.decorators.ts`
- **ห้ามใช้ `class-validator` DTO** — input ถูก validate ด้วย Zod จาก contract แล้ว
- database access ผ่าน `PrismaService` ที่ inject เท่านั้น (ห้ามสร้าง `PrismaClient` เอง)

ฝั่ง web ยิงไปที่ `/api` origin เดียวกัน (Vite proxy ไป NestJS) ผ่าน typed client `orpc` จาก `@/lib/orpc` — **ห้าม hard-code URL หรือเขียน `fetch` เอง**

## การ test

กำหนดใน `AGENTS.md` ของแต่ละแอป + skill `write-tests` / `write-e2e`

- **api**: unit test เป็นไฟล์ `*.spec.ts` colocated ข้าง controller
  - รันด้วย Vitest config ที่ `apps/api/vitest.config.ts` ซึ่ง `include: ['src/**/*.spec.ts']`
  - **exclude** ไฟล์ `*.integration.spec.ts` (integration ต้องใช้ Postgres รันแยกด้วย `pnpm test:integration` ผ่าน `vitest.integration.config.ts`)
  - สไตล์ test: ใช้ `Test.createTestingModule` ของ Nest + `call()` ของ `@orpc/server` + mock `PrismaService` (ดู `health.controller.spec.ts`)
- **web**: component test เป็นไฟล์ `*.test.tsx` colocated
- **contracts**: schema test colocated เช่น `health.test.ts`, `sales.test.ts`
- **e2e**: Playwright ใน `apps/e2e/tests/` หนึ่งไฟล์ต่อหนึ่ง `Demo:` line ของ ticket รันทุก PR
  - ฝั่ง web ทุก interactive element ต้องมี accessible name (label / aria-label / role) เพื่อให้ Playwright locator หาเจอโดยไม่ต้องใช้ `data-testid`

## Root AGENTS.md — Rules (อธิบายทีละข้อ)

1. **Contract-first** — API shape อยู่ที่ `packages/contracts`, api implement, web เรียกใช้, ทั้งสองฝั่ง derive type ด้วย `z.infer`, ห้ามเขียน type/validation ด้วยมือในแอป
2. **ESM everywhere** — `apps/api` และ `packages/*`: relative import ต้องใส่ `.js`; `apps/web`: ใช้ alias `@/` แทน `src/` และไม่ต้องใส่นามสกุล
3. **Env vars** — validate ที่ `apps/api/src/config/env.ts`; เพิ่มตัวใหม่ต้องใส่ใน `.env.example` ด้วย
4. **Shared packages** — build ไปที่ `dist/`; แอป import จาก output ที่ build แล้ว (แก้ package แล้วแอปเห็นของเก่า = ยังไม่ build ใหม่)
5. **Before finishing** — รันจาก repo root: `pnpm check` (lint, typecheck, test, build) + `pnpm format`; และ `pnpm e2e` เมื่อแตะ `Demo:` line, page หรือ `apps/e2e`

## Skills (อ้างใน root AGENTS.md)

โหลด skill ที่ตรงงานแทนการเดารายละเอียด:

- `add-feature` — recipe end-to-end พร้อม template (Prisma model → contract → Nest module → React → tests)
- `write-tests` — วิธีเขียน/รัน api specs, web component tests, contract schema tests
- `write-e2e` — วิธีเขียน/รัน Playwright ใน `apps/e2e` หนึ่งไฟล์ต่อ `Demo:` line และวิธีแก้เมื่อ check `e2e` แดง
- `repo-commands` — Docker vs host, db migrations/seed/reset, `--filter`, dependencies, Prisma และ `node_modules` gotchas

---

_อ้างอิง: `AGENTS.md` (root), `apps/api/AGENTS.md`, `apps/web/AGENTS.md`, `packages/contracts/src/health.ts`, `apps/api/src/health/`_
