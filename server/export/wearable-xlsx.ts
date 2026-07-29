// The smart-ring ordering plan as an Excel workbook for the inventory-management team.
//
// Why a workbook and not the CSV we already had: this file has to answer four different questions for
// a team that does NOT plan only for Amazon, and has to answer them without being a black box.
//
//   1. How many units of the stock we hold RIGHT NOW must be earmarked for Amazon?  ("Allocate now")
//   2. What do we order from China each month for the next 12?                      ("China orders")
//   3. How much do we believe we'll sell per SKU per month?                         ("Monthly demand")
//   4. How much moves to FBA every 2 weeks?                                         ("FBA transfers")
//
// Every quantity in here is READ OUT of the same projection that drives the in-app chart and the
// Ship-to-FBA queue — nothing is recomputed with a parallel formula. The detail tabs lay the
// derivation out column by column (demand → shelf goal → transfer → warehouse earmark → China order)
// so a reader can follow any single number back to its cause.
//
// LAYOUT: a smart ring is one model in many ring sizes, and the factory PO is written per size. So
// every grid is grouped by MODEL with its sizes in ascending order and a subtotal per model — not
// sorted by sales rate, which interleaves the models and makes the sizes impossible to read off.
// Detail tabs are per MODEL for the same reason: one tab per size would mean 25 tabs repeating the
// same explanation, so each model tab explains the chain once and then breaks the numbers out by size.

import ExcelJS from 'exceljs';
import type { TemplateParams, WearableReport, WearableRollup, WearablePlan, WearableRole } from '../../engine/types.ts';
import { addDays, addMonths, firstOfMonth, diffDays } from '../../engine/dates.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyMonth = (ym: string): string => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
const prettyDate = (d: string): string => {
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
};

// Print-friendly palette derived from the app's brand vars, darkened where white text sits on top.
const INK = 'FF1F2430';
const MUTED = 'FF6B7280';
const RULE = 'FFD8DBE6';
const TINT = 'FFF4F5FA';
const PURPLE = 'FF4A46C9';   // ordering from China   (--c-order)
const TEAL = 'FF0F8C8A';     // demand / health       (--c-health)
const OLIVE = 'FF5F6B12';    // shipping to FBA       (--c-ship, darkened for white text)
const LIME = 'FFE9FB4A';     // the headline earmark fill (dark text on top)
const BODY = 'Calibri';

const NUM = '#,##0';

export interface WearableExportSku {
  sku: string;                 // Amazon SKU (the engine's key)
  label: string;               // QALO SKU where mapped — what the inventory team calls it
  title: string;
  role: WearableRole;
  report: WearableReport;
  plan: WearablePlan;          // 12-month projection: biweekly transfers + monthly orders
  fba_available: number;
  fba_coming: number;
  case_pack: number | null;
  template: TemplateParams;
}

export interface WearableExportInput {
  skus: WearableExportSku[];
  rollup: WearableRollup | null;
  today: string;
  snapshotDate: string | null;
  forecastYear: number;
}

/** One model (a colour/style) and its ring sizes — the unit a factory PO is written in. */
interface SkuGroup {
  key: string;                  // 'USRSL-GD' — the SKU stem shared by every size
  desc: string;                 // the product name with the size stripped
  isKit: boolean;
  skus: WearableExportSku[];    // ascending by size
  sizeOf: Map<string, string>;  // sku label → '06' (kept as text so the leading zero survives)
}

/**
 * Split the flat SKU list into models × sizes.
 *
 * The size is read off the end of the SKU (`USRSL-GD-06` → model `USRSL-GD`, size `06`) rather than
 * from a hard-coded list of QALO's products, so new colours and sizes group themselves. A SKU with no
 * numeric tail is its own group, and the sizing kit is always separated out and placed last because
 * it is an attach product rather than a ring.
 */
function groupSkus(skus: WearableExportSku[]): SkuGroup[] {
  const groups = new Map<string, SkuGroup>();
  for (const s of skus) {
    const m = /^(.*)-(\d+)$/.exec(s.label);
    const isKit = s.report.is_attach_product;
    const key = isKit || !m ? s.label : m[1];
    let g = groups.get(key);
    if (!g) {
      // Strip the trailing "…, Size 06)" so the model description reads as the model, not one size.
      const desc = s.title.replace(/[,(]?\s*Size\s*\d+\s*\)?\s*$/i, '').replace(/[\s,(–-]+$/, '');
      g = { key, desc, isKit, skus: [], sizeOf: new Map() };
      groups.set(key, g);
    }
    g.skus.push(s);
    if (m && !isKit) g.sizeOf.set(s.label, m[2]);
  }
  const total = (g: SkuGroup) => g.skus.reduce((a, s) => a + s.report.months.reduce((b, mo) => b + mo.recommended_order, 0), 0);
  for (const g of groups.values()) {
    g.skus.sort((a, b) => (g.sizeOf.get(a.label) ?? '').localeCompare(g.sizeOf.get(b.label) ?? '') || a.label.localeCompare(b.label));
  }
  // Biggest model first so the PO leads with the volume; the attach product always last.
  return [...groups.values()].sort((a, b) => Number(a.isKit) - Number(b.isKit) || total(b) - total(a));
}

/** Short label for a model tab / subtotal row — the stem plus the colour Excel can fit. */
const groupLabel = (g: SkuGroup): string => g.key;

// ── small styling helpers ───────────────────────────────────────────────────
type Cell = ExcelJS.Cell;

const fill = (c: Cell, argb: string): void => {
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
};

function headerRow(ws: ExcelJS.Worksheet, rowIdx: number, bg: string): void {
  const row = ws.getRow(rowIdx);
  row.height = 30;
  row.eachCell({ includeEmpty: true }, cell => {
    if (cell.value === null || cell.value === undefined || cell.value === '') return;
    cell.font = { name: BODY, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    fill(cell, bg);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: RULE } } };
  });
}

