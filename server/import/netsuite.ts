// Parser for the NetSuite "Qalo Amazon Inventory Report" (Excel 2003 SpreadsheetML).
// Keyed on the Item column (= Amazon merchant SKU); reads the "Qalo Main WH" column.

const SS = 'urn:schemas-microsoft-com:office:spreadsheet';

export interface WarehouseRow {
  sku: string;
  onHand: number;
  displayName: string | null;
  asin: string | null;
}

export interface NetsuiteParseResult {
  rows: WarehouseRow[];
  headerRowFound: boolean;
  qtyColumnLabel: string | null;
}

/**
 * Minimal SpreadsheetML reader — walks Worksheet→Row→Cell, honoring ss:Index gaps.
 * We avoid a full XML lib; the format is regular enough to scan for cells.
 */
function readRows(xml: string): string[][] {
  const rows: string[][] = [];
  // Split into <Row>…</Row> blocks.
  const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/g;
  const cellRe = /<Cell\b([^>]*)>([\s\S]*?)<\/Cell>|<Cell\b([^>]*)\/>/g;
  const dataRe = /<Data\b[^>]*>([\s\S]*?)<\/Data>/;
  const idxRe = /ss:Index="(\d+)"/;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    let col = 0;
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    const inner = rowMatch[1];
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const idxM = attrs.match(idxRe);
      if (idxM) col = parseInt(idxM[1], 10) - 1; // ss:Index is 1-based, jumps over empty cells
      const body = cellMatch[2] ?? '';
      const dataM = body.match(dataRe);
      const text = dataM ? decodeEntities(dataM[1]) : '';
      cells[col] = text;
      col++;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ')
    .trim();
}

function num(v: string): number {
  const n = Number((v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function parseNetsuiteWarehouse(buf: Buffer): NetsuiteParseResult {
  const xml = buf.toString('utf8');
  const rows = readRows(xml);

  // Find the header row: contains "Item" and a warehouse column.
  let headerIdx = -1;
  let itemCol = 0, qtyCol = -1, nameCol = -1, asinCol = -1;
  let qtyLabel: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => c.toLowerCase());
    const iIdx = r.findIndex(c => c === 'item');
    if (iIdx === -1) continue;
    // Prefer "qalo main wh"; fall back to "total".
    let qIdx = r.findIndex(c => c.includes('qalo') && c.includes('wh'));
    if (qIdx === -1) qIdx = r.findIndex(c => c === 'total');
    if (qIdx === -1) continue;
    headerIdx = i;
    itemCol = iIdx;
    qtyCol = qIdx;
    qtyLabel = rows[i][qIdx];
    nameCol = r.findIndex(c => c.includes('display name') || c.includes('name'));
    asinCol = r.findIndex(c => c.includes('asin'));
    break;
  }
  if (headerIdx === -1) return { rows: [], headerRowFound: false, qtyColumnLabel: null };

  const bySku = new Map<string, WarehouseRow>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const sku = (r[itemCol] ?? '').trim();
    if (!sku) continue;
    // Skip NetSuite section header rows (e.g. "Assembly") — they have an item-like
    // first cell but no numeric qty columns populated.
    const qtyRaw = (r[qtyCol] ?? '').trim();
    const onHand = Math.max(0, Math.round(num(qtyRaw)));
    const row: WarehouseRow = {
      sku,
      onHand,
      displayName: nameCol >= 0 ? (r[nameCol] ?? '').trim() || null : null,
      asin: asinCol >= 0 ? (r[asinCol] ?? '').trim() || null : null,
    };
    // Duplicate item rows: keep the max on-hand (defensive; NetSuite items are unique).
    const existing = bySku.get(sku);
    if (!existing || row.onHand > existing.onHand) bySku.set(sku, row);
  }
  return { rows: [...bySku.values()], headerRowFound: true, qtyColumnLabel: qtyLabel };
}
