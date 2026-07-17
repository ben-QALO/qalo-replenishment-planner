// Turn Business-Report demand rows into per-SKU demand the engine can plan against.
//
// The report can be by-ASIN (one figure per product) or by-SKU (one figure per SKU). The
// engine plans per SKU, so we must decide how much demand each *tracked* SKU (a SKU the tool
// knows, i.e. an FBA SKU in the catalog) should be sized for.
//
// Rules:
//   • by-ASIN report  → every tracked SKU on that ASIN inherits the ASIN total. (Legacy shape;
//     if two tracked SKUs share the ASIN it will over-count — that's why the by-SKU report is
//     preferred.)
//   • by-SKU report   → each tracked SKU keeps its OWN units, PLUS a share of the ASIN's
//     "untracked" units — sales through SKUs the tool does NOT replenish to FBA (the FBM
//     `_MFN` sibling, or dead listings). That folds FBM/out-of-stock demand back onto the FBA
//     SKU (the tool's original intent) while never double-counting between two tracked SKUs.
//     The untracked pool is split across tracked SKUs in proportion to their own units (evenly
//     if all are zero), so the tracked total always equals the ASIN total.

export interface DemandRow {
  asin: string;              // upper-cased child ASIN
  sku: string | null;        // null on the by-ASIN report
  units: number;
}

export interface TrackedSku {
  sku: string;
  asin: string;              // the SKU's ASIN (any case)
}

export type DemandBySku = Record<string, { units: number; days: number }>;

const up = (s: string) => s.trim().toUpperCase();

export function attributeDemand(rows: DemandRow[], windowDays: number, tracked: TrackedSku[]): DemandBySku {
  const out: DemandBySku = {};
  const hasSku = rows.some(r => r.sku);

  // Tracked (FBA) SKUs grouped by ASIN.
  const trackedByAsin = new Map<string, string[]>();
  for (const t of tracked) {
    if (!t.asin) continue;
    const a = up(t.asin);
    (trackedByAsin.get(a) ?? trackedByAsin.set(a, []).get(a)!).push(t.sku);
  }

  if (!hasSku) {
    // Legacy by-ASIN: each tracked SKU on the ASIN inherits the ASIN total.
    const unitsByAsin = new Map<string, number>();
    for (const r of rows) unitsByAsin.set(up(r.asin), (unitsByAsin.get(up(r.asin)) ?? 0) + r.units);
    for (const [asin, skus] of trackedByAsin) {
      const u = unitsByAsin.get(asin);
      if (u === undefined) continue;
      for (const sku of skus) out[sku] = { units: u, days: windowDays };
    }
    return out;
  }

  // By-SKU: per-ASIN fold of untracked (FBM/dead) units onto the tracked FBA SKUs.
  const asinTotal = new Map<string, number>();
  const ownBySku = new Map<string, number>();
  for (const r of rows) {
    asinTotal.set(up(r.asin), (asinTotal.get(up(r.asin)) ?? 0) + r.units);
    if (r.sku) ownBySku.set(r.sku, (ownBySku.get(r.sku) ?? 0) + r.units);
  }

  for (const [asin, skus] of trackedByAsin) {
    const total = asinTotal.get(asin);
    if (total === undefined) continue;                 // ASIN not in the report → no demand
    const own = skus.map(sku => ownBySku.get(sku) ?? 0);
    const ownSum = own.reduce((a, b) => a + b, 0);
    const untracked = Math.max(0, total - ownSum);     // FBM `_MFN` + non-catalog SKUs
    skus.forEach((sku, i) => {
      const share = ownSum > 0 ? untracked * (own[i] / ownSum) : untracked / skus.length;
      out[sku] = { units: own[i] + share, days: windowDays };
    });
  }
  return out;
}