/** A section heading that sits above a table. */
function title(ws: ExcelJS.Worksheet, row: number, text: string, sub?: string): number {
  const t = ws.getCell(row, 1);
  t.value = text;
  t.font = { name: BODY, size: 15, bold: true, color: { argb: INK } };
  ws.getRow(row).height = 22;
  if (!sub) return row + 2;
  const s = ws.getCell(row + 1, 1);
  s.value = sub;
  s.font = { name: BODY, size: 10, italic: true, color: { argb: MUTED } };
  ws.getRow(row + 1).height = 16;
  return row + 3;
}

/** An explanatory paragraph under a table — this is where the "why" lives. */
function note(ws: ExcelJS.Worksheet, row: number, lines: string[], width: number): number {
  let r = row;
  for (const line of lines) {
    const c = ws.getCell(r, 1);
    c.value = line;
    c.font = { name: BODY, size: 9.5, color: { argb: MUTED } };
    c.alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(r, 1, r, Math.max(2, width));
    ws.getRow(r).height = line.length > 150 ? 30 : 15;
    r++;
  }
  return r + 1;
}

/** Zebra + borders + number format over a block of data rows. */
function bodyBlock(ws: ExcelJS.Worksheet, from: number, to: number, cols: number, opts?: { firstColLeft?: boolean }): void {
  for (let r = from; r <= to; r++) {
    const row = ws.getRow(r);
    row.height = 18;
    for (let c = 1; c <= cols; c++) {
      const cell = row.getCell(c);
      cell.font = { name: BODY, size: 10, color: { argb: INK } };
      cell.border = { bottom: { style: 'hair', color: { argb: RULE } } };
      if ((r - from) % 2 === 1) fill(cell, TINT);
      if (c === 1 && opts?.firstColLeft !== false) {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        if (typeof cell.value === 'number') cell.numFmt = NUM;
      }
    }
  }
}

function totalRow(ws: ExcelJS.Worksheet, r: number, cols: number): void {
  const row = ws.getRow(r);
  row.height = 22;
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.font = { name: BODY, size: 10.5, bold: true, color: { argb: INK } };
    fill(cell, 'FFEDEFF7');
    cell.border = { top: { style: 'medium', color: { argb: INK } } };
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
    if (typeof cell.value === 'number') cell.numFmt = NUM;
  }
}

const landscape = (ws: ExcelJS.Worksheet): void => {
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: {
    left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2,
  } };
};

/** Excel forbids []:*?/\ in tab names and caps them at 31 chars. */
const tabName = (s: string): string => s.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);

/** A model-subtotal row: same weight as a total, but tinted to read as a group break, not the end. */
function subtotalRow(ws: ExcelJS.Worksheet, r: number, cols: number): void {
  const row = ws.getRow(r);
  row.height = 20;
  for (let c = 1; c <= cols; c++) {
    const cell = row.getCell(c);
    cell.font = { name: BODY, size: 10, bold: true, color: { argb: INK } };
    fill(cell, 'FFE3E7F4');
    cell.border = { top: { style: 'thin', color: { argb: MUTED } }, bottom: { style: 'thin', color: { argb: MUTED } } };
    cell.alignment = { vertical: 'middle', horizontal: c <= 2 ? 'left' : 'center' };
    if (typeof cell.value === 'number') cell.numFmt = NUM;
  }
}

/**
 * The shared shape of the three headline grids: one row per SKU (Product · Size · one column per
 * period · row total), grouped by model with a subtotal per model and a grand total.
 *
 * All three go through here so the grouping, the size column, the subtotals and the totals cannot
 * drift apart between tabs — which is the failure a reader notices first and trusts least.
 */
function periodGrid(ws: ExcelJS.Worksheet, startRow: number, o: {
  groups: SkuGroup[];
  periods: string[];                                     // column headings
  valueOf: (sku: WearableExportSku, periodIdx: number) => number;
  headerBg: string;
  firstColHeader: string;
  blankZeros?: boolean;                                  // leave 0 empty (orders) or print it (demand)
}): { headRow: number; cols: number; endRow: number } {
  const P = o.periods.length;
  const cols = P + 3;                                    // Product, Size, …periods…, total
  const TOTAL_COL = cols;

  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 7;
  for (let i = 0; i < P; i++) ws.getColumn(i + 3).width = P > 14 ? 9.5 : 11;
  ws.getColumn(TOTAL_COL).width = 13;

  let r = startRow;
  const headRow = r;
  ws.getCell(r, 1).value = o.firstColHeader;
  ws.getCell(r, 2).value = 'Size';
  o.periods.forEach((p, i) => { ws.getCell(r, i + 3).value = p; });
  ws.getCell(r, TOTAL_COL).value = '12-month total';
  headerRow(ws, headRow, o.headerBg);
  r++;

  const show = (v: number) => (o.blankZeros && v === 0 ? null : v);

  for (const g of o.groups) {
    const from = r;
    for (const s of g.skus) {
      ws.getCell(r, 1).value = s.label;
      ws.getCell(r, 2).value = g.sizeOf.get(s.label) ?? (g.isKit ? 'kit' : '—');
      let rowTotal = 0;
      for (let i = 0; i < P; i++) {
        const v = o.valueOf(s, i);
        rowTotal += v;
        ws.getCell(r, i + 3).value = show(v);
      }
      ws.getCell(r, TOTAL_COL).value = rowTotal;
      r++;
    }
    bodyBlock(ws, from, r - 1, cols);
    for (let i = from; i < r; i++) {
      ws.getCell(i, 2).alignment = { vertical: 'middle', horizontal: 'center' };
      ws.getCell(i, 2).font = { name: BODY, size: 10, color: { argb: MUTED } };
    }

    // Model subtotal — the line the PO is actually written from. A one-SKU group (the sizing kit)
    // would just repeat its own row, so it doesn't get one.
    if (g.skus.length < 2) continue;
    ws.getCell(r, 1).value = groupLabel(g);
    ws.getCell(r, 2).value = g.isKit ? '' : `${g.skus.length} sizes`;
    let gTotal = 0;
    for (let i = 0; i < P; i++) {
      const v = g.skus.reduce((a, s) => a + o.valueOf(s, i), 0);
      gTotal += v;
      ws.getCell(r, i + 3).value = show(v);
    }
    ws.getCell(r, TOTAL_COL).value = gTotal;
    subtotalRow(ws, r, cols);
    r++;
  }

  const all = o.groups.flatMap(g => g.skus);
  ws.getCell(r, 1).value = 'ALL SKUs';
  let grand = 0;
  for (let i = 0; i < P; i++) {
    const v = all.reduce((a, s) => a + o.valueOf(s, i), 0);
    grand += v;
    ws.getCell(r, i + 3).value = show(v);
  }
  ws.getCell(r, TOTAL_COL).value = grand;
  totalRow(ws, r, cols);

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: headRow, showGridLines: false }];
  return { headRow, cols, endRow: r };
}

