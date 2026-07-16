import React, { useEffect, useState } from 'react';
import { api, fmtInt, fmtNum, type SkuResult } from '../api.ts';
import { StatusBadge, Flags, toast } from '../components/ui.tsx';
import { PlanChart, HistoryChart, type PlanData, type HistoryRow } from '../components/charts.tsx';

const CLASSES = ['unclassified', 'replenishable', 'watch', 'discontinued', 'ignore'];
const PARAM_LABELS: Record<string, string> = {
  production_days: 'Production (days)',
  transit_days: 'Transit (days)',
  customs_receiving_days: 'Customs + receiving (days)',
  fba_ship_checkin_days: 'FBA ship + check-in (days)',
  safety_days: 'Safety stock (days)',
  fba_target_cover_days: 'FBA target (days)',
  warehouse_buffer_days: 'Warehouse buffer (days)',
  target_cover_days: 'Total target (days)',
  review_period_fba_days: 'FBA review cycle (days)',
  review_period_po_days: 'PO review cycle (days)',
};

interface Detail {
  result: SkuResult | null;
  settings: any;
  history: HistoryRow[];
  poLines: any[];
  planLines: any[];
  warehouse: { qty_on_hand: number; updated_at: string; updated_via: string } | null;
  plan: PlanData | null;
}

