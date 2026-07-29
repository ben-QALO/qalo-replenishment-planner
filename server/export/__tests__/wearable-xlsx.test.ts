import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildWearablePlans, projectWearableSku, type WearableSkuInput } from '../../../engine/wearable.ts';
import { buildWearableWorkbook, type WearableExportSku } from '../wearable-xlsx.ts';
import { addMonths, firstOfMonth, diffDays } from '../../../engine/dates.ts';
import type { TemplateParams } from '../../../engine/types.ts';

// The real smart-ring supply chain: 90-day China lead, 35-day transfer leg, 60-day FBA goal, monthly POs.
const WEARABLE: TemplateParams = {
  production_days: 60, transit_days: 25, customs_receiving_days: 5,
  fba_ship_checkin_days: 35, safety_days: 14,
  fba_target_cover_days: 60, warehouse_buffer_days: 0, target_cover_days: 200,
  review_period_fba_days: 14, review_period_po_days: 30,
};
const TODAY = '2026-07-29';
const FORECAST = { year: 2026, monthlyUnits: [800, 800, 900, 900, 1000, 1000, 1100, 1100, 1200, 1400, 2200, 1800] };

// Production shape: a smart ring is one MODEL in many ring SIZES, and the factory PO is written per
// size. Two models × three sizes plus the sizing kit — deliberately fed in a jumbled order, and with
// the middle size the best seller, so the test proves the export regroups and re-sorts rather than
// happening to inherit a tidy input.
const MODELS = ['USRSL-GD', 'USR-MS'];
const SIZES = ['06', '09', '13'];
const VELOCITY: Record<string, number> = {
  'USRSL-GD-06': 3, 'USRSL-GD-09': 12, 'USRSL-GD-13': 2,
  'USR-MS-06': 2.5, 'USR-MS-09': 9, 'USR-MS-13': 1.5,
};

/** The export as the route builds it: engine reports + a 12-month projection per SKU. */
function fixture(): { skus: WearableExportSku[]; rollup: any } {
  const ringSkus = Object.keys(VELOCITY);
  const inputs: WearableSkuInput[] = [
    // Jumbled on purpose — not model-then-size order.
    ...['USR-MS-09', 'USRSL-GD-13', 'USRSL-GD-09', 'USR-MS-06', 'USRSL-GD-06', 'USR-MS-13'].map(sku => ({
      sku, role: 'smart_ring' as const, velocity: VELOCITY[sku],
      fba_available: Math.round(VELOCITY[sku] * 60), fba_coming: 0,
      template: WEARABLE, case_pack: 1, moq: 1,
    })),
    { sku: 'R-RNGSZ-03', role: 'sizing_kit', velocity: 8, fba_available: 400, fba_coming: 0, template: WEARABLE, case_pack: 50, moq: 50 },
  ];
  const { reports, rollup } = buildWearablePlans(inputs, FORECAST, TODAY);
  const horizon = Math.max(0, diffDays(addMonths(firstOfMonth(TODAY), 12), TODAY));
  const titleOf = (sku: string) => sku === 'R-RNGSZ-03'
    ? 'QALO Official Ring Sizing Kit for Smart Ring'
    : `QALO ${sku.startsWith('USRSL') ? 'Slim ' : ''}Smart Ring – Titanium Fitness Tracker (Gold, Size ${sku.slice(-2)})`;
  const skus = inputs.map(i => ({
    sku: i.sku, label: i.sku, title: titleOf(i.sku), role: i.role,
    report: reports[i.sku], plan: projectWearableSku(inputs, FORECAST, TODAY, i.sku, horizon)!,
    fba_available: i.fba_available, fba_coming: i.fba_coming, case_pack: i.case_pack ?? null, template: WEARABLE,
  }));
  assert.equal(skus.length, ringSkus.length + 1);
  return { skus, rollup };
}

async function build(): Promise<ExcelJS.Workbook> {
  const { skus, rollup } = fixture();
  const buf = await buildWearableWorkbook({
    skus, rollup, today: TODAY, snapshotDate: '2026-07-28', forecastYear: 2026,
  });
  // Round-trip through the real file bytes: a workbook that can't be reopened is worthless, and
  // reading it back is the only way to know the styling didn't produce a corrupt sheet.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

const num = (ws: ExcelJS.Worksheet, row: number, col: number): number => {
  const v = ws.getCell(row, col).value;
  return typeof v === 'number' ? v : 0;
};
/** Find a row by its first-column label. */
function rowOf(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 1; r <= ws.rowCount; r++) if (String(ws.getCell(r, 1).value ?? '') === label) return r;
  throw new Error(`no row labelled "${label}" in ${ws.name}`);
}
/** The Product-column labels of a grid, in sheet order, from the header down to the grand total. */
function rowLabels(ws: ExcelJS.Worksheet, headerLabel: string): string[] {
  const head = rowOf(ws, headerLabel);
  const out: string[] = [];
  for (let r = head + 1; r <= ws.rowCount; r++) {
    const v = String(ws.getCell(r, 1).value ?? '');
    if (!v) break;
    out.push(v);
    if (v === 'ALL SKUs') break;
  }
  return out;
}

