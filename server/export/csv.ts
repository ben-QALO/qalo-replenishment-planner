export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}
