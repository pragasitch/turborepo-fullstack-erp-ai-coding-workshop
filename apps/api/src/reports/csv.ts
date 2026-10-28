/**
 * CSV writing for the report exports (RPT-04).
 *
 * - UTF-8 with a byte order mark, so spreadsheet software renders Thai text.
 * - Formula-injection guard: a cell that begins with `=`, `+`, `-`, `@`, tab or carriage
 *   return is prefixed with a single quote, so a spreadsheet shows it as text instead of
 *   evaluating it. The prefix goes on before quoting, so it stays inside the quotes.
 * - RFC 4180 quoting for commas, quotes and line breaks, and CRLF between records.
 */

const BOM = '\uFEFF';
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

export type CsvCell = string | number | null;

/** One cell as safe CSV text. */
export function csvCell(value: CsvCell): string {
  if (value === null) return '';
  let text = String(value);
  if (FORMULA_TRIGGERS.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A downloadable CSV file: BOM, a header record, then one record per row. */
export function csvFile(
  name: string,
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): File {
  const records = [header, ...rows].map((row) => row.map(csvCell).join(',') + '\r\n');
  return new File([BOM + records.join('')], name, { type: 'text/csv; charset=utf-8' });
}
