// Pure date arithmetic on YYYY-MM-DD strings (UTC, no timezone surprises).

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((da - db) / 86_400_000);
}

/** 'YYYY-MM' month key for a date. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** First day of the month containing `date`, as 'YYYY-MM-01'. */
export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add `n` whole months to a 'YYYY-MM-01' (or any) date, returning the 1st of the resulting month. */
export function addMonths(date: string, n: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + n;   // 0-based month index
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

/** Calendar days in a given month. `month` is 1..12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();   // day 0 of next month = last day of this month
}
