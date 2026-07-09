// Turn parsed FBA-export records into normalized snapshot lines + a validation report.
import type { HeaderMapping } from './mapping.ts';

export interface NormalizedLine {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  title: string | null;
  condition: string | null;
  available: number;
  inbound_working: number;
  inbound_shipped: number;
  inbound_received: number;
  reserved: number;
  unfulfillable: number;
  units_shipped_t7: number | null;
  units_shipped_t30: number | null;
  units_shipped_t60: number | null;
  units_shipped_t90: number | null;
  amazon_days_of_supply: number | null;
  amazon_min_inventory_level: number | null;
  your_price: number | null;
  raw: Record<string, string>;
  flags: string[];
}

export interface NormalizeResult {
  lines: NormalizedLine[];
  snapshotDate: string | null;
  rowsTotal: number;
  rowsSkipped: { row: number; reason: string }[];
  warnings: string[];
}

/**
 * Quantity fields: blank → 0 (flagged), negative → 0 (flagged).
 * Velocity fields: blank → null — "no data" must stay distinct from "zero sales",
 * otherwise suppressed listings read as dormant zero-sellers.
 */
function addFlag(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function qty(
  rec: Record<string, string>,
  header: string | undefined,
  flags: string[],
  opts: { flagBlank?: boolean } = {},
): number {
  if (!header) return 0;
  const v = (rec[header] ?? '').trim();
  if (v === '') { if (opts.flagBlank) addFlag(flags, 'BLANK_QTY_ZEROED'); return 0; }
  const n = Number(v.replace(/,/g, ''));
  if (Number.isNaN(n)) { addFlag(flags, 'BLANK_QTY_ZEROED'); return 0; }
  if (n < 0) { addFlag(flags, 'NEGATIVE_QTY_ZEROED'); return 0; }
  return Math.round(n);
}

function nullableNum(rec: Record<string, string>, header: string | undefined): number | null {
  if (!header) return null;
  const v = (rec[header] ?? '').trim();
  if (v === '') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

function nullableInt(rec: Record<string, string>, header: string | undefined): number | null {
  const n = nullableNum(rec, header);
  return n === null ? null : Math.max(0, Math.round(n));
}

function text(rec: Record<string, string>, header: string | undefined): string | null {
  if (!header) return null;
  const v = (rec[header] ?? '').trim();
  return v === '' ? null : v;
}

export function normalizeFbaRecords(records: Record<string, string>[], mapping: HeaderMapping): NormalizeResult {
  const f = mapping.fields;
  const bySku = new Map<string, NormalizedLine>();
  const rowsSkipped: { row: number; reason: string }[] = [];
  const warnings: string[] = [];
  let snapshotDate: string | null = null;
  const dates = new Set<string>();

  records.forEach((rec, idx) => {
    const sku = text(rec, f.sku);
    if (!sku) {
      rowsSkipped.push({ row: idx + 2, reason: 'blank SKU' });
      return;
    }
    const date = text(rec, f.snapshot_date);
    if (date) dates.add(date.slice(0, 10));

    const flags: string[] = [];
    const line: NormalizedLine = {
      sku,
      fnsku: text(rec, f.fnsku),
      asin: text(rec, f.asin),
      title: text(rec, f.title),
      condition: text(rec, f.condition),
      available: qty(rec, f.available, flags, { flagBlank: true }),
      inbound_working: qty(rec, f.inbound_working, flags),
      inbound_shipped: qty(rec, f.inbound_shipped, flags),
      inbound_received: qty(rec, f.inbound_received, flags),
      reserved: qty(rec, f.reserved, flags),
      unfulfillable: qty(rec, f.unfulfillable, flags),
      units_shipped_t7: nullableInt(rec, f.units_shipped_t7),
      units_shipped_t30: nullableInt(rec, f.units_shipped_t30),
      units_shipped_t60: nullableInt(rec, f.units_shipped_t60),
      units_shipped_t90: nullableInt(rec, f.units_shipped_t90),
      amazon_days_of_supply: nullableNum(rec, f.amazon_days_of_supply),
      amazon_min_inventory_level: nullableInt(rec, f.amazon_min_inventory_level),
      your_price: nullableNum(rec, f.your_price),
      raw: rec,
      flags,
    };

    // No components mapped but a total exists → put the total in "shipped" so the
    // pipeline math still sees inbound units (flagged for transparency).
    if (!f.inbound_working && !f.inbound_shipped && !f.inbound_received && f.inbound_total) {
      line.inbound_shipped = qty(rec, f.inbound_total, line.flags);
      if (line.inbound_shipped > 0) addFlag(line.flags, 'INBOUND_TOTAL_ONLY');
    }

    const existing = bySku.get(sku);
    if (existing) {
      // Duplicate SKU rows (e.g. condition variants): sum quantities, keep first metadata.
      existing.available += line.available;
      existing.inbound_working += line.inbound_working;
      existing.inbound_shipped += line.inbound_shipped;
      existing.inbound_received += line.inbound_received;
      existing.reserved += line.reserved;
      existing.unfulfillable += line.unfulfillable;
      for (const k of ['units_shipped_t7', 'units_shipped_t30', 'units_shipped_t60', 'units_shipped_t90'] as const) {
        if (line[k] !== null) existing[k] = (existing[k] ?? 0) + (line[k] as number);
      }
      if (!existing.flags.includes('DUPLICATE_ROW_MERGED')) existing.flags.push('DUPLICATE_ROW_MERGED');
      return;
    }
    bySku.set(sku, line);
  });

  if (dates.size === 1) snapshotDate = [...dates][0];
  else if (dates.size > 1) warnings.push(`File contains ${dates.size} different snapshot dates — using the latest.`);
  if (dates.size > 1) snapshotDate = [...dates].sort().at(-1) ?? null;

  return {
    lines: [...bySku.values()],
    snapshotDate,
    rowsTotal: records.length,
    rowsSkipped,
    warnings,
  };
}

export interface PreviousLine {
  sku: string;
  available: number;
}

/** Sanity deltas vs the previous snapshot — catches wrong-file / wrong-account mistakes. */
export function sanityWarnings(lines: NormalizedLine[], previous: PreviousLine[]): string[] {
  const warnings: string[] = [];
  if (previous.length === 0) return warnings;
  const prevBySku = new Map(previous.map(p => [p.sku, p.available]));
  let bigDrops = 0;
  const examples: string[] = [];
  for (const l of lines) {
    const prev = prevBySku.get(l.sku);
    if (prev !== undefined && prev >= 20 && l.available < prev * 0.2) {
      bigDrops++;
      if (examples.length < 3) examples.push(`${l.sku}: ${prev} → ${l.available}`);
    }
  }
  if (bigDrops > 0) {
    warnings.push(`${bigDrops} SKU(s) dropped more than 80% in available stock since the last snapshot (e.g. ${examples.join('; ')}). Fine if expected — double-check it's the right file otherwise.`);
  }
  const missing = previous.filter(p => !lines.some(l => l.sku === p.sku)).length;
  if (missing > 0) warnings.push(`${missing} previously-seen SKU(s) are absent from this file.`);
  return warnings;
}
