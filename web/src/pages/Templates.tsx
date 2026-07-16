import React, { useEffect, useState } from 'react';
import { api, fmtInt } from '../api.ts';
import { toast } from '../components/ui.tsx';

// [key, label, plain-English explanation, group]
const PARAM_LABELS: [string, string, string, 'china' | 'fba' | 'target'][] = [
  ['production_days', 'Production at factory', 'Days the manufacturer needs to make the order after you place the PO.', 'china'],
  ['transit_days', 'Freight transit', 'Shipping time from the factory to your US warehouse (ocean, air, etc.).', 'china'],
  ['customs_receiving_days', 'Customs & receiving', 'Days to clear customs and book the goods into your warehouse as usable stock.', 'china'],
  ['fba_ship_checkin_days', 'Warehouse → FBA', 'Days to pick, pack, ship, and have Amazon check the units in as sellable (via your prep/3PL). ~5 weeks for QALO.', 'fba'],
  ['review_period_fba_days', 'FBA shipment cadence', 'How often you send shipments to FBA — a shipment must last until the next one.', 'fba'],
  ['review_period_po_days', 'China PO cadence', 'How often you place orders with the manufacturer — an order must last until the next one.', 'china'],
  ['safety_days', 'Safety stock', 'Extra days of buffer to absorb demand spikes and delays, so a bad week doesn’t cause a stockout.', 'target'],
  ['fba_target_cover_days', 'FBA goal', 'How many days of stock to hold at Amazon. Each shipment brings FBA back up to this as it lands — the tool subtracts the sales during shipping so it arrives on-goal, not short. 90 = 3 months.', 'target'],
  ['warehouse_buffer_days', 'Warehouse reserve', 'Days of stock to keep at your own warehouse between China arrivals. It throttles routine shipments only — if Amazon would run dry, the tool ships the reserve too (being in stock at Amazon always comes first). 30 = 1 month.', 'target'],
  ['target_cover_days', 'Overstock ceiling', 'The most total stock (Amazon + warehouse + in transit + on order) you’re willing to hold before a product is flagged OVERSTOCK. Floored at the total the system genuinely needs to hold the FBA goal: FBA goal + warehouse→FBA transit + reserve + China lead + ½ PO cycle. Set it lower and the tool plans with that floor so healthy stock is never mislabeled.', 'target'],
];

