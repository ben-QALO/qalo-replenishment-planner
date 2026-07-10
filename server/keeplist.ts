// "Keep in stock" catalog scoping: the team's real list of products (ASINs or SKUs).
// Everything on the list is replenishable; everything else is noise (ignored).
import type Database from 'better-sqlite3';
import { nowIso } from './db/connection.ts';

const ASIN_RE = /^B0[0-9A-Z]{8}$/i;

export function classifyToken(v: string): 'asin' | 'sku' {
  return ASIN_RE.test(v.trim()) ? 'asin' : 'sku';
}

export interface KeepListApplyResult {
  kept_skus: number;
  ignored_skus: number;
  preserved_skus: number; // manual watch/discontinued left untouched
  values_total: number;
  asins: number;
  skus: number;
  not_found: string[];   // list entries that matched no catalog SKU
}

/** Parse pasted/uploaded text into distinct tokens (one per line or comma/tab/space separated). */
export function parseTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

/**
 * Replace the keep list with `tokens` and re-scope the catalog:
 *   on the list  → replenishable
 *   known, not on the list → ignore
 * Returns a report so nothing fails silently.
 */
export function applyKeepList(db: Database.Database, tokens: string[]): KeepListApplyResult {
  const now = nowIso();
  const asins = new Set<string>();
  const skus = new Set<string>();
  for (const t of tokens) (classifyToken(t) === 'asin' ? asins : skus).add(t.toUpperCase());

  const catalog = db.prepare('SELECT sku, asin, classification FROM skus').all() as { sku: string; asin: string | null; classification: string }[];
  const isKept = (row: { sku: string; asin: string | null }) =>
    skus.has(row.sku.toUpperCase()) || (row.asin ? asins.has(row.asin.toUpperCase()) : false);

  const matchedAsins = new Set<string>();
  const matchedSkus = new Set<string>();

  const run = db.transaction((): KeepListApplyResult => {
    db.prepare('DELETE FROM keep_list').run();
    const ins = db.prepare('INSERT OR IGNORE INTO keep_list (kind, value, created_at) VALUES (?, ?, ?)');
    for (const a of asins) ins.run('asin', a, now);
    for (const s of skus) ins.run('sku', s, now);

    const setClass = db.prepare('UPDATE skus SET classification = ?, updated_at = ? WHERE sku = ?');
    let kept = 0, ignored = 0, preserved = 0;
    for (const row of catalog) {
      if (isKept(row)) {
        // Don't stomp deliberate human states; only (re)assert replenishable on the
        // auto-managed ones. A kept SKU the operator set to watch/discontinued stays put.
        if (row.classification === 'watch' || row.classification === 'discontinued') preserved++;
        else setClass.run('replenishable', now, row.sku);
        kept++;
        if (row.asin && asins.has(row.asin.toUpperCase())) matchedAsins.add(row.asin.toUpperCase());
        if (skus.has(row.sku.toUpperCase())) matchedSkus.add(row.sku.toUpperCase());
      } else if (row.classification === 'watch' || row.classification === 'discontinued') {
        // Preserve manual watch/discontinued for non-kept SKUs too — never silently ignore them.
        preserved++;
      } else {
        setClass.run('ignore', now, row.sku);
        ignored++;
      }
    }
    const notFound = [
      ...[...asins].filter(a => !matchedAsins.has(a)),
      ...[...skus].filter(s => !matchedSkus.has(s)),
    ];
    return {
      kept_skus: kept, ignored_skus: ignored, preserved_skus: preserved,
      values_total: tokens.length, asins: asins.size, skus: skus.size,
      not_found: notFound,
    };
  });
  const result = run();
  db.prepare('UPDATE state_revision SET rev = rev + 1 WHERE id = 1').run();
  return result;
}

/** On a new FBA import, auto-classify freshly-seen SKUs against the saved keep list. */
export function autoClassifyNewSkus(db: Database.Database, newSkus: string[]): void {
  if (newSkus.length === 0) return;
  const keep = db.prepare('SELECT kind, value FROM keep_list').all() as { kind: string; value: string }[];
  if (keep.length === 0) return;
  const asins = new Set(keep.filter(k => k.kind === 'asin').map(k => k.value.toUpperCase()));
  const skus = new Set(keep.filter(k => k.kind === 'sku').map(k => k.value.toUpperCase()));
  const now = nowIso();
  const setClass = db.prepare("UPDATE skus SET classification = 'replenishable', updated_at = ? WHERE sku = ?");
  const getRow = db.prepare('SELECT sku, asin FROM skus WHERE sku = ?');
  for (const sku of newSkus) {
    const row = getRow.get(sku) as { sku: string; asin: string | null } | undefined;
    if (!row) continue;
    const kept = skus.has(row.sku.toUpperCase()) || (row.asin ? asins.has(row.asin.toUpperCase()) : false);
    // Kept new arrivals become replenishable; non-kept new arrivals stay unclassified
    // (surfaced for triage) rather than silently ignored.
    if (kept) setClass.run(now, sku);
  }
}
