import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBusinessReport } from '../business-report.ts';
import { attributeDemand } from '../attribute-demand.ts';

const buf = (s: string) => Buffer.from(s, 'utf8');

test('parseBusinessReport: by-ASIN report (no SKU column) sums per ASIN', () => {
  const csv = '(Child) ASIN,Title,Units Ordered\nB001,"Ring, Black, 10",674\nB001,"Ring dup",26\nB002,Blue,5\n';
  const p = parseBusinessReport(buf(csv));
  assert.equal(p.headerFound, true);
  assert.equal(p.hasSku, false);
  assert.equal(p.rows.length, 2);
  const b001 = p.rows.find(r => r.asin === 'B001')!;
  assert.equal(b001.units, 700);       // 674 + 26 coalesced
  assert.equal(b001.sku, null);
});

test('parseBusinessReport: by-SKU report keeps one row per SKU with its ASIN', () => {
  const csv = '(Parent) ASIN,(Child) ASIN,Title,SKU,Units Ordered\nP,B0B7GMXW63,"Ring, X",FAM06,30\nP,B0B7GMXW63,"Ring, X",FAM06_MFN,10\nP,B072BR3BBN,"Ring, Y",MHD11,122\n';
  const p = parseBusinessReport(buf(csv));
  assert.equal(p.hasSku, true);
  assert.equal(p.rows.length, 3);
  const fam = p.rows.find(r => r.sku === 'FAM06')!;
  assert.equal(fam.units, 30);
  assert.equal(fam.asin, 'B0B7GMXW63');
});

test('attributeDemand: by-ASIN → tracked SKU inherits the ASIN total', () => {
  const d = attributeDemand([{ asin: 'B001', sku: null, units: 700 }], 30, [{ sku: 'AAA', asin: 'B001' }]);
  assert.deepEqual(d['AAA'], { units: 700, days: 30 });
});

test('attributeDemand: FBA SKU + FBM sibling → FBA SKU gets total product demand (fold)', () => {
  // FAM06 (tracked FBA) 30 + FAM06_MFN (untracked FBM) 10  →  FAM06 sized for 40.
  const rows = [
    { asin: 'B0B7GMXW63', sku: 'FAM06', units: 30 },
    { asin: 'B0B7GMXW63', sku: 'FAM06_MFN', units: 10 },
  ];
  const d = attributeDemand(rows, 30, [{ sku: 'FAM06', asin: 'B0B7GMXW63' }]);
  assert.equal(d['FAM06'].units, 40);
  assert.equal(d['FAM06_MFN'], undefined); // FBM sibling is not a tracked FBA SKU → never planned
});

test('attributeDemand: two tracked FBA SKUs on one ASIN keep their own units (no double-count)', () => {
  const rows = [
    { asin: 'B072BR3BBN', sku: 'MHD11', units: 122 },
    { asin: 'B072BR3BBN', sku: 'MHD11.s', units: 59 },
  ];
  const d = attributeDemand(rows, 30, [
    { sku: 'MHD11', asin: 'B072BR3BBN' }, { sku: 'MHD11.s', asin: 'B072BR3BBN' },
  ]);
  assert.equal(d['MHD11'].units, 122);
  assert.equal(d['MHD11.s'].units, 59);   // NOT 181 each
});

test('attributeDemand: untracked pool splits proportionally across tracked SKUs', () => {
  // ASIN total 100; tracked A=60, B=20 (sum 80); untracked 20 → A += 15, B += 5.
  const rows = [
    { asin: 'X', sku: 'A', units: 60 },
    { asin: 'X', sku: 'B', units: 20 },
    { asin: 'X', sku: 'X_MFN', units: 20 },
  ];
  const d = attributeDemand(rows, 30, [{ sku: 'A', asin: 'X' }, { sku: 'B', asin: 'X' }]);
  assert.equal(d['A'].units, 75);
  assert.equal(d['B'].units, 25);
});

test('attributeDemand: ASIN with only FBM (no tracked FBA SKU) yields nothing to plan', () => {
  const d = attributeDemand([{ asin: 'Z', sku: 'Z_MFN', units: 12 }], 30, []);
  assert.deepEqual(d, {});
});
