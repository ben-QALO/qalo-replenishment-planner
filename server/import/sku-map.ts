// Parse the QALO ↔ Amazon ↔ ASIN mapping CSV (headers: "Amazon SKU", "Child ASIN", "QALO SKU").
// One row per product. Rows missing a QALO SKU are skipped (blank/junk trailing rows).

import { parseFile } from './parse.ts';

export interface SkuMapRow {
  qalo_sku: string;
  amazon_sku: string | null;
  asin: string | null;
}

export interface SkuMapParse {
  rows: SkuMapRow[];
  headerFound: boolean;
  skipped: number;       // rows dropped for having no QALO SKU
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseSkuMap(buf: Buffer): SkuMapParse {
  const { headers, records } = parseFile(buf);
  const normalized = headers.map(norm);

  // "QALO SKU" → qalosku ; "Amazon SKU" → amazonsku ; "(Child) ASIN" → childasin.
  const qaloIdx = normalized.findIndex(h => h.includes('qalo') && h.includes('sku'));
  const amazonIdx = normalized.findIndex(h => h.includes('amazon') && h.includes('sku'));
  const asinIdx = normalized.findIndex(h => h === 'childasin' || h.endsWith('childasin') || h === 'asin' || h.endsWith('asin'));

  if (qaloIdx < 0 || amazonIdx < 0) {
    return { rows: [], headerFound: false, skipped: 0 };
  }

  const qaloKey = headers[qaloIdx];
  const amazonKey = headers[amazonIdx];
  const asinKey = asinIdx >= 0 ? headers[asinIdx] : null;

  const bySku = new Map<string, SkuMapRow>();
  let skipped = 0;
  for (const rec of records) {
    const qalo = (rec[qaloKey] ?? '').trim();
    if (!qalo) { skipped++; continue; }
    const amazon = (rec[amazonKey] ?? '').trim();
    const asin = asinKey ? (rec[asinKey] ?? '').trim().toUpperCase() : '';
    bySku.set(qalo, { qalo_sku: qalo, amazon_sku: amazon || null, asin: asin || null });
  }

  return { rows: [...bySku.values()], headerFound: true, skipped };
}
