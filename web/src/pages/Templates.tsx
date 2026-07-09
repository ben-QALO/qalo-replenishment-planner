import React, { useEffect, useState } from 'react';
import { api, fmtInt } from '../api.ts';
import { toast } from '../components/ui.tsx';

const PARAM_LABELS: [string, string][] = [
  ['production_days', 'Production at factory'],
  ['transit_days', 'Freight transit'],
  ['customs_receiving_days', 'Customs + US receiving'],
  ['fba_ship_checkin_days', 'Warehouse → FBA live'],
  ['safety_days', 'Safety stock'],
  ['target_cover_days', 'Target cover'],
  ['review_period_fba_days', 'FBA shipment cadence'],
  ['review_period_po_days', 'China PO cadence'],
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
      <div className="h-sub">Lead-time scenarios (ocean, air, Chinese New Year…) and the velocity model. One template is active globally; any SKU can override it.</div>

      <h2>Velocity model</h2>
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
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14, alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12 }}>Growth multiplier (global)<br />
                <input className="field num" type="number" step="0.05" min="0.1" style={{ width: 110 }}
                  value={settingsForm.growth ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, growth: e.target.value }))} />
              </label>
              <label style={{ fontSize: 12 }}>"Order soon" warning window (days)<br />
                <input className="field num" type="number" style={{ width: 110 }}
                  value={settingsForm.order_soon ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, order_soon: e.target.value }))} /></label>
              <label style={{ fontSize: 12 }}>Overstock at × target cover<br />
                <input className="field num" type="number" step="0.1" min="1" style={{ width: 110 }}
                  value={settingsForm.overstock ?? ''} onChange={e => setSettingsForm((f: any) => ({ ...f, overstock: e.target.value }))} /></label>
              <button className="btn primary" onClick={saveSettings} disabled={Math.abs(weightSum - 1) > 0.001}>Save settings</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
              Velocity = (w7 × 7-day rate) + (w30 × 30-day rate) + (w60 × 60-day rate) + (w90 × 90-day rate), then × growth multiplier.
              Heavier recent weights react faster to change; heavier long weights smooth out spikes.
            </div>
            <label style={{ fontSize: 12.5, marginTop: 14, display: 'flex', gap: 8, alignItems: 'flex-start', maxWidth: 640 }}>
              <input type="checkbox" style={{ marginTop: 2 }} checked={!!settingsForm.stockout_correction}
                onChange={e => { setSettingsForm((f: any) => ({ ...f, stockout_correction: e.target.checked })); }} />
              <span>
                <b>Correct velocity for out-of-stock periods</b> (recommended). When a SKU is out of stock, Amazon's
                recent sales look artificially low because it couldn't sell — so it would get under-ordered and stock out again.
                With this on, velocity uses the item's best in-stock sales rate instead. Corrected SKUs show a{' '}
                <span className="flag">stockout corrected</span> tag. Use “Save settings” above to apply.
              </span>
            </label>
          </>
        )}
      </div>

      <h2>Lead-time templates</h2>
      {templates.map(t => {
        const e = edits[t.id] ?? { name: t.name, notes: t.notes ?? '', params: { ...t.params } };
        const isActive = t.id === activeId;
        const lead = Number(e.params.production_days) + Number(e.params.transit_days) + Number(e.params.customs_receiving_days);
        return (
          <div className="card" key={t.id} style={{ marginBottom: 14, outline: isActive ? '2px solid var(--ink)' : undefined }}>
            <div className="card-head">
              <input className="field" style={{ fontWeight: 650, width: 240 }} value={e.name}
                onChange={ev => setEdits(m => ({ ...m, [t.id]: { ...e, name: ev.target.value } }))} />
              {isActive && <span className="badge" style={{ ['--b-c' as any]: 'var(--ok)', ['--b-bg' as any]: 'var(--ok-bg)' }}>Active</span>}
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>China lead: {lead} days</span>
              <div className="spacer" />
              {!isActive && <button className="btn sm" onClick={() => preview(t.id)}>Preview impact</button>}
              {!isActive && <button className="btn sm primary" onClick={() => activate(t.id)}>Set active</button>}
              <button className="btn sm" onClick={() => duplicate(t)}>Duplicate</button>
              {edits[t.id] && <button className="btn sm primary" onClick={() => save(t)}>Save</button>}
              {!t.is_builtin && !isActive && <button className="btn sm danger" onClick={() => remove(t)}>Delete</button>}
            </div>
            <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px 16px' }}>
              {PARAM_LABELS.map(([k, label]) => (
                <label key={k} style={{ fontSize: 11.5 }}>{label}<br />
                  <input className="field num" type="number" min={0} style={{ width: '100%' }}
                    value={e.params[k]}
                    onChange={ev => setEdits(m => ({ ...m, [t.id]: { ...e, params: { ...e.params, [k]: ev.target.value } } }))} />
                </label>
              ))}
            </div>
            {t.notes && !edits[t.id] && <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--muted)' }}>{t.notes}</div>}
          </div>
        );
      })}
    </div>
  );
}