export function SkuDetail({ sku, today, templates, refresh }: {
  sku: string; today: string;
  templates: { id: number; name: string }[];
  refresh: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const load = () => api.get<Detail>(`/api/skus/${encodeURIComponent(sku)}`).then(d => {
    setDetail(d);
    const s = d.settings ?? {};
    setForm({
      classification: s.classification ?? 'unclassified',
      case_pack: s.case_pack ?? '',
      moq: s.moq ?? '',
      order_multiple: s.order_multiple ?? '',
      velocity_override: s.velocity_override ?? '',
      growth_multiplier: s.growth_multiplier ?? '',
      template_override_id: s.template_override_id ?? '',
      notes: s.notes ?? '',
    });
    const po = s.param_overrides ?? {};
    setOverrides(Object.fromEntries(Object.keys(PARAM_LABELS).map(k => [k, po[k] ?? ''])));
    setDirty(false);
  });

  useEffect(() => { load(); }, [sku]);

  async function save() {
    const patch: Record<string, unknown> = {
      classification: form.classification,
      case_pack: form.case_pack === '' ? null : Number(form.case_pack),
      moq: form.moq === '' ? null : Number(form.moq),
      order_multiple: form.order_multiple === '' ? null : Number(form.order_multiple),
      velocity_override: form.velocity_override === '' ? null : Number(form.velocity_override),
      growth_multiplier: form.growth_multiplier === '' ? null : Number(form.growth_multiplier),
      template_override_id: form.template_override_id === '' ? null : Number(form.template_override_id),
      notes: form.notes || null,
      param_overrides: Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
    };
    try {
      await api.patch(`/api/skus/${encodeURIComponent(sku)}`, patch);
      toast('Saved.');
      await load();
      refresh();
    } catch (err: any) { toast(err.message); }
  }

  if (!detail) return <div className="empty">Loading…</div>;
  const r = detail.result;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm(f => ({ ...f, [k]: e.target.value })); setDirty(true);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="sku-code" style={{ fontSize: 17 }}>{sku}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 2, maxWidth: 460 }}>{r?.title ?? detail.settings?.title}</div>
        </div>
        {r && <StatusBadge status={r.status} />}
      </div>

      {r && (
        <>
          <div className="why" style={{ margin: '14px 0' }}>{r.why}</div>
          <div style={{ marginBottom: 10 }}><Flags flags={r.flags} max={8} /></div>

          <div className="grid-2">
            <div className="card"><div className="card-head"><h3>Stock on hand</h3></div>
              <div style={{ padding: '12px 16px' }}>
                <dl className="kv">
                  <dt>Available at FBA</dt><dd>{fmtInt(r.fba_available)}</dd>
                  <dt>Reserved</dt><dd>{fmtInt(r.fba_reserved)}</dd>
                  <dt>Inbound (Amazon)</dt><dd>{fmtInt(r.fba_inbound)}</dd>
                  <dt>In transit to FBA</dt><dd>{fmtInt(r.in_transit_to_fba)}{r.in_transit_to_fba > 0 && r.in_transit_to_fba > r.fba_inbound ? ' (awaiting reconcile)' : ''}</dd>
                  <dt>Warehouse usable</dt><dd>{fmtInt(r.warehouse_on_hand)}</dd>
                  <dt>On open POs</dt><dd>{fmtInt(r.open_po_units)}</dd>
                  <dt>Total pipeline</dt><dd><b>{fmtInt(r.total_pipeline)}</b></dd>
                  <dt>Days of stock at Amazon</dt><dd>{fmtNum(r.fba_days_cover, 0)} days</dd>
                  <dt>Days of stock across pipeline</dt><dd>{fmtNum(r.pipeline_days_cover, 0)} days</dd>
                  <dt>Runs out (if you do nothing)</dt><dd style={{ color: r.projected_stockout_date ? 'var(--stockout)' : undefined }}>{r.projected_stockout_date ?? 'not within 6 months'}</dd>
                  <dt>Soonest new stock can land</dt><dd>{r.earliest_fba_arrival ?? '—'}</dd>
                  <dt>Template</dt><dd>{r.template_label}</dd>
                  <dt>Amazon days of supply</dt><dd>{fmtNum(r.amazon_days_of_supply, 0)}</dd>
                </dl>
              </div>
            </div>

            <div className="card"><div className="card-head"><h3>Sales &amp; plan</h3></div>
              <div style={{ padding: '12px 16px' }}>
                <dl className="kv">
                  <dt>Sales rate used</dt><dd><b>{fmtNum(r.velocity, 2)}</b> sold/day ({r.velocity_source}, {r.velocity_confidence})</dd>
                  <dt>Sold/day, last 7 days</dt><dd>{fmtNum(r.window_rates.r7, 2)}</dd>
                  <dt>Sold/day, last 30 days</dt><dd>{fmtNum(r.window_rates.r30, 2)}</dd>
                  <dt>Sold/day, last 60 days</dt><dd>{fmtNum(r.window_rates.r60, 2)}</dd>
                  <dt>Sold/day, last 90 days</dt><dd>{fmtNum(r.window_rates.r90, 2)}</dd>
                  <dt>Growth multiplier</dt><dd>×{r.growth_multiplier}</dd>
                  <dt>Ship to Amazon now</dt><dd style={{ color: 'var(--ship)' }}><b>{r.recommended_ship_qty || '—'}</b></dd>
                  {r.transfer_shortage > 0 && (
                    <><dt>— to hit goal you'd ship</dt><dd>{fmtInt(r.transfer_required)}</dd>
                      <dt>— warehouse can spare</dt><dd>{fmtInt(r.transfer_safe)}</dd>
                      <dt>— short by</dt><dd style={{ color: 'var(--stockout)' }}><b>{fmtInt(r.transfer_shortage)}</b></dd></>
                  )}
                  <dt>Order from China now</dt><dd style={{ color: 'var(--po)' }}><b>{r.recommended_po_qty || '—'}</b></dd>
                  <dt>Place order by</dt><dd>{r.place_by_date ?? '—'}</dd>
                  <dt>Lands at warehouse by</dt><dd>{r.need_by_arrival ?? '—'}</dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head"><h3>The plan — stock over the next 6 months if you follow the recommendations</h3></div>
            <div className="chart-wrap">
              {detail.plan ? (
                <PlanChart r={r} today={today} plan={detail.plan} />
              ) : (
                <div className="empty">No plan to project — this product needs a sales rate and a “replenish” classification first.</div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>Stock history</h3></div>
        <div className="chart-wrap">
          <HistoryChart rows={detail.history.map(h => ({ ...h, inbound: (h as any).inbound ?? 0 }))} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Settings</h3><div className="spacer" />
          <button className="btn sm primary" disabled={!dirty} onClick={save}>Save changes</button>
        </div>
        <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
          <label style={{ fontSize: 12 }}>Classification<br />
            <select className="field" style={{ width: '100%' }} value={form.classification} onChange={set('classification')}>
              {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          <label style={{ fontSize: 12 }}>Lead-time template override<br />
            <select className="field" style={{ width: '100%' }} value={form.template_override_id} onChange={set('template_override_id')}>
              <option value="">— inherit global —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
          <label style={{ fontSize: 12 }}>Case pack (units/carton)<br />
            <input className="field num" style={{ width: '100%' }} type="number" value={form.case_pack} onChange={set('case_pack')} placeholder="—" /></label>
          <label style={{ fontSize: 12 }}>MOQ (China)<br />
            <input className="field num" style={{ width: '100%' }} type="number" value={form.moq} onChange={set('moq')} placeholder="—" /></label>
          <label style={{ fontSize: 12 }}>Order multiple<br />
            <input className="field num" style={{ width: '100%' }} type="number" value={form.order_multiple} onChange={set('order_multiple')} placeholder="—" /></label>
          <label style={{ fontSize: 12 }}>Sales rate override (sold/day)<br />
            <input className="field num" style={{ width: '100%' }} type="number" step="any" value={form.velocity_override} onChange={set('velocity_override')} placeholder="use report data" /></label>
          <label style={{ fontSize: 12 }}>Growth multiplier<br />
            <input className="field num" style={{ width: '100%' }} type="number" step="any" value={form.growth_multiplier} onChange={set('growth_multiplier')} placeholder="inherit global" /></label>
          <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>Notes<br />
            <textarea className="field" style={{ width: '100%', minHeight: 44 }} value={form.notes} onChange={set('notes')} /></label>
        </div>
        <div className="card-head" style={{ borderTop: '1px solid var(--hairline)' }}><h3>Per-SKU parameter overrides <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(blank = inherit template)</span></h3></div>
        <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
          {Object.entries(PARAM_LABELS).map(([k, label]) => (
            <label key={k} style={{ fontSize: 12 }}>{label}<br />
              <input className="field num" style={{ width: '100%' }} type="number" value={overrides[k] ?? ''}
                onChange={e => { setOverrides(o => ({ ...o, [k]: e.target.value })); setDirty(true); }} placeholder="inherit" /></label>
          ))}
        </div>
      </div>

      {(detail.poLines.length > 0 || detail.planLines.length > 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h3>History on POs & plans</h3></div>
          <table className="data">
            <thead><tr><th className="plain">Type</th><th className="plain">Ref</th><th className="plain">Status / date</th><th className="num">Qty</th></tr></thead>
            <tbody>
              {detail.poLines.map((p, i) => (
                <tr key={`po${i}`}><td>China PO</td><td className="mono">{p.po_number ?? `#${p.id}`}</td>
                  <td>{p.status}{p.expected_arrival ? ` · ETA ${p.expected_arrival}` : ''}</td>
                  <td className="num">{fmtInt(p.qty_received)}/{fmtInt(p.qty_ordered)}</td></tr>
              ))}
              {detail.planLines.map((p, i) => (
                <tr key={`plan${i}`}><td>{p.kind === 'fba_shipment' ? 'FBA plan' : 'PO proposal'}</td>
                  <td className="mono">#{p.id}</td><td>{p.created_at?.slice(0, 10)}</td>
                  <td className="num">{fmtInt(p.qty_final)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
