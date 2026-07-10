// Pure netting of open warehouse→FBA transfers against the two source files.
// Extracted from the server so it can be unit-tested without a database.

export interface OpenTransfer {
  sku: string;
  qty: number;
  submitted_at: string;      // ISO
  baseline_fba: number | null; // available + inbound for the SKU at submit time
}

export interface WarehouseRow {
  onHand: number;
  updatedAt: string;         // ISO of the latest import/edit for THIS sku
}

export interface NetResult {
  /** Usable warehouse on-hand per SKU, netted of transfers this import hasn't reflected. */
  warehouseUsable: Record<string, number>;
  /** Units still genuinely in flight to FBA (not yet shown by Amazon), per SKU. */
  inTransit: Record<string, number>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * @param openTransfers  status='submitted' transfers
 * @param warehouse      per-SKU on-hand + that SKU's own updated_at
 * @param amazonFba      per-SKU (available + inbound) from the latest FBA snapshot
 */
export function netTransfers(
  openTransfers: OpenTransfer[],
  warehouse: Record<string, WarehouseRow>,
  amazonFba: Record<string, number>,
): NetResult {
  const bySku = new Map<string, OpenTransfer[]>();
  for (const t of openTransfers) {
    if (!bySku.has(t.sku)) bySku.set(t.sku, []);
    bySku.get(t.sku)!.push(t);
  }

  const warehouseUsable: Record<string, number> = {};
  const inTransit: Record<string, number> = {};

  // Seed usable warehouse with every imported row (SKUs with no transfers pass through).
  for (const [sku, row] of Object.entries(warehouse)) warehouseUsable[sku] = row.onHand;

  for (const [sku, transfers] of bySku) {
    const sumQty = transfers.reduce((s, t) => s + t.qty, 0);

    // How much Amazon has taken in since the OLDEST open transfer was submitted.
    // Using the earliest baseline attributes arrivals FIFO across overlapping transfers.
    const earliest = transfers.reduce((a, b) => (a.submitted_at <= b.submitted_at ? a : b));
    const baseline = earliest.baseline_fba ?? 0;
    const currentFba = amazonFba[sku] ?? 0;
    const landed = clamp(currentFba - baseline, 0, sumQty);
    inTransit[sku] = sumQty - landed;

    // Warehouse netting is PER-SKU: only subtract transfers submitted after THIS sku's own
    // last warehouse refresh (a global cutoff would un-net a SKU whenever any other SKU is
    // updated, or when this SKU is missing from an import — double-counting its units).
    const row = warehouse[sku];
    const skuCutoff = row?.updatedAt ?? '';
    const unreflected = transfers
      .filter(t => !skuCutoff || t.submitted_at > skuCutoff)
      .reduce((s, t) => s + t.qty, 0);
    warehouseUsable[sku] = Math.max(0, (row?.onHand ?? 0) - unreflected);
  }

  return { warehouseUsable, inTransit };
}