// ── the workbook ────────────────────────────────────────────────────────────

export async function buildWearableWorkbook(input: WearableExportInput): Promise<Buffer> {
  const { skus, rollup, today, snapshotDate, forecastYear } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QALO Replenishment Planner';
  wb.created = new Date(`${today}T00:00:00Z`);

  // Reference figures shared by every sheet. All WEARABLE SKUs run the same template, so these are
  // the same for each — read off the first and stated once, in the Read-me.
  const t0 = skus[0].template;
  const leadDays = skus[0].report.lead_days;
  const shelfDays = Math.round(t0.fba_target_cover_days);
  const legDays = Math.round(t0.fba_ship_checkin_days);
  const reviewDays = Math.round(t0.review_period_fba_days);
  const safetyDays = Math.round(t0.safety_days);
  const monthLabels = skus[0].report.months.map(m => prettyMonth(m.month));

  // Models × sizes — every tab below is laid out in this order.
  const groups = groupSkus(skus);

  readMe(wb, { skus, groups, today, snapshotDate, forecastYear, leadDays, shelfDays, legDays, reviewDays, safetyDays });
  allocateNow(wb, { groups, rollup, today, leadDays, shelfDays });
  chinaOrders(wb, { groups, monthLabels, leadDays });
  monthlyDemand(wb, { groups, skus, monthLabels });
  fbaTransfers(wb, { groups, skus, today, reviewDays, legDays });
  for (const g of groups) groupDetail(wb, g, monthLabels, leadDays, shelfDays);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ── Tab 1: Read me ──────────────────────────────────────────────────────────
function readMe(wb: ExcelJS.Workbook, o: {
  skus: WearableExportSku[]; groups: SkuGroup[]; today: string; snapshotDate: string | null; forecastYear: number;
  leadDays: number; shelfDays: number; legDays: number; reviewDays: number; safetyDays: number;
}): void {
  const ws = wb.addWorksheet('Read me first', { views: [{ showGridLines: false }] });
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 72;

  let r = 1;
  const h = ws.getCell(r, 1);
  h.value = 'Smart ring — 12-month China ordering plan';
  h.font = { name: BODY, size: 20, bold: true, color: { argb: INK } };
  ws.getRow(r).height = 30;
  r++;
  const sub = ws.getCell(r, 1);
  sub.value = `Prepared ${prettyDate(o.today)} · Amazon inventory as of ${o.snapshotDate ? prettyDate(o.snapshotDate) : 'latest import'} · forecast base year ${o.forecastYear}`;
  sub.font = { name: BODY, size: 10.5, color: { argb: MUTED } };
  ws.getRow(r).height = 18;
  r += 2;

  r = note(ws, r, [
    'These quantities cover AMAZON ONLY. The warehouse and the China POs also serve retail and Shopify, so nothing here is a total — it is Amazon\'s share, which you add to the other channels\' needs.',
    'The plan is built from the monthly unit forecast, not from what the Amazon team expects to request. Sizing off requested transfers describes the shelf, not the customer: it lags a ramp by the full 90-day China lead, which is where the stockouts came from. Forecast first, then the shelf, then the transfer, then the order.',
  ], 3);

  // How each number is derived — the chain, stated mechanically.
  r = title(ws, r, 'How each number is derived');
  const chainHead = r;
  ws.getCell(r, 1).value = 'Step';
  ws.getCell(r, 2).value = 'Column name';
  ws.getCell(r, 3).value = 'How it is calculated';
  headerRow(ws, chainHead, INK);
  r++;

  const chain: [string, string, string][] = [
    ['1 · What we expect to sell',
      'Planned demand',
      `The aggregate smart-ring monthly forecast, split across the variants by each one's share of trailing sales (the sizing kit rides along at its measured attach rate). If a month's forecast is below what that SKU is actually selling, the real sales rate is used instead — the plan never sizes for less than demonstrated demand. Those months are tagged "at actual".`],
    ['2 · What Amazon must hold',
      'FBA shelf goal',
      `The units needed to cover the next ${o.shelfDays} days of planned demand, read forward off the forecast curve. It rises before a peak and falls after one, so a correctly drawn-down shelf does not look like a failure.`],
    ['3 · What moves to FBA',
      'Ships WH → FBA',
      `Reviewed every ${o.reviewDays} days. Ship = (demand over the ${o.shelfDays}-day goal window after it lands) − (what is still on the shelf when it lands), where the shipment spends ${o.legDays} days in transit and check-in. Demand during the leg and demand after it lands are summed separately off the forecast — never blended into one average rate, which is what under-shipped coming out of December.`],
    ['4 · What the warehouse owes Amazon',
      'Warehouse held for Amazon',
      'The running pool the transfers above draw from, earmarked for Amazon. This is Amazon\'s demand on the warehouse, not a physical count — see "Allocate now" for the opening commitment.'],
    ['5 · What to order from China',
      'China order to place',
      `Placed monthly, landing ${o.leadDays} days later. Each order is sized to bring the Amazon-earmarked pool up to the transfers it must serve in the month it arrives, plus ${o.safetyDays} days of demand as a cushion. Rounded to whole cases.`],
  ];
  const chainFrom = r;
  for (const [step, col, how] of chain) {
    ws.getCell(r, 1).value = step;
    ws.getCell(r, 2).value = col;
    ws.getCell(r, 3).value = how;
    r++;
  }
  for (let i = chainFrom; i < r; i++) {
    const row = ws.getRow(i);
    row.height = 62;
    for (let c = 1; c <= 3; c++) {
      const cell = row.getCell(c);
      cell.font = { name: BODY, size: 10, color: { argb: INK }, bold: c === 1 };
      cell.alignment = { vertical: 'top', wrapText: true, horizontal: 'left' };
      cell.border = { bottom: { style: 'hair', color: { argb: RULE } } };
      if ((i - chainFrom) % 2 === 1) fill(cell, TINT);
    }
  }
  r += 1;

  // The parameters those steps used, so nothing above is an unexplained constant.
  r = title(ws, r, 'Settings used', 'Change these on the template in the planner and every number in this workbook moves with them.');
  const pHead = r;
  ws.getCell(r, 1).value = 'Setting';
  ws.getCell(r, 2).value = 'Value';
  ws.getCell(r, 3).value = 'What it means';
  headerRow(ws, pHead, TEAL);
  r++;
  const params: [string, string, string][] = [
    ['China lead time', `${o.leadDays} days`, 'From placing the order to units being available at the warehouse.'],
    ['FBA shelf goal', `${o.shelfDays} days`, 'Days of forward demand each transfer aims to leave on the Amazon shelf.'],
    ['Warehouse → FBA transit', `${o.legDays} days`, 'Ship time plus Amazon check-in before units become sellable.'],
    ['Transfer review cycle', `every ${o.reviewDays} days`, 'How often a transfer to FBA is sized and sent.'],
    ['Safety cushion', `${o.safetyDays} days`, 'Extra demand each China order carries above the transfers it must serve.'],
    // The per-SKU list goes in the description column — in the narrow value column it overflows.
    ['Case pack', 'whole cases',
      `China orders and transfers are rounded to whole cases. ${o.skus.map(s => `${s.label}: ${s.case_pack ?? 'none'}`).join(' · ')}.`],
  ];
  const pFrom = r;
  for (const [k, v, d] of params) {
    ws.getCell(r, 1).value = k;
    ws.getCell(r, 2).value = v;
    ws.getCell(r, 3).value = d;
    r++;
  }
  for (let i = pFrom; i < r; i++) {
    const row = ws.getRow(i);
    row.height = 18;
    for (let c = 1; c <= 3; c++) {
      const cell = row.getCell(c);
      cell.font = { name: BODY, size: 10, color: { argb: INK }, bold: c === 2 };
      cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'center' : 'left', wrapText: c === 3 };
      cell.border = { bottom: { style: 'hair', color: { argb: RULE } } };
      if ((i - pFrom) % 2 === 1) fill(cell, TINT);
    }
  }
  r += 1;

  // What each tab is for.
  r = title(ws, r, 'What is in this workbook');
  const tHead = r;
  // Tab names run wide, so they take columns A+B — merged, or the header band shows a gap at B.
  ws.mergeCells(tHead, 1, tHead, 2);
  ws.getCell(tHead, 1).value = 'Tab';
  ws.getCell(tHead, 3).value = 'Use it for';
  headerRow(ws, tHead, PURPLE);
  r++;
  const ringGroups = o.groups.filter(g => !g.isKit);
  const tabs: [string, string][] = [
    ['Allocate now', 'The one decision needed today: how much of the stock you already hold must be earmarked for Amazon, per size. Nothing ordered today lands for ' + o.leadDays + ' days, so that opening stretch can only come from stock that already exists.'],
    ['China orders — 12 months', 'What to place with the factory each month, per ring size, subtotalled by model. The month each order lands is on the row underneath.'],
    ['Monthly demand — 12 months', 'What we believe we will sell per size per month on Amazon. Everything else is derived from this.'],
    ['FBA transfers — every 2 weeks', 'The pull on the warehouse, fortnight by fortnight, so you can see the timing rather than a monthly lump.'],
    [`One tab per model (${o.groups.length})`,
      `${ringGroups.map(g => g.key).join(', ')}${o.groups.length > ringGroups.length ? ' and the sizing kit' : ''}. Each explains the chain once for the whole model — demand → shelf goal → transfer → warehouse earmark → China order — then breaks the order, the demand and the transfers out by size.`],
  ];
  const tFrom = r;
  for (const [k, d] of tabs) {
    ws.mergeCells(r, 1, r, 2);
    ws.getCell(r, 1).value = k;
    ws.getCell(r, 3).value = d;
    r++;
  }
  for (let i = tFrom; i < r; i++) {
    const row = ws.getRow(i);
    row.height = 32;
    for (let c = 1; c <= 3; c++) {
      const cell = row.getCell(c);
      cell.font = { name: BODY, size: 10, color: { argb: INK }, bold: c === 1 };
      cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: RULE } } };
      if ((i - tFrom) % 2 === 1) fill(cell, TINT);
    }
  }
  r += 1;

  note(ws, r, [
    'Worth knowing: a month tagged "est." has no forecast entered for its own year, so the same month of the forecast year is reused. A month tagged "at actual" had a forecast below current sales, so the real sales rate was used. Figures beyond the forecast year should be treated as a planning shape, not a commitment.',
  ], 3);
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}


