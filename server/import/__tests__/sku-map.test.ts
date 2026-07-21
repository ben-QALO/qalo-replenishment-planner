import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkuMap } from '../sku-map.ts';

const buf = (s: string) => Buffer.from(s, 'utf8');

test('parseSkuMap reads Amazon SKU / Child ASIN / QALO SKU and skips blank QALO rows', () => {
  const csv = 'Amazon SKU,Child ASIN,QALO SKU\nMHD09.s,B0725K4D9B,MHD09\nMFL10,B07PLPPSJ4,MFL10\n,,\n';
  const p = parseSkuMap(buf(csv));
  assert.equal(p.headerFound, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.skipped, 1);
  const mhd = p.rows.find(r => r.qalo_sku === 'MHD09')!;
  assert.equal(mhd.amazon_sku, 'MHD09.s');       // Amazon listing SKU differs from the QALO SKU
  assert.equal(mhd.asin, 'B0725K4D9B');
});

test('parseSkuMap fails cleanly when the required columns are absent', () => {
  const p = parseSkuMap(buf('Foo,Bar\n1,2\n'));
  assert.equal(p.headerFound, false);
  assert.equal(p.rows.length, 0);
});
