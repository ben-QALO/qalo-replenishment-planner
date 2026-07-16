// Amazon Business Report — "Detail Page Sales and Traffic by Child Item".
// Per child ASIN, over a chosen window (the team exports the last 30 days). We read the
// true demand column: prefer "Units Ordered" when present, else "Total Order Items" (the
// count of ordered items, a close proxy for units on mostly-single-unit products like rings).
// This captures FBM + FBA sales, so OOS-on-FBA and FBM-tested items show real velocity.

import { parseFile } from './parse.ts';

export interface BusinessReportRow {
  asin: string;
  units: number;
  title: string | null;
}

export interface BusinessReportParse {
  rows: BusinessReportRow[];
  unitsColumn: string;       // which header we read demand from
  windowDays: number;        // assumed report window (default 30)
  headerFound: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Demand columns, most-preferred first. "Units ordered" is the true unit count; "total
// order items" is the fallback (order-item count). B2B variants are subsets, never summed.
const UNITS_HEADERS = ['unitsordered', 'totalorderitems'];
const ASIN_HEADERS = ['childasin', 'asin']; // "(Child) ASIN" → "childasin"

function toInt(raw: string): number {
  // Strip currency/thousands separators but KEEP the decimal point and sign, then round —
  // otherwise "1,234.00" would lose its point and read as 123,400.
  const n = Math.round(Number((raw ?? '').replace(/[^0-9.\-]/g, '')));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function parseBusinessReport(buf: Buffer, windowDays = 30): BusinessReportParse {
  const { headers, records } = parseFile(buf);
  const normalized = headers.map(norm);

  // Find the ASIN column — prefer the CHILD asin over the parent.
  let asinIdx = -1;
  for (const want of ASIN_HEADERS) {
    const i = normalized.findIndex(h => h === want || h.endsWith(want));
    if (i >= 0) { asinIdx = i; break; }
  }
  // Find the demand column — first exact-ish match, but never a B2B (subset) column.
  let unitsIdx = -1;
  for (const want of UNITS_HEADERS) {
    const i = normalized.findIndex(h => h.includes(want) && !h.includes('b2b'));
    if (i >= 0) { unitsIdx = i; break; }
  }
  const titleIdx = normalized.findIndex(h => h === 'title');

  if (asinIdx < 0 || unitsIdx < 0) {
    return { rows: [], unitsColumn: '', windowDays, headerFound: false };
  }

  const asinKey = headers[asinIdx];
  const unitsKey = headers[unitsIdx];
  const titleKey = titleIdx >= 0 ? headers[titleIdx] : null;

  // Sum by ASIN (a child ASIN should be unique, but coalesce defensively).
  const bySku = new Map<string, BusinessReportRow>();
  for (const rec of records) {
    const asin = (rec[asinKey] ?? '').trim().toUpperCase();
    if (!asin) continue;
    const units = toInt(rec[unitsKey]);
    const existing = bySku.get(asin);
    if (existing) existing.units += units;
    else bySku.set(asin, { asin, units, title: titleKey ? (rec[titleKey] ?? '').trim() || null : null });
  }

  return { rows: [...bySku.values()], unitsColumn: unitsKey, windowDays, headerFound: true };
}
