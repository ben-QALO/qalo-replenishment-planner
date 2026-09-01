// Parser for the NetSuite "Qalo Amazon Inventory Report".
// Keyed on the Item column (= Amazon merchant SKU); reads the "Qalo Main WH" column.
//
// TWO file formats, because NetSuite's export changed under us: the original Excel 2003
// SpreadsheetML (plain XML) and a real .xlsx (a ZIP). The old reader did `buf.toString('utf8')` and
// regex-scanned for <Row> tags, so a genuine .xlsx arrived as binary noise, matched nothing, and the
// upload failed with "is this the Qalo Amazon Inventory Report?" — on a file that WAS exactly that.
// Both formats are now detected by magic bytes and flattened to the same rows-of-strings, so the
// column-finding below is shared and cannot drift between them.

import ExcelJS from 'exceljs';

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
  /** Which format the file turned out to be — surfaced so an error can name it. */
  format: 'xlsx' | 'spreadsheetml';
  /** The most header-like row we saw, for a useful message when the columns aren't found. */
  headersSeen: string[];
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

/** A real .xlsx is a ZIP, so it starts with "PK". SpreadsheetML is plain XML text. */
function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
}

/** One cell of a real .xlsx as plain text — formulas, rich text and dates all flattened. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as Record<string, any>;
  if (o.result !== undefined) return cellText(o.result);          // formula cell
  if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text ?? '').join('').trim();
  if (o.text !== undefined) return cellText(o.text);              // hyperlink cell
  return '';
}

async function readXlsxRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(ws.getCell(r, c).value));
    rows.push(cells);
  }
  return rows;
}

export async function parseNetsuiteWarehouse(buf: Buffer): Promise<NetsuiteParseResult> {
  const format = looksLikeXlsx(buf) ? 'xlsx' as const : 'spreadsheetml' as const;
  const rows = format === 'xlsx' ? await readXlsxRows(buf) : readRows(buf.toString('utf8'));

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
  if (headerIdx === -1) {
    // Hand back the widest non-empty row as a best guess at "what we did see", so the upload error
    // can name the actual column headings instead of only saying they were missing.
    const headersSeen = rows.reduce<string[]>((best, r) => {
      const filled = r.filter(c => c.trim()).length;
      return filled > best.filter(c => c.trim()).length ? r : best;
    }, []).filter(c => c.trim()).slice(0, 8);
    return { rows: [], headerRowFound: false, qtyColumnLabel: null, format, headersSeen };
  }

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
  return {
    rows: [...bySku.values()], headerRowFound: true, qtyColumnLabel: qtyLabel,
    format, headersSeen: rows[headerIdx].filter(c => c.trim()),
  };
}
