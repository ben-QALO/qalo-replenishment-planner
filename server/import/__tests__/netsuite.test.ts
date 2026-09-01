import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseNetsuiteWarehouse } from '../netsuite.ts';

// NetSuite's export changed from Excel 2003 SpreadsheetML to a real .xlsx, and the reader only
// understood the old one — so a correct report failed to import with a message asking whether it was
// the right report. Both formats are covered here, laid out the way NetSuite actually emits them:
// company/title banner rows, a blank spacer, an "Options:" line, the real headers on row 7, a units
// row beneath them, and a bare section row ("Assembly") among the data.

const HEADERS = ['Item', 'Inventory Item: Display Name', 'Amazon Product ASIN', 'Qalo Main WH', 'Total'];
const DATA: [string, string, string, string, string][] = [
  ['005Q', 'MiHIGH Infrared Sauna Blanket', 'B09B3GL1Q6', '1', '1'],
  ['R-RNGSZ-03', 'QALO Ring Sizing Kit', '', '4,950', '4,950'],   // thousands separator, as exported
  ['USR-MS-11', 'QALO Smart Ring Size 11', '', '967', '967'],
  ['ZERO-STOCK', 'Discontinued thing', '', '0', '0'],
  ['NO-QTY', 'Never stocked', '', '', ''],
];

/** A real .xlsx shaped like the NetSuite report. */
async function xlsxFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Qalo Amazon Inventory Report');
  ws.addRow(['Brand Value Growth LLC']);
  ws.addRow(['Brand Value Growth LLC']);
  ws.addRow(['Qalo Amazon Inventory ']);
  ws.addRow([]);
  ws.addRow([]);
  ws.addRow(['Options: Show Zeros']);
  ws.addRow(HEADERS);
  ws.addRow(['', 'Inventory Item: Display Name', 'Amazon Product ASIN', 'Current Quantity Available', 'Current Quantity Available']);
  ws.addRow(['Assembly']);                       // section row: item-like, no quantities
  for (const d of DATA) ws.addRow(d);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The same report as Excel 2003 SpreadsheetML, the format that used to arrive. */
function spreadsheetmlFixture(): Buffer {
  const row = (cells: string[]) =>
    `<Row>${cells.map(c => `<Cell><Data ss:Type="String">${c.replace(/&/g, '&amp;')}</Data></Cell>`).join('')}</Row>`;
  const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Qalo Amazon Inventory Report"><Table>
${row(['Brand Value Growth LLC'])}
${row(['Qalo Amazon Inventory '])}
${row(['Options: Show Zeros'])}
${row(HEADERS)}
${row(['Assembly'])}
${DATA.map(d => row([...d])).join('\n')}
</Table></Worksheet></Workbook>`;
  return Buffer.from(xml, 'utf8');
}

test('reads the real .xlsx NetSuite now exports', async () => {
  const p = await parseNetsuiteWarehouse(await xlsxFixture());
  assert.equal(p.format, 'xlsx');
  assert.equal(p.headerRowFound, true, 'the header row must be found past the banner rows');
  assert.equal(p.qtyColumnLabel, 'Qalo Main WH', 'must read the warehouse column, not Total');
  const bySku = new Map(p.rows.map(r => [r.sku, r]));
  assert.equal(bySku.get('R-RNGSZ-03')!.onHand, 4950, 'thousands separators must parse');
  assert.equal(bySku.get('USR-MS-11')!.onHand, 967);
  assert.equal(bySku.get('ZERO-STOCK')!.onHand, 0);
  assert.equal(bySku.get('NO-QTY')!.onHand, 0, 'a blank quantity reads as zero, not NaN');
  assert.equal(bySku.get('005Q')!.asin, 'B09B3GL1Q6');
  assert.equal(bySku.get('R-RNGSZ-03')!.displayName, 'QALO Ring Sizing Kit');
  // "Assembly" is a section heading, not a SKU with stock — it must not become a warehouse row.
  assert.equal(bySku.get('Assembly')?.onHand ?? 0, 0);
});

test('still reads the old Excel 2003 SpreadsheetML export', async () => {
  const p = await parseNetsuiteWarehouse(spreadsheetmlFixture());
  assert.equal(p.format, 'spreadsheetml');
  assert.equal(p.headerRowFound, true);
  assert.equal(p.qtyColumnLabel, 'Qalo Main WH');
  const bySku = new Map(p.rows.map(r => [r.sku, r]));
  assert.equal(bySku.get('R-RNGSZ-03')!.onHand, 4950);
  assert.equal(bySku.get('USR-MS-11')!.onHand, 967);
});

test('both formats produce identical warehouse figures', async () => {
  const a = await parseNetsuiteWarehouse(await xlsxFixture());
  const b = await parseNetsuiteWarehouse(spreadsheetmlFixture());
  const norm = (p: Awaited<ReturnType<typeof parseNetsuiteWarehouse>>) =>
    p.rows.map(r => `${r.sku}=${r.onHand}`).sort().join(',');
  assert.equal(norm(a), norm(b), 'the format must not change the numbers');
});

test('a genuinely wrong file reports the columns it did find, not a vague question', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Merchant SKU', 'FNSKU', 'Units Available']);   // the FBA export, not NetSuite
  ws.addRow(['MFL10', 'X00ABC', '42']);
  const p = await parseNetsuiteWarehouse(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(p.headerRowFound, false);
  assert.equal(p.format, 'xlsx');
  assert.deepEqual(p.headersSeen, ['Merchant SKU', 'FNSKU', 'Units Available'],
    'the error must be able to name what was actually in the file');
});