// ── Tab 2: Allocate now — the headline ──────────────────────────────────────
function allocateNow(wb: ExcelJS.Workbook, o: {
  groups: SkuGroup[]; rollup: WearableRollup | null; today: string; leadDays: number; shelfDays: number;
}): void {
  const ws = wb.addWorksheet('Allocate now', { views: [{ showGridLines: false }] });
  landscape(ws);
  // The earmark sits in column C, immediately after product and size: it is the one number this tab
  // exists to deliver, and behind a wide description column it fell off the first printed page.
  const widths = [20, 7, 22, 14, 14, 24, 14, 14, 11];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const COLS = 9;
  const all = o.groups.flatMap(g => g.skus);

  const coverUntil = addDays(o.today, o.leadDays);
  let r = title(ws, 1,
    'Allocate to Amazon now',
    `Of the stock you hold today, this much must be earmarked for Amazon — per ring size. Nothing ordered today can land before ${prettyDate(coverUntil)} (${o.leadDays}-day China lead), so this stretch can only be served by units that already exist.`);

  // The headline total, called out before the table.
  const total = o.rollup?.total_prefill_needed ?? all.reduce((s, k) => s + k.report.warehouse_prefill_needed, 0);
  ws.mergeCells(r, 1, r + 1, 3);
  const big = ws.getCell(r, 1);
  big.value = `${total.toLocaleString('en-US')} units`;
  big.font = { name: BODY, size: 26, bold: true, color: { argb: INK } };
  big.alignment = { vertical: 'middle', horizontal: 'center' };
  fill(big, LIME);
  big.border = { top: { style: 'medium', color: { argb: INK } }, bottom: { style: 'medium', color: { argb: INK } },
    left: { style: 'medium', color: { argb: INK } }, right: { style: 'medium', color: { argb: INK } } };
  ws.mergeCells(r, 4, r + 1, COLS);
  const bigNote = ws.getCell(r, 4);
  bigNote.value = 'Total to earmark for Amazon across every smart-ring size, on hand or already on the water. This is the number to confirm or push back on — if it is not available, the shortfall becomes an Amazon stockout roughly one shelf-goal window later, and no China order placed today can prevent it.';
  bigNote.font = { name: BODY, size: 10, color: { argb: INK } };
  bigNote.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  ws.getRow(r).height = 26;
  ws.getRow(r + 1).height = 26;
  r += 3;

  const head = r;
  const headers = ['Product', 'Size', 'EARMARK FOR AMAZON NOW', 'Sellable at Amazon now',
    'On the way to Amazon', 'First transfer out of warehouse', 'Units in that transfer',
    'Demand next 3 months', 'Share of sales'];
  headers.forEach((h, i) => { ws.getCell(head, i + 1).value = h; });
  headerRow(ws, head, INK);
  fill(ws.getCell(head, 3), OLIVE);
  r++;

  const next3Of = (s: WearableExportSku) => s.report.months.slice(0, 3).reduce((a, m) => a + m.forecast_demand, 0);
  const firstQtyOf = (s: WearableExportSku) => s.plan.transfers.find(t => t.qty > 0)?.qty ?? 0;

  for (const g of o.groups) {
    const from = r;
    for (const s of g.skus) {
      const first = s.plan.transfers.find(t => t.qty > 0) ?? null;
      const row = [
        s.label,
        g.sizeOf.get(s.label) ?? (g.isKit ? 'kit' : '—'),
        s.report.warehouse_prefill_needed,
        s.fba_available,
        s.fba_coming,
        first ? `${prettyDate(first.date)} → lands ${prettyDate(first.arrives_date)}` : 'none scheduled',
        firstQtyOf(s),
        next3Of(s),
        s.report.is_attach_product
          ? `${s.report.attach_rate?.toFixed(2) ?? '—'}× attach`
          : `${(s.report.variant_share * 100).toFixed(1)}%`,
      ];
      row.forEach((v, i) => { ws.getCell(r, i + 1).value = v as any; });
      r++;
    }
    bodyBlock(ws, from, r - 1, COLS);
    for (let i = from; i < r; i++) {
      const c = ws.getCell(i, 3);
      c.font = { name: BODY, size: 12, bold: true, color: { argb: INK } };
      fill(c, 'FFF7FDCB');
      c.numFmt = NUM;
      ws.getCell(i, 2).font = { name: BODY, size: 10, color: { argb: MUTED } };
    }

    // A one-SKU group (the sizing kit) would just repeat its own row.
    if (g.skus.length < 2) continue;
    ws.getCell(r, 1).value = groupLabel(g);
    ws.getCell(r, 2).value = g.isKit ? '' : `${g.skus.length} sizes`;
    ws.getCell(r, 3).value = g.skus.reduce((a, s) => a + s.report.warehouse_prefill_needed, 0);
    ws.getCell(r, 4).value = g.skus.reduce((a, s) => a + s.fba_available, 0);
    ws.getCell(r, 5).value = g.skus.reduce((a, s) => a + s.fba_coming, 0);
    ws.getCell(r, 7).value = g.skus.reduce((a, s) => a + firstQtyOf(s), 0);
    ws.getCell(r, 8).value = g.skus.reduce((a, s) => a + next3Of(s), 0);
    subtotalRow(ws, r, COLS);
    r++;
  }

  ws.getCell(r, 1).value = 'ALL SKUs';
  ws.getCell(r, 3).value = total;
  ws.getCell(r, 4).value = all.reduce((s, k) => s + k.fba_available, 0);
  ws.getCell(r, 5).value = all.reduce((s, k) => s + k.fba_coming, 0);
  ws.getCell(r, 7).value = all.reduce((s, k) => s + firstQtyOf(k), 0);
  ws.getCell(r, 8).value = all.reduce((s, k) => s + next3Of(k), 0);
  totalRow(ws, r, COLS);
  fill(ws.getCell(r, 3), LIME);
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: head, showGridLines: false }];
  r += 2;

  note(ws, r, [
    'How the earmark is calculated: the plan walks forward day by day, taking each transfer out of an Amazon-earmarked warehouse pool and adding each China order when it lands. Over the first ' + o.leadDays + ' days the pool has no new arrivals to draw on, so it runs down. The lowest point it reaches in that stretch is the shortfall — the units that must already exist for the plan to hold. That is this column.',
    'It is not a physical stock count and not a claim on your total inventory. It says only how much of what you hold has to be treated as Amazon\'s. Add retail and Shopify needs on top of it as usual.',
    'From ' + prettyDate(coverUntil) + ' onward, the China orders on the next tab take over, and the earmark rises and falls with them — see the "Warehouse held for Amazon" column on each model tab.',
  ], COLS);
}