export function Templates({ refresh }: { refresh: () => void }) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [edits, setEdits] = useState<Record<number, any>>({});
  const [settings, setSettings] = useState<any | null>(null);
  const [settingsForm, setSettingsForm] = useState<any>({});

  const load = () => Promise.all([
    api.get<{ templates: any[]; active_template_id: number }>('/api/templates'),
    api.get<any>('/api/settings'),
  ]).then(([t, s]) => {
    setTemplates(t.templates);
    setActiveId(t.active_template_id);
    setSettings(s);
    setSettingsForm({
      w7: s.velocity_weights.w7, w30: s.velocity_weights.w30, w60: s.velocity_weights.w60, w90: s.velocity_weights.w90,
      growth: s.global_growth_multiplier, order_soon: s.order_soon_days, overstock: s.overstock_factor,
      stockout_correction: s.stockout_correction,
    });
    setEdits({});
  });
  useEffect(() => { load(); }, []);

  async function activate(id: number) {
    try {
      const res = await api.post<{ before: any; after: any }>(`/api/templates/${id}/activate`);
      if (res.before && res.after) {
        toast(`Active template switched — Ship now: ${res.before.ship_skus} → ${res.after.ship_skus} SKUs · PO: ${fmtInt(res.before.po_units_total)} → ${fmtInt(res.after.po_units_total)} units`);
      } else {
        toast('Active template switched.');
      }
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  async function preview(id: number) {
    try {
      const res = await api.get<{ before: any; after: any }>(`/api/templates/${id}/preview`);
      toast(`If activated — Ship now: ${res.before.ship_skus} → ${res.after.ship_skus} SKUs · PO units: ${fmtInt(res.before.po_units_total)} → ${fmtInt(res.after.po_units_total)} · Critical: ${res.before.critical} → ${res.after.critical}`);
    } catch (err: any) { toast(err.message); }
  }

  async function save(t: any) {
    const e = edits[t.id];
    if (!e) return;
    try {
      await api.patch(`/api/templates/${t.id}`, { name: e.name, notes: e.notes, params: e.params });
      toast('Template saved — recommendations recomputed.');
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  async function duplicate(t: any) {
    const name = window.prompt('Name for the copy:', `${t.name} (copy)`);
    if (!name) return;
    try {
      await api.post('/api/templates', { name, notes: t.notes, params: t.params });
      toast('Template created.');
      load();
    } catch (err: any) { toast(err.message); }
  }

  async function remove(t: any) {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try { await api.del(`/api/templates/${t.id}`); toast('Deleted.'); load(); } catch (err: any) { toast(err.message); }
  }

  async function saveSettings() {
    const f = settingsForm;
    try {
      await api.patch('/api/settings', {
        velocity_weights: { w7: Number(f.w7), w30: Number(f.w30), w60: Number(f.w60), w90: Number(f.w90) },
        global_growth_multiplier: Number(f.growth),
        order_soon_days: Number(f.order_soon),
        overstock_factor: Number(f.overstock),
        stockout_correction: !!f.stockout_correction,
      });
      toast('Settings saved — recommendations recomputed.');
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  const weightSum = ['w7', 'w30', 'w60', 'w90'].reduce((s, k) => s + (Number(settingsForm[k]) || 0), 0);

  return (
    <div className="page">
      <h1>Templates & Settings</h1>
      <div className="h-sub">Lead-time scenarios (ocean, air, Chinese New Year…) and how the sales rate is calculated. One template is active globally; any SKU can override it.</div>

      <h2>Sales rate</h2>
      <div className="card" style={{ padding: 16, marginBottom: 20 }}>
        {settings && (
          <>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {(['w7', 'w30', 'w60', 'w90'] as const).map(k => (
                <label key={k} style={{ fontSize: 12 }}>Weight — last {k.slice(1)} days<br />
                  <input className="field num" type="number" step="0.05" min="0" max="1" style={{ width: 110 }}
                    value={settingsForm[k] ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, [k]: e.target.value }))} /></label>
              ))}
              <div className="mono" style={{ fontSize: 12, color: Math.abs(weightSum - 1) > 0.001 ? 'var(--stockout)' : 'var(--ok)', paddingBottom: 8 }}>
                Σ = {weightSum.toFixed(2)} {Math.abs(weightSum - 1) > 0.001 ? '(must equal 1.00)' : '✓'}
              </div>
            </div>
            <div className="field-help">How much each recent sales window counts toward the daily sales rate. Heavier recent windows react faster to change; heavier long windows smooth out blips. Must add to 1.00.</div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 18, alignItems: 'flex-start' }}>
              <label style={{ fontSize: 12 }}>Growth multiplier<br />
                <input className="field num" type="number" step="0.05" min="0.1" style={{ width: 110 }}
                  value={settingsForm.growth ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, growth: e.target.value }))} />
                <div className="field-help" style={{ maxWidth: 180 }}>Scale demand for growth. 1.0 = sales as-is; 1.2 = plan for 20% more.</div></label>
              <label style={{ fontSize: 12 }}>“Order soon” window (days)<br />
                <input className="field num" type="number" style={{ width: 110 }}
                  value={settingsForm.order_soon ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, order_soon: e.target.value }))} />
                <div className="field-help" style={{ maxWidth: 180 }}>Give a product an early “order soon” heads-up this many days before it would need its next shipment.</div></label>
              <label style={{ fontSize: 12 }}>Overstock at ✕ ceiling<br />
                <input className="field num" type="number" step="0.1" min="1" style={{ width: 110 }}
                  value={settingsForm.overstock ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, overstock: e.target.value }))} />
                <div className="field-help" style={{ maxWidth: 180 }}>Flag as overstocked above this multiple of the overstock ceiling (1.5 = 50% over).</div></label>
              <button className="btn primary" style={{ marginTop: 18 }} onClick={saveSettings} disabled={Math.abs(weightSum - 1) > 0.001}>Save settings</button>
            </div>
            <label style={{ fontSize: 12.5, marginTop: 14, display: 'flex', gap: 8, alignItems: 'flex-start', maxWidth: 640 }}>
              <input type="checkbox" style={{ marginTop: 2 }} checked={!!settingsForm.stockout_correction}
                onChange={e => { setSettingsForm((f: any) => ({ ...f, stockout_correction: e.target.checked })); }} />
              <span>
                <b>Correct the sales rate for out-of-stock periods</b> (recommended). When a product is out of stock, Amazon's
                recent sales look artificially low because it couldn't sell — so it would get under-ordered and stock out again.
                With this on, the sales rate uses the item's best in-stock rate instead. Corrected products show a{' '}
                <span className="flag">stockout corrected</span> tag. Use “Save settings” above to apply.
              </span>
            </label>
          </>
        )}
      </div>

      <h2>Lead-time templates</h2>
      <div className="card glossary" style={{ marginBottom: 16, padding: '14px 16px' }}>
        <div className="wl-title" style={{ marginBottom: 10 }}>What these settings mean</div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: '0 0 12px', maxWidth: '92ch', lineHeight: 1.6 }}>
          The tool plays each product’s sales and your real lead times <b>forward day by day</b> and recommends the
          amount that keeps Amazon and your warehouse from dropping too low before the next shipment or order can
          arrive. Two legs: it <b>ships from your warehouse to Amazon</b> (arriving after the warehouse→FBA time) and
          <b> orders from China to your warehouse</b> (arriving after the China lead time). These settings are those
          lead times, how often you act, and how much stock you want to hold at each place.
        </p>
        <div className="glossary-grid">
          {PARAM_LABELS.map(([k, label, desc]) => (
            <div key={k}><span className="g-term">{label}</span><span className="g-def">{desc}</span></div>
          ))}
        </div>
      </div>
      {templates.map(t => {
        const e = edits[t.id] ?? { name: t.name, notes: t.notes ?? '', params: { ...t.params } };
        const isActive = t.id === activeId;
        const num = (k: string) => Number(e.params[k]) || 0;
        const lead = num('production_days') + num('transit_days') + num('customs_receiving_days');
        // Mirror of the engine's derivedPoTargetDays (one conservation identity): FBA goal
        // + the warehouse→FBA transit leg + reserve + China lead + half a PO cycle.
        const derivedTotal = Math.round(
          Math.max(num('fba_target_cover_days'), num('fba_ship_checkin_days') + num('review_period_fba_days') + num('safety_days'))
          + num('fba_ship_checkin_days') + num('warehouse_buffer_days') + lead + num('review_period_po_days') / 2);
        const totalLow = num('target_cover_days') < derivedTotal;
        return (
          <div className="card" key={t.id} style={{ marginBottom: 14, outline: isActive ? '2px solid var(--ink)' : undefined }}>
            <div className="card-head">
              <input className="field" style={{ fontWeight: 650, width: 240 }} value={e.name}
                onChange={ev => setEdits(m => ({ ...m, [t.id]: { ...e, name: ev.target.value } }))} />
              {isActive && <span className="badge" style={{ ['--b-c' as any]: 'var(--ok)', ['--b-bg' as any]: 'var(--ok-bg)' }}>Active</span>}
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                China lead {lead}d · warehouse→FBA {e.params.fba_ship_checkin_days}d · {e.params.fba_target_cover_days}d FBA goal + {e.params.warehouse_buffer_days}d reserve · overstock ≥ {Math.round((Number(settingsForm.overstock) || 1.5) * Math.max(num('target_cover_days'), derivedTotal))}d
              </span>
              <div className="spacer" />
              {!isActive && <button className="btn sm" onClick={() => preview(t.id)}>Preview impact</button>}
              {!isActive && <button className="btn sm primary" onClick={() => activate(t.id)}>Set active</button>}
              <button className="btn sm" onClick={() => duplicate(t)}>Duplicate</button>
              {edits[t.id] && <button className="btn sm primary" onClick={() => save(t)}>Save</button>}
              {!t.is_builtin && !isActive && <button className="btn sm danger" onClick={() => remove(t)}>Delete</button>}
            </div>
            <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px 16px' }}>
              {PARAM_LABELS.map(([k, label, desc]) => (
                <label key={k} style={{ fontSize: 11.5 }} title={desc}>{label}<br />
                  <input className="field num" type="number" min={0} style={{ width: '100%' }}
                    value={e.params[k] ?? 0}
                    onChange={ev => setEdits(m => ({ ...m, [t.id]: { ...e, params: { ...e.params, [k]: ev.target.value } } }))} />
                </label>
              ))}
            </div>
            {totalLow && (
              <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--muted)' }}>
                Overstock ceiling ({num('target_cover_days')}d) is below the {derivedTotal}d your pipeline normally
                holds (FBA goal + warehouse reserve + China lead + ½ PO cycle), so the tool uses {derivedTotal}d as the
                floor — healthy stock won’t be mislabeled overstock. Set it above {derivedTotal}d only to allow extra headroom.
              </div>
            )}
            {t.notes && !edits[t.id] && <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--muted)' }}>{t.notes}</div>}
          </div>
        );
      })}
    </div>
  );
}