test('workbook: one tab per model, not one per size', async () => {
  const wb = await build();
  assert.deepEqual(wb.worksheets.map(w => w.name), [
    'Read me first', 'Allocate now', 'China orders 12 mo', 'Monthly demand 12 mo', 'FBA transfers 2-weekly',
    // Biggest model first, sizing kit last. Six ring SKUs collapse to two model tabs.
    'USRSL-GD by size', 'USR-MS by size', 'R-RNGSZ-03 detail',
  ]);
});

test('grids: grouped by model, sizes ascending, with a subtotal per model', async () => {
  const wb = await build();
  for (const [sheet, header] of [
    ['China orders 12 mo', 'Place in month →'],
    ['Monthly demand 12 mo', 'Product'],
    ['FBA transfers 2-weekly', 'Ships on →'],
    ['Allocate now', 'Product'],
  ] as const) {
    const ws = wb.getWorksheet(sheet)!;
    assert.deepEqual(rowLabels(ws, header), [
      'USRSL-GD-06', 'USRSL-GD-09', 'USRSL-GD-13', 'USRSL-GD',
      'USR-MS-06', 'USR-MS-09', 'USR-MS-13', 'USR-MS',
      'R-RNGSZ-03',           // one-SKU group: no redundant subtotal of itself
      'ALL SKUs',
    ], `row order on ${sheet}`);
    // The size column exists and carries the ring size as text, so '06' keeps its leading zero.
    assert.equal(String(ws.getCell(rowOf(ws, 'USRSL-GD-06'), 2).value), '06');
    assert.equal(String(ws.getCell(rowOf(ws, 'USRSL-GD'), 2).value), '3 sizes');
  }
});

test('china orders: per size, and every subtotal equals the sizes above it', async () => {
  const { skus } = fixture();
  const wb = await build();
  const ws = wb.getWorksheet('China orders 12 mo')!;
  const head = rowOf(ws, 'Place in month →');
  assert.equal(String(ws.getCell(head, 3).value), 'Jul 2026');
  assert.equal(String(ws.getCell(head, 14).value), 'Jun 2027');
  assert.equal(String(ws.getCell(head, 15).value), '12-month total');

  const orderOf = (label: string) => skus.find(s => s.label === label)!.report.months.map(m => m.recommended_order);
  for (const s of skus) {
    const r = rowOf(ws, s.label);
    const expected = orderOf(s.label);
    for (let i = 0; i < 12; i++) assert.equal(num(ws, r, i + 3), expected[i], `${s.label} month ${i}`);
    assert.equal(num(ws, r, 15), expected.reduce((a, b) => a + b, 0));
  }

  // Each model subtotal must equal its own sizes — the number the factory PO is written from.
  for (const model of MODELS) {
    const sub = rowOf(ws, model);
    for (let i = 0; i < 12; i++) {
      const expected = SIZES.reduce((a, sz) => a + orderOf(`${model}-${sz}`)[i], 0);
      assert.equal(num(ws, sub, i + 3), expected, `${model} subtotal month ${i}`);
    }
  }
  // Grand total = sum of the model subtotals, and column totals = row totals.
  const grand = rowOf(ws, 'ALL SKUs');
  let byCol = 0;
  for (let i = 0; i < 12; i++) {
    byCol += num(ws, grand, i + 3);
    const expected = skus.reduce((a, s) => a + orderOf(s.label)[i], 0);
    assert.equal(num(ws, grand, i + 3), expected);
  }
  assert.equal(num(ws, grand, 15), byCol);
  assert.ok(byCol > 0, 'a growing forecast must order something');
});

test('allocate now: the headline equals the sum of the per-size earmarks', async () => {
  const { skus, rollup } = fixture();
  const wb = await build();
  const ws = wb.getWorksheet('Allocate now')!;

  const expected = rollup.total_prefill_needed;
  assert.equal(num(ws, rowOf(ws, 'ALL SKUs'), 3), expected);
  assert.equal(expected, skus.reduce((s, k) => s + k.report.warehouse_prefill_needed, 0));
  for (const s of skus) assert.equal(num(ws, rowOf(ws, s.label), 3), s.report.warehouse_prefill_needed);
  // The decision column stays next to product+size, not behind the description.
  assert.equal(String(ws.getCell(rowOf(ws, 'Product'), 3).value), 'EARMARK FOR AMAZON NOW');
  // And the headline call-out states the same figure in words.
  assert.match(String(ws.getCell(4, 1).value), new RegExp(expected.toLocaleString('en-US')));
});