// ── Tab 3: China orders ─────────────────────────────────────────────────────
function chinaOrders(wb: ExcelJS.Workbook, o: {
  groups: SkuGroup[]; monthLabels: string[]; leadDays: number;
}): void {
  const ws = wb.addWorksheet('China orders 12 mo');
  landscape(ws);
  const start = title(ws, 1, 'China orders to place — next 12 months',
    `Units to place with the factory in each month, per ring size, subtotalled by model. Each order lands at the warehouse about ${o.leadDays} days later, sized to cover the transfers to Amazon in the month it arrives plus a safety cushion.`);

  const grid = periodGrid(ws, start, {
    groups: o.groups, periods: o.monthLabels, headerBg: PURPLE,
    firstColHeader: 'Place in month →', blankZeros: true,
    valueOf: (s, i) => s.report.months[i].recommended_order,
  });
  let r = grid.endRow + 2;

  // The lands-month row makes the 90-day offset visible rather than something to work out.
  ws.getCell(r, 1).value = 'Order lands in';
  o.groups[0].skus[0].report.months.forEach((m, i) => { ws.getCell(r, i + 3).value = prettyMonth(m.order_lands_month); });
  const landsRow = ws.getRow(r);
  landsRow.height = 18;
  for (let c = 1; c <= grid.cols; c++) {
    const cell = landsRow.getCell(c);
    cell.font = { name: BODY, size: 9.5, italic: true, color: { argb: MUTED } };
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
  }
  r += 2;

  note(ws, r, [
    'Rows are ring sizes; the tinted row under each model is that model\'s total — the line the factory PO is written from.',
    'A blank month means no order is needed then — what is already on the water plus the warehouse earmark covers that month\'s pull. It does not mean demand stopped; check the demand tab.',
    `Why the 12-month order total is larger than 12 months of demand: an order placed in the last months of this window lands ${o.leadDays} days later and is sized for the demand it serves AFTER the window closes, and every order carries a safety cushion on top. The orders are funding roughly 15 months of selling, not 12.`,
    'These are Amazon\'s units only. Combine with retail and Shopify before placing the PO.',
  ], grid.cols);
}

