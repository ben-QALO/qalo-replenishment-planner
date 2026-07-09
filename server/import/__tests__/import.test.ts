import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, sniffDelimiter, parseDelimited, decodeBuffer } from '../parse.ts';
import { autoMapHeaders, normalizeHeader } from '../mapping.ts';
import { normalizeFbaRecords, sanityWarnings } from '../fba.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FILE = join(HERE, '..', '..', '..', 'data', 'imports', 'FBA Inventory Export.csv');

test('delimiter sniffing: tab beats comma when tabs dominate the header', () => {
  assert.equal(sniffDelimiter('sku\tfnsku\tproduct-name, deluxe\n'), '\t');
  assert.equal(sniffDelimiter('"sku","fnsku","product-name"\n'), ',');
});

test('RFC-4180: quoted fields with embedded commas, quotes and newlines', () => {
  const rows = parseDelimited('a,"b,1","say ""hi""","line\nbreak"\n1,2,3,4\n', ',');
  assert.deepEqual(rows[0], ['a', 'b,1', 'say "hi"', 'line\nbreak']);
  assert.deepEqual(rows[1], ['1', '2', '3', '4']);
});

test('BOM is stripped from UTF-8 files', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('sku,available\nA,5\n')]);
  const parsed = parseFile(buf);
  assert.deepEqual(parsed.headers, ['sku', 'available']);
  assert.equal(parsed.records[0].sku, 'A');
});

test('UTF-16LE files decode correctly', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sku\tavailable\nA\t5\n', 'utf16le')]);
  const text = decodeBuffer(buf);
  assert.ok(text.includes('sku\tavailable'));
});

test('header auto-mapping handles the planning report and MYI-style synonyms', () => {
  const planning = autoMapHeaders(['snapshot-date', 'sku', 'available', 'units-shipped-t30', 'Total Reserved Quantity', 'unfulfillable-quantity']);
  assert.equal(planning.fields.reserved, 'Total Reserved Quantity');
  assert.equal(planning.missingRequired.length, 0);

  const myi = autoMapHeaders(['sku', 'afn-fulfillable-quantity', 'afn-reserved-quantity', 'afn-inbound-shipped-quantity']);
  assert.equal(myi.fields.available, 'afn-fulfillable-quantity');
  assert.equal(myi.fields.reserved, 'afn-reserved-quantity');
  assert.equal(myi.missingRequired.length, 0);

  const junk = autoMapHeaders(['foo', 'bar']);
  assert.deepEqual(junk.missingRequired, ['sku', 'available']);
});

test('normalizeHeader: case, spaces, underscores', () => {
  assert.equal(normalizeHeader('Total Reserved Quantity'), 'total-reserved-quantity');
  assert.equal(normalizeHeader('units_shipped_t30'), 'units-shipped-t30');
});

test('normalization: blank velocity stays null (unknown), blank quantity becomes 0 flagged', () => {
  const mapping = autoMapHeaders(['sku', 'available', 'units-shipped-t30']);
  const { lines } = normalizeFbaRecords([
    { sku: 'A', available: '10', 'units-shipped-t30': '' },
    { sku: 'B', available: '', 'units-shipped-t30': '7' },
  ], mapping);
  const a = lines.find(l => l.sku === 'A')!;
  const b = lines.find(l => l.sku === 'B')!;
  assert.equal(a.units_shipped_t30, null);
  assert.equal(b.available, 0);
  assert.ok(b.flags.includes('BLANK_QTY_ZEROED'));
});

test('normalization: negative quantities are clamped and flagged; blank SKUs skipped', () => {
  const mapping = autoMapHeaders(['sku', 'available']);
  const { lines, rowsSkipped } = normalizeFbaRecords([
    { sku: 'A', available: '-5' },
    { sku: '', available: '10' },
  ], mapping);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].available, 0);
  assert.ok(lines[0].flags.includes('NEGATIVE_QTY_ZEROED'));
  assert.equal(rowsSkipped.length, 1);
});

test('duplicate SKU rows merge with summed quantities and a flag', () => {
  const mapping = autoMapHeaders(['sku', 'available', 'units-shipped-t30']);
  const { lines } = normalizeFbaRecords([
    { sku: 'A', available: '10', 'units-shipped-t30': '5' },
    { sku: 'A', available: '7', 'units-shipped-t30': '2' },
  ], mapping);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].available, 17);
  assert.equal(lines[0].units_shipped_t30, 7);
  assert.ok(lines[0].flags.includes('DUPLICATE_ROW_MERGED'));
});

test('snapshot date is read from the file when present', () => {
  const mapping = autoMapHeaders(['snapshot-date', 'sku', 'available']);
  const { snapshotDate } = normalizeFbaRecords([
    { 'snapshot-date': '2026-07-09', sku: 'A', available: '1' },
  ], mapping);
  assert.equal(snapshotDate, '2026-07-09');
});

test('sanity warnings: big drops and missing SKUs vs previous snapshot', () => {
  const mapping = autoMapHeaders(['sku', 'available']);
  const { lines } = normalizeFbaRecords([{ sku: 'A', available: '2' }], mapping);
  const w = sanityWarnings(lines, [{ sku: 'A', available: 100 }, { sku: 'GONE', available: 50 }]);
  assert.equal(w.length, 2);
  assert.ok(w[0].includes('80%'));
  assert.ok(w[1].includes('absent'));
});

test('REAL FILE: parses all 624 SKUs with correct values (spot-checked against the CSV)', { skip: !existsSync(REAL_FILE) }, () => {
  const parsed = parseFile(readFileSync(REAL_FILE));
  const mapping = autoMapHeaders(parsed.headers);
  assert.equal(mapping.missingRequired.length, 0, 'required fields must auto-map');

  const result = normalizeFbaRecords(parsed.records, mapping);
  assert.equal(result.lines.length, 624);
  assert.equal(result.rowsSkipped.length, 0);
  assert.equal(result.snapshotDate, '2026-07-09');

  // Spot-check MXG09 against values verified by hand in the raw file.
  const mxg = result.lines.find(l => l.sku === 'MXG09')!;
  assert.equal(mxg.available, 112);
  assert.equal(mxg.units_shipped_t30, 69);
  assert.equal(mxg.units_shipped_t90, 154);
  assert.equal(mxg.reserved, 3);

  // MSB12 has inbound quantity 49 spread across components.
  const msb = result.lines.find(l => l.sku === 'MSB12')!;
  assert.equal(msb.inbound_working + msb.inbound_shipped + msb.inbound_received, 49);

  // 46 SKUs have blank velocity columns → null, never zero.
  const unknownVelocity = result.lines.filter(l => l.units_shipped_t30 === null);
  assert.equal(unknownVelocity.length, 46);

  // 75 SKUs out of stock.
  assert.equal(result.lines.filter(l => l.available === 0).length, 75);
});