test('monthly demand: per size, and the rings sum back to the aggregate forecast', async () => {
  const { skus } = fixture();
  const wb = await build();
  const ws = wb.getWorksheet('Monthly demand 12 mo')!;
  for (const s of skus) {
    const r = rowOf(ws, s.label);
    for (let i = 0; i < 12; i++) assert.equal(num(ws, r, i + 3), s.report.months[i].forecast_demand);
  }
  const rings = skus.filter(s => !s.report.is_attach_product);
  assert.equal(rings.reduce((a, s) => a + s.report.months[0].forecast_demand, 0), FORECAST.monthlyUnits[6]);

  const orders = wb.getWorksheet('China orders 12 mo')!;
  assert.equal(String(orders.getCell(rowOf(orders, 'Order lands in'), 3).value), 'Oct 2026');  // +3 months
});

test('fba transfers: fortnightly columns, each cell the projection\'s own transfer', async () => {
  const { skus } = fixture();
  const wb = await build();
  const ws = wb.getWorksheet('FBA transfers 2-weekly')!;
  const head = rowOf(ws, 'Ships on →');
  assert.equal(String(ws.getCell(head, 3).value), '29 Jul 26');   // today — the transfer proposed now
  assert.equal(String(ws.getCell(head, 4).value), '12 Aug 26');   // +14 days
  assert.equal(String(ws.getCell(rowOf(ws, 'Sellable at Amazon'), 3).value), '2 Sep 26');  // +35-day leg

  for (const s of skus) {
    const r = rowOf(ws, s.label);
    const byDay = new Map(s.plan.transfers.map(t => [t.day, t.qty]));
    assert.equal(num(ws, r, 3), byDay.get(0) ?? 0, `${s.label} day 0 must equal the Ship-to-FBA queue`);
    assert.equal(num(ws, r, 4), byDay.get(14) ?? 0);
  }
  assert.equal(num(ws, rowOf(ws, 'ALL SKUs'), 3),
    skus.reduce((a, s) => a + (s.plan.transfers.find(t => t.day === 0)?.qty ?? 0), 0));
});

test('model tab: chain stated once for the model, then broken out by size', async () => {
  const { skus } = fixture();
  const wb = await build();
  const ws = wb.getWorksheet('USRSL-GD by size')!;
  const model = skus.filter(s => s.label.startsWith('USRSL-GD'));

  // Section 1 — the chain, summed across the model's sizes.
  const head = rowOf(ws, 'Month');
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map(c => String(ws.getCell(head, c).value)),
    ['Expected to sell', 'FBA shelf goal', 'Ships WH → FBA', 'Cumulative shipped',
      'Warehouse held for Amazon', 'China order to place', 'Order lands']);
  const first = head + 1;
  assert.equal(String(ws.getCell(first, 1).value), 'Jul 2026');
  for (const [col, pick] of [[2, 'forecast_demand'], [3, 'fba_target_units'], [4, 'expected_transfer'],
    [6, 'warehouse_for_amazon']] as const) {
    assert.equal(num(ws, first, col), model.reduce((a, s) => a + (s.report.months[0] as any)[pick], 0),
      `chain column ${col} must be the model total`);
  }

  // Sections 2+ — per-size breakouts. The China-order block is the one the PO is written from, and it
  // must agree with the model's own row on the China-orders tab.
  const bySize = rowOf(ws, 'China order to place — by size');
  assert.ok(bySize > head, 'the size breakout follows the chain');
  const sizeHead = (() => { for (let r = bySize; r <= ws.rowCount; r++) if (String(ws.getCell(r, 1).value) === 'Product') return r; throw new Error('no size table'); })();
  for (const s of model) {
    const r = (() => { for (let i = sizeHead + 1; i <= ws.rowCount; i++) if (String(ws.getCell(i, 1).value) === s.label) return i; throw new Error(`no row ${s.label}`); })();
    for (let i = 0; i < 12; i++) assert.equal(num(ws, r, i + 3), s.report.months[i].recommended_order);
  }
  const orders = wb.getWorksheet('China orders 12 mo')!;
  const modelTotal = model.reduce((a, s) => a + s.report.months.reduce((b, m) => b + m.recommended_order, 0), 0);
  assert.equal(num(orders, rowOf(orders, 'USRSL-GD'), 15), modelTotal);
  assert.equal(num(ws, rowOf(ws, '12-month total'), 7), modelTotal);
});

test('read me: names the settings, and points at the model tabs that exist', async () => {
  const wb = await build();
  const ws = wb.getWorksheet('Read me first')!;
  let text = '';
  for (let r = 1; r <= ws.rowCount; r++) for (let c = 1; c <= 3; c++) text += String(ws.getCell(r, c).value ?? '') + '\n';
  for (const needle of ['90 days', '60 days', '35 days', 'every 14 days', 'Case pack',
    'USRSL-GD', 'USR-MS', 'One tab per model']) {
    assert.ok(text.includes(needle), `read-me should state "${needle}"`);
  }
  // The whole point of the export: these are Amazon's units, not a company-wide total.
  assert.match(text, /AMAZON ONLY/);
  assert.match(text, /retail and Shopify/);
});