// ── Tab 4: Monthly demand ───────────────────────────────────────────────────
function monthlyDemand(wb: ExcelJS.Workbook, o: {
  groups: SkuGroup[]; skus: WearableExportSku[]; monthLabels: string[];
}): void {
  const ws = wb.addWorksheet('Monthly demand 12 mo');
  landscape(ws);
  const start = title(ws, 1, 'What we believe we will sell — next 12 months',
    'Amazon units per ring size per month, subtotalled by model. This is the input everything else in the workbook is derived from: the shelf goal, the transfers, and the China orders all follow from these numbers.');

  const grid = periodGrid(ws, start, {
    groups: o.groups, periods: o.monthLabels, headerBg: TEAL, firstColHeader: 'Product',
    valueOf: (s, i) => s.report.months[i].forecast_demand,
  });
  let r = grid.endRow + 2;

  // Which months are reused or lifted, so no figure is silently overstated.
  const flagged = o.skus[0].report.months.map((_, i) => {
    const anyEst = o.skus.some(s => (s.report.months[i].flags ?? []).includes('FORECAST_EXTRAPOLATED'));
    const anyAct = o.skus.some(s => (s.report.months[i].flags ?? []).includes('PLANNED_AT_ACTUAL'));
    return anyEst && anyAct ? 'est. · at actual' : anyEst ? 'est.' : anyAct ? 'at actual' : '';
  });
  if (flagged.some(Boolean)) {
    ws.getCell(r, 1).value = 'Note';
    flagged.forEach((f, i) => { ws.getCell(r, i + 3).value = f; });
    const nr = ws.getRow(r);
    nr.height = 18;
    for (let c = 1; c <= grid.cols; c++) {
      const cell = nr.getCell(c);
      cell.font = { name: BODY, size: 9, italic: true, color: { argb: MUTED } };
      cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
    }
    r += 2;
  }

  r = note(ws, r, [
    '"est." — no forecast is entered for that month\'s own year, so the same month of the forecast year is reused. Treat it as a shape, not a commitment.',
    '"at actual" — the forecast for that month was below what the SKU is currently selling, so the real sales rate was used instead. The plan never sizes for less than demonstrated demand.',
  ], grid.cols);

  // Forecast vs actual, per model — the credibility check on the numbers above.
  r = title(ws, r, 'Forecast vs what is selling today', 'By model. A figure below 1.00× means the forecast has fallen behind real sales.');
  const vHead = r;
  ['Model', 'Sizes', 'Selling now (units/month)', 'Forecast pace (units/month)', 'Forecast ÷ actual'].forEach((h, i) => {
    ws.getCell(vHead, i + 1).value = h;
  });
  headerRow(ws, vHead, INK);
  r++;
  const vFrom = r;
  for (const g of o.groups) {
    const act = g.skus.reduce((a, s) => a + s.report.actual_run_rate_month, 0);
    const fc = g.skus.reduce((a, s) => a + s.report.forecast_run_rate_month, 0);
    ws.getCell(r, 1).value = groupLabel(g);
    ws.getCell(r, 2).value = g.isKit ? 'kit' : `${g.skus.length}`;
    ws.getCell(r, 3).value = act;
    ws.getCell(r, 4).value = fc;
    ws.getCell(r, 5).value = act > 0 ? `${(fc / act).toFixed(2)}×` : 'no sales yet';
    r++;
  }
  bodyBlock(ws, vFrom, r - 1, 5);
  r += 1;
  note(ws, r, [
    'Forecast pace is the mean of the next three months. Above 1.00× the forecast expects growth over today\'s rate; below 1.00× current sales are already running ahead of the forecast, and the plan is using the actual rate for those months.',
  ], 5);
}

