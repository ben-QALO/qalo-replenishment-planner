import type { FastifyInstance } from 'fastify';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, bumpRevision, nowIso, today, DATA_DIR } from '../db/connection.ts';
import { currentRecommendations, latestSnapshot, getSetting, templateParamsById } from '../assemble.ts';
import { toCsv } from '../export/csv.ts';

interface PlanLineInput { sku: string; qty_recommended: number; qty_final: number; }

export function planRoutes(app: FastifyInstance): void {
  /**
   * Create a plan from reviewed queue rows and return its CSV.
   * kind 'fba_shipment' → paste-ready "Merchant SKU,Quantity" (detailed variant optional).
   * kind 'china_po'     → PO proposal with dates and cover math.
   */
  app.post('/api/plans', (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; lines?: PlanLineInput[]; detailed?: boolean };
    if ((b.kind !== 'fba_shipment' && b.kind !== 'china_po') || !Array.isArray(b.lines) || b.lines.length === 0) {
      return reply.code(400).send({ error: 'kind (fba_shipment|china_po) and lines[] required' });
    }
    const db = getDb();
    const todayStr = today();
    const output = currentRecommendations(db, todayStr);
    if (!output) return reply.code(409).send({ error: 'no snapshot imported yet' });
    const byResult = new Map(output.results.map(r => [r.sku, r]));

    const lines = b.lines
      .map(l => ({ sku: l.sku, qty_recommended: Math.round(Number(l.qty_recommended) || 0), qty_final: Math.round(Number(l.qty_final)) }))
      .filter(l => l.sku && Number.isFinite(l.qty_final) && l.qty_final > 0);
    if (lines.length === 0) return reply.code(400).send({ error: 'no lines with a positive final quantity' });

    const snapshot = latestSnapshot(db);
    const activeId = Number(getSetting(db, 'active_template_id') ?? 1);
    const template = templateParamsById(db, activeId);
    const now = nowIso();

    let csv: string;
    let filename: string;
    if (b.kind === 'fba_shipment') {
      filename = `fba-shipment-plan-${todayStr}.csv`;
      if (b.detailed) {
        const rows: unknown[][] = [['Merchant SKU', 'Quantity', 'Product Name', 'Case Pack', 'Cases', 'Velocity (u/day)', 'FBA Days Cover']];
        for (const l of lines) {
          const r = byResult.get(l.sku);
          const casePack = r && (db.prepare('SELECT case_pack FROM skus WHERE sku = ?').get(l.sku) as any)?.case_pack;
          rows.push([l.sku, l.qty_final, r?.title ?? '', casePack ?? '', casePack ? Math.ceil(l.qty_final / casePack) : '', r?.velocity ?? '', r?.fba_days_cover ?? '']);
        }
        csv = toCsv(rows);
      } else {
        csv = toCsv([['Merchant SKU', 'Quantity'], ...lines.map(l => [l.sku, l.qty_final])]);
      }
    } else {
      filename = `china-po-proposal-${todayStr}.csv`;
      const rows: unknown[][] = [[
        'SKU', 'Product Name', 'Recommended Qty', 'Final Qty', 'MOQ', 'Case Pack',
        'Velocity (u/day)', 'Pipeline Days Cover', 'Projected Stockout', 'Need-By Arrival', 'Place-By Date', 'Status', 'Flags',
      ]];
      for (const l of lines) {
        const r = byResult.get(l.sku);
        const s = db.prepare('SELECT moq, case_pack FROM skus WHERE sku = ?').get(l.sku) as any;
        rows.push([
          l.sku, r?.title ?? '', l.qty_recommended, l.qty_final, s?.moq ?? '', s?.case_pack ?? '',
          r?.velocity ?? '', r?.pipeline_days_cover ?? '', r?.projected_stockout_date ?? '',
          r?.need_by_arrival ?? '', r?.place_by_date ?? '', r?.status ?? '', (r?.flags ?? []).join(' '),
        ]);
      }
      csv = toCsv(rows);
    }

    const exportPath = join(DATA_DIR, 'exports', filename);
    writeFileSync(exportPath, csv);

    let planId = 0;
    const run = db.transaction(() => {
      const res = db.prepare(`INSERT INTO plans (kind, created_at, template_params, snapshot_id, exported_at, export_filename)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(b.kind, now, JSON.stringify({ template_id: activeId, name: template?.name, params: template?.params }), snapshot?.id ?? null, now, filename);
      planId = Number(res.lastInsertRowid);
      const stmt = db.prepare('INSERT INTO plan_lines (plan_id, sku, qty_recommended, qty_final) VALUES (?, ?, ?, ?)');
      for (const l of lines) stmt.run(planId, l.sku, l.qty_recommended, l.qty_final);
    });
    run();
    bumpRevision();

    return { ok: true, id: planId, filename, csv, line_count: lines.length, total_units: lines.reduce((s, l) => s + l.qty_final, 0) };
  });

  app.get('/api/plans', () => {
    const db = getDb();
    const plans = db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT 50').all() as any[];
    const lines = db.prepare('SELECT * FROM plan_lines').all() as any[];
    for (const p of plans) {
      p.template_params = p.template_params ? JSON.parse(p.template_params) : null;
      p.lines = lines.filter(l => l.plan_id === p.id);
    }
    return { plans };
  });

  /** After exporting an FBA shipment plan: deduct shipped units from warehouse on-hand. */
  app.post('/api/plans/:id/deduct-warehouse', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const plan = db.prepare("SELECT * FROM plans WHERE id = ? AND kind = 'fba_shipment'").get(id) as any;
    if (!plan) return reply.code(404).send({ error: 'shipment plan not found' });
    const lines = db.prepare('SELECT sku, qty_final FROM plan_lines WHERE plan_id = ?').all(id) as any[];
    const now = nowIso();
    const run = db.transaction(() => {
      const stmt = db.prepare(`UPDATE warehouse_inventory SET qty_on_hand = MAX(0, qty_on_hand - ?), updated_at = ?, updated_via = 'shipment' WHERE sku = ?`);
      for (const l of lines) stmt.run(l.qty_final, now, l.sku);
    });
    run();
    bumpRevision();
    return { ok: true, deducted: lines.length };
  });

  /** Turn a PO proposal plan into a draft purchase order. */
  app.post('/api/plans/:id/create-po', (req, reply) => {
    const id = Number((req.params as any).id);
    const db = getDb();
    const plan = db.prepare("SELECT * FROM plans WHERE id = ? AND kind = 'china_po'").get(id) as any;
    if (!plan) return reply.code(404).send({ error: 'PO proposal plan not found' });
    const lines = db.prepare('SELECT sku, qty_final FROM plan_lines WHERE plan_id = ?').all(id) as any[];
    const now = nowIso();
    let poId = 0;
    const run = db.transaction(() => {
      const res = db.prepare(`INSERT INTO purchase_orders (po_number, status, notes, created_at, updated_at)
        VALUES (NULL, 'draft', ?, ?, ?)`)
        .run(`Created from PO proposal #${id} (${plan.created_at.slice(0, 10)})`, now, now);
      poId = Number(res.lastInsertRowid);
      const stmt = db.prepare('INSERT INTO po_lines (po_id, sku, qty_ordered, qty_received) VALUES (?, ?, ?, 0)');
      for (const l of lines) stmt.run(poId, l.sku, l.qty_final);
    });
    run();
    bumpRevision();
    return { ok: true, po_id: poId };
  });

  /** Full status export — every SKU, every computed column. */
  app.get('/api/exports/status.csv', (req, reply) => {
    const db = getDb();
    const output = currentRecommendations(db, today());
    if (!output) return reply.code(409).send({ error: 'no snapshot imported yet' });
    const rows: unknown[][] = [[
      'SKU', 'Product Name', 'Status', 'Classification', 'Flags',
      'Velocity (u/day)', 'Velocity Source', 'Confidence', 'Growth Multiplier',
      'FBA Available', 'FBA Reserved', 'FBA Inbound', 'FBA Position',
      'Warehouse On Hand', 'Open PO Units', 'Total Pipeline',
      'FBA Days Cover', 'Pipeline Days Cover', 'Projected Stockout',
      'Recommended Ship Qty', 'Recommended PO Qty', 'Need-By Arrival', 'Place-By Date',
      'Amazon Days of Supply', 'Amazon Min Level', 'Template', 'Why',
    ]];
    for (const r of output.results) {
      rows.push([
        r.sku, r.title, r.status, r.classification, r.flags.join(' '),
        r.velocity ?? '', r.velocity_source, r.velocity_confidence, r.growth_multiplier,
        r.fba_available, r.fba_reserved, r.fba_inbound, r.fba_position,
        r.warehouse_on_hand, r.open_po_units, r.total_pipeline,
        r.fba_days_cover ?? '', r.pipeline_days_cover ?? '', r.projected_stockout_date ?? '',
        r.recommended_ship_qty, r.recommended_po_qty, r.need_by_arrival ?? '', r.place_by_date ?? '',
        r.amazon_days_of_supply ?? '', r.amazon_min_inventory_level ?? '', r.template_label, r.why,
      ]);
    }
    const csv = toCsv(rows);
    const filename = `full-status-${today()}.csv`;
    writeFileSync(join(DATA_DIR, 'exports', filename), csv);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return csv;
  });
}
