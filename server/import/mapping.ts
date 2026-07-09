// Header recognition: normalize Amazon's column names and auto-map them to our fields.
import { createHash } from 'node:crypto';

export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/^﻿/, '').trim().replace(/[\s_]+/g, '-');
}

/** Our target fields → accepted (normalized) Amazon header synonyms, in preference order. */
export const FBA_DICTIONARY: Record<string, string[]> = {
  sku: ['sku', 'merchant-sku', 'seller-sku', 'msku'],
  fnsku: ['fnsku'],
  asin: ['asin', 'asin1'],
  title: ['product-name', 'title', 'item-name'],
  condition: ['condition'],
  snapshot_date: ['snapshot-date'],
  available: ['available', 'afn-fulfillable-quantity', 'fulfillable-quantity'],
  inbound_working: ['inbound-working', 'afn-inbound-working-quantity'],
  inbound_shipped: ['inbound-shipped', 'afn-inbound-shipped-quantity'],
  inbound_received: ['inbound-received', 'inbound-receiving', 'afn-inbound-receiving-quantity'],
  inbound_total: ['inbound-quantity'],
  reserved: ['total-reserved-quantity', 'afn-reserved-quantity', 'reserved-quantity', 'reserved'],
  unfulfillable: ['unfulfillable-quantity', 'afn-unsellable-quantity', 'unsellable-quantity'],
  units_shipped_t7: ['units-shipped-t7', 'units-shipped-last-7-days'],
  units_shipped_t30: ['units-shipped-t30', 'units-shipped-last-30-days'],
  units_shipped_t60: ['units-shipped-t60', 'units-shipped-last-60-days'],
  units_shipped_t90: ['units-shipped-t90', 'units-shipped-last-90-days'],
  amazon_days_of_supply: ['days-of-supply', 'total-days-of-supply'],
  amazon_min_inventory_level: ['fba-minimum-inventory-level'],
  your_price: ['your-price', 'price'],
};

export const REQUIRED_FIELDS = ['sku', 'available'];

export interface HeaderMapping {
  /** target field → actual header name in the file */
  fields: Record<string, string>;
  missingRequired: string[];
  unmappedHeaders: string[];
  signature: string;
}

export function headerSignature(headers: string[]): string {
  const normalized = headers.map(normalizeHeader).sort().join('|');
  return createHash('sha1').update(normalized).digest('hex');
}

export function autoMapHeaders(headers: string[]): HeaderMapping {
  const byNormalized = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (!byNormalized.has(n)) byNormalized.set(n, h);
  }
  const fields: Record<string, string> = {};
  for (const [field, synonyms] of Object.entries(FBA_DICTIONARY)) {
    for (const syn of synonyms) {
      const actual = byNormalized.get(syn);
      if (actual !== undefined) { fields[field] = actual; break; }
    }
  }
  const mappedActuals = new Set(Object.values(fields));
  return {
    fields,
    missingRequired: REQUIRED_FIELDS.filter(f => !(f in fields)),
    unmappedHeaders: headers.filter(h => !mappedActuals.has(h)),
    signature: headerSignature(headers),
  };
}
