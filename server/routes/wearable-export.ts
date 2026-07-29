// The smart-ring plan as an Excel workbook for the inventory-management team.
//
// The team that places the China POs does not plan for Amazon alone, and used to size orders from
// what the Amazon team expected to REQUEST over the following four months — which describes the shelf
// rather than the customer, and lags a ramp by the whole China lead. This export replaces that input:
// what to order per SKU per month, what to earmark for Amazon out of stock already held, what moves
// to FBA every fortnight, and the demand every one of those figures is derived from.

import type { FastifyInstance } from 'fastify';
import { getDb, today, DATA_DIR } from '../db/connection.ts';
import { currentRecommendations } from '../assemble.ts';
import { wearableInputs } from '../wearable-inputs.ts';
import { projectWearableSku } from '../../engine/wearable.ts';
import { buildWearableWorkbook, type WearableExportSku } from '../export/wearable-xlsx.ts';
import { addMonths, firstOfMonth, diffDays } from '../../engine/dates.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function wearableExportRoutes(app: FastifyInstance): void {
  app.get('/api/exports/wearable-plan.xlsx', async (req, reply) => {
    const db = getDb();
    const todayStr = today();
    const output = currentRecommendations(db, todayStr);
    if (!output) return reply.code(409).send({ error: 'no Amazon snapshot imported yet' });

    const w = wearableInputs(db, output, todayStr);
    if (!w) {
      return reply.code(409).send({
        error: 'Nothing to export yet. Tag your smart rings as WEARABLE and enter the yearly forecast first.',
      });
    }

    // 12 months, the same window the on-screen report covers. projectWearableSku simulates past the
    // horizon internally so the last months' orders are still sized from a real pull.
    const horizon = Math.max(0, diffDays(addMonths(firstOfMonth(todayStr), 12), todayStr));

    const skus: WearableExportSku[] = [];
    for (const r of output.results) {
      const report = r.wearable_report;
      const input = w.inputs.find(i => i.sku === r.sku);
      if (!report || !input) continue;
      const plan = projectWearableSku(w.inputs, w.forecast, todayStr, r.sku, horizon);
      if (!plan) continue;   // no forecast share (not selling, zero attach) — nothing to plan
      skus.push({
        sku: r.sku, label: r.qalo_sku || r.sku, title: r.title, role: input.role,
        report, plan,
        fba_available: r.fba_available, fba_coming: r.fba_coming,
        case_pack: input.case_pack ?? null, template: r.template,
      });
    }
    if (skus.length === 0) {
      return reply.code(409).send({ error: 'No smart-ring SKU has both a forecast share and a plan yet.' });
    }
    // Smart rings first (largest seller first), then the attach product — the order a reader expects.
    skus.sort((a, b) => Number(a.report.is_attach_product) - Number(b.report.is_attach_product)
      || b.report.forecast_run_rate_month - a.report.forecast_run_rate_month
      || a.label.localeCompare(b.label));

    const buf = await buildWearableWorkbook({
      skus, rollup: output.wearableRollup ?? null, today: todayStr,
      snapshotDate: output.snapshotDate ?? null, forecastYear: w.forecast.year,
    });

    const filename = `smart-ring-ordering-plan-${todayStr}.xlsx`;
    // Keep a copy alongside the other exports, so a file that was sent can be reproduced later.
    try { writeFileSync(join(DATA_DIR, 'exports', filename), buf); } catch { /* export copy is best-effort */ }

    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(buf);
  });
}