// ── Tab 5: FBA transfers, fortnight by fortnight ────────────────────────────
function fbaTransfers(wb: ExcelJS.Workbook, o: {
  groups: SkuGroup[]; skus: WearableExportSku[]; today: string; reviewDays: number; legDays: number;
}): void {
  const ws = wb.addWorksheet('FBA transfers 2-weekly');
  landscape(ws);

  // Columns are the review dates on which anything actually ships, across all SKUs — so the grid has
  // no dead columns, and a blank cell means "this size ships nothing that fortnight" rather than
  // "no transfer window here".
  const horizonEnd = addMonths(firstOfMonth(o.today), 12);
  const days = [...new Set(o.skus.flatMap(s => s.plan.transfers.filter(t => t.qty > 0).map(t => t.day)))]
    .filter(d => diffDays(addDays(o.today, d), horizonEnd) < 0)
    .sort((a, b) => a - b);

  const start = title(ws, 1, `Transfers to Amazon — every ${o.reviewDays} days`,
    `Units pulled out of the warehouse on each shipping date, per ring size. Units become sellable at Amazon about ${o.legDays} days after they ship. Column headings are ship dates.`);

  const byDay = new Map(o.skus.map(s => [s.label, new Map(s.plan.transfers.map(t => [t.day, t.qty]))]));
  const grid = periodGrid(ws, start, {
    groups: o.groups, periods: days.map(d => prettyDate(addDays(o.today, d))),
    headerBg: OLIVE, firstColHeader: 'Ships on →', blankZeros: true,
    valueOf: (s, i) => byDay.get(s.label)?.get(days[i]) ?? 0,
  });
  let r = grid.endRow + 2;

  // Arrival row, so the warehouse can see the lag between pulling and selling.
  ws.getCell(r, 1).value = 'Sellable at Amazon';
  days.forEach((d, i) => { ws.getCell(r, i + 3).value = prettyDate(addDays(o.today, d + o.legDays)); });
  const ar = ws.getRow(r);
  ar.height = 18;
  for (let c = 1; c <= grid.cols; c++) {
    const cell = ar.getCell(c);
    cell.font = { name: BODY, size: 9, italic: true, color: { argb: MUTED } };
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'center' };
  }
  r += 2;

  note(ws, r, [
    'This is the pull on the warehouse, which is why the timing matters more than the monthly total: the stock has to be there on the ship date, not by month end.',
    'Quantities are sized to leave a full shelf goal at Amazon once the shipment clears check-in. A blank fortnight means that size is already covered through the next window.',
    'The first column is the transfer being proposed right now — it should match the Ship-to-FBA queue in the planner, because both come from the same projection.',
  ], grid.cols);
}

// ── One tab per model: the chain once, then broken out by size ────────────────
function groupDetail(wb: ExcelJS.Workbook, g: SkuGroup, monthLabels: string[], leadDays: number, shelfDays: number): void {
  const ws = wb.addWorksheet(tabName(g.isKit ? `${g.key} detail` : `${g.key} by size`), { views: [{ showGridLines: false }] });
  landscape(ws);
  const M = monthLabels.length;
  const widths = [20, 7, ...Array(M).fill(9.5), 13];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const cols = M + 3;

  const earmark = g.skus.reduce((a, s) => a + s.report.warehouse_prefill_needed, 0);
  const sizes = g.isKit ? 'attach product' : `sizes ${g.sizeOf.get(g.skus[0].label)}–${g.sizeOf.get(g.skus[g.skus.length - 1].label)}`;
  // Amazon titles run to 200 characters; cut at a word boundary so it doesn't end mid-word.
  const desc = g.desc.length <= 150 ? g.desc
    : g.desc.slice(0, 150).replace(/[\s,–-]*\S*$/, '') + '…';
  let r = title(ws, 1, `${g.key} — ${sizes}`, desc);

  const box = ws.getCell(r, 1);
  ws.mergeCells(r, 1, r, cols);
  box.value = `Earmark for Amazon at the warehouse right now: ${earmark.toLocaleString('en-US')} units  ·  sellable at Amazon today ${g.skus.reduce((a, s) => a + s.fba_available, 0).toLocaleString('en-US')}  ·  on the way ${g.skus.reduce((a, s) => a + s.fba_coming, 0).toLocaleString('en-US')}  ·  China lead ${leadDays} days  ·  FBA shelf goal ${shelfDays} days`;
  box.font = { name: BODY, size: 11, bold: true, color: { argb: INK } };
  box.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  fill(box, LIME);
  box.border = { top: { style: 'thin', color: { argb: INK } }, bottom: { style: 'thin', color: { argb: INK } } };
  ws.getRow(r).height = 24;
  r += 2;

  // ── Section 1: the chain, for the model as a whole. Stated once rather than repeated per size,
  // because the method is identical for every size and only the quantities differ.
  r = title(ws, r, 'Why these numbers — the chain, model total',
    'Read a row left to right: we expect to sell that much, so the Amazon shelf must hold the shelf-goal figure, so this much ships out of the warehouse, so the warehouse must hold the earmark, so this much is ordered from China to keep it funded.');
  const cHead = r;
  const chainCols = ['Month', 'Expected to sell', 'FBA shelf goal', 'Ships WH → FBA', 'Cumulative shipped',
    'Warehouse held for Amazon', 'China order to place', 'Order lands', 'Note'];
  chainCols.forEach((h, i) => { ws.getCell(cHead, i + 1).value = h; });
  headerRow(ws, cHead, INK);
  fill(ws.getCell(cHead, 2), TEAL);
  fill(ws.getCell(cHead, 4), OLIVE);
  fill(ws.getCell(cHead, 7), PURPLE);
  // The chain table is 9 columns wide regardless of the month count, so give it its own widths.
  [14, 15, 13, 15, 15, 20, 15, 13, 20].forEach((w, i) => {
    if (ws.getColumn(i + 1).width! < w) ws.getColumn(i + 1).width = w;
  });
  r++;

  const sum = (i: number, pick: (m: WearableExportSku['report']['months'][number]) => number) =>
    g.skus.reduce((a, s) => a + pick(s.report.months[i]), 0);

  const cFrom = r;
  for (let i = 0; i < M; i++) {
    const flags = new Set(g.skus.flatMap(s => s.report.months[i].flags ?? []));
    const order = sum(i, m => m.recommended_order);
    const vals = [
      monthLabels[i], sum(i, m => m.forecast_demand), sum(i, m => m.fba_target_units),
      sum(i, m => m.expected_transfer), sum(i, m => m.cumulative_transfer),
      sum(i, m => m.warehouse_for_amazon), order || null,
      order ? prettyMonth(g.skus[0].report.months[i].order_lands_month) : '',
      [flags.has('FORECAST_EXTRAPOLATED') ? 'forecast reused' : '',
        flags.has('PLANNED_AT_ACTUAL') ? 'sized at actual sales' : ''].filter(Boolean).join('; '),
    ];
    vals.forEach((v, c) => { ws.getCell(r, c + 1).value = v as any; });
    r++;
  }
  bodyBlock(ws, cFrom, r - 1, 9);
  for (let i = cFrom; i < r; i++) {
    ws.getCell(i, 4).font = { name: BODY, size: 10, bold: true, color: { argb: INK } };
    ws.getCell(i, 7).font = { name: BODY, size: 10, bold: true, color: { argb: PURPLE } };
    ws.getCell(i, 9).font = { name: BODY, size: 9, italic: true, color: { argb: MUTED } };
    ws.getCell(i, 9).alignment = { vertical: 'middle', horizontal: 'left' };
  }
  ws.getCell(r, 1).value = '12-month total';
  ws.getCell(r, 2).value = g.skus.reduce((a, s) => a + s.report.months.reduce((b, m) => b + m.forecast_demand, 0), 0);
  ws.getCell(r, 4).value = g.skus.reduce((a, s) => a + s.report.months.reduce((b, m) => b + m.expected_transfer, 0), 0);
  ws.getCell(r, 7).value = g.skus.reduce((a, s) => a + s.report.months.reduce((b, m) => b + m.recommended_order, 0), 0);
  totalRow(ws, r, 9);
  r += 3;
  note(ws, r - 1, [
    `The earmark above (${earmark.toLocaleString('en-US')}) is the pool before this month's transfer is pulled; the first row of "Warehouse held for Amazon" is what remains after it.`,
  ], 9);

  // ── Sections 2–4: the same three numbers broken out per size — what the PO is written from.
  const sizeBlock = (heading: string, sub: string, bg: string,
    pick: (m: WearableExportSku['report']['months'][number]) => number, blankZeros: boolean) => {
    r = title(ws, r, heading, sub);
    const head = r;
    ws.getCell(head, 1).value = 'Product';
    ws.getCell(head, 2).value = 'Size';
    monthLabels.forEach((m, i) => { ws.getCell(head, i + 3).value = m; });
    ws.getCell(head, cols).value = '12-month total';
    headerRow(ws, head, bg);
    r++;
    const from = r;
    for (const s of g.skus) {
      ws.getCell(r, 1).value = s.label;
      ws.getCell(r, 2).value = g.sizeOf.get(s.label) ?? (g.isKit ? 'kit' : '—');
      let tot = 0;
      s.report.months.forEach((m, i) => {
        const v = pick(m); tot += v;
        ws.getCell(r, i + 3).value = blankZeros && v === 0 ? null : v;
      });
      ws.getCell(r, cols).value = tot;
      r++;
    }
    bodyBlock(ws, from, r - 1, cols);
    for (let i = from; i < r; i++) ws.getCell(i, 2).font = { name: BODY, size: 10, color: { argb: MUTED } };
    ws.getCell(r, 1).value = groupLabel(g);
    ws.getCell(r, 2).value = g.isKit ? '' : `${g.skus.length} sizes`;
    let grand = 0;
    monthLabels.forEach((_, i) => {
      const v = g.skus.reduce((a, s) => a + pick(s.report.months[i]), 0);
      grand += v;
      ws.getCell(r, i + 3).value = blankZeros && v === 0 ? null : v;
    });
    ws.getCell(r, cols).value = grand;
    totalRow(ws, r, cols);
    r += 3;
  };

  sizeBlock('China order to place — by size', 'The breakdown the factory PO is written from.', PURPLE,
    m => m.recommended_order, true);
  sizeBlock('Expected to sell — by size', 'What each size is forecast to sell on Amazon per month.', TEAL,
    m => m.forecast_demand, false);
  sizeBlock('Ships warehouse → FBA — by size', 'The monthly pull on the warehouse per size (fortnightly dates are on the transfers tab).', OLIVE,
    m => m.expected_transfer, true);
}
