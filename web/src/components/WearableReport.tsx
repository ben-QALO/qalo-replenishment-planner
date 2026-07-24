import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtInt, fmtNum, type SkuResult, type WearableRollup, type WearableMonth, type ForecastResponse } from '../api.ts';
import { toast, downloadCsv } from './ui.tsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyMonth = (ym: string) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };

// The informative WEARABLE ordering plan. Unlike CORE's prescriptive "order N now", this is a
// forecast-driven, rolling-12-month picture the team can read and act on: how many units they'll
// likely transfer to FBA each month, how many to order from China (timed to the ~90-day lead), and
// the ideal warehouse stock to hold *for Amazon* — plus forecast-vs-actual per variant.
export function WearableReport({ results, rollup, refresh, openSku }: {
  results: SkuResult[];
  rollup: WearableRollup | null;
  refresh: () => void;
  openSku: (sku: string) => void;
}) {
  // Smart rings first, then the sizing kit; only SKUs that actually carry a report.
  const rows = useMemo(() =>
    results.filter(r => r.wearable_report)
      .sort((a, b) => Number(a.wearable_report!.is_attach_product) - Number(b.wearable_report!.is_attach_product)
        || (b.velocity ?? 0) - (a.velocity ?? 0)),
    [results]);

  const [view, setView] = useState<string>('rollup');   // 'rollup' | a sku
  const [editing, setEditing] = useState(false);

  if (rows.length === 0) {
    return (
      <div className="empty">
        No smart-ring plan yet. Tag your smart rings as <b>WEARABLE · smart ring</b> (and the sizing kit as
        <b> WEARABLE · sizing kit</b>) on the SKU or All SKUs page, then enter the yearly forecast below.
        <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => setEditing(true)}>Enter forecast</button></div>
        {editing && <ForecastEditor onClose={() => setEditing(false)} refresh={refresh} />}
      </div>
    );
  }

  const monthsFor = (sku: string): WearableMonth[] =>
    sku === 'rollup' ? (rollup?.months ?? []) : (rows.find(r => r.sku === sku)?.wearable_report?.months ?? []);
  const shown = monthsFor(view);
  const lead = rows[0].wearable_report!.lead_months;

  function exportCsv() {
    const header = ['Month', 'Forecast demand', 'Expected transfer to FBA', 'China order to place', 'Order lands', 'Ideal warehouse for Amazon', 'Notes'];
    const label = view === 'rollup' ? 'all-smart-rings' : view;
    const lines = [header.join(',')];
    for (const m of shown) {
      lines.push([prettyMonth(m.month), m.forecast_demand, m.expected_transfer, m.recommended_order,
        prettyMonth(m.order_lands_month), m.ideal_wh_for_amazon,
        (m.flags ?? []).includes('FORECAST_EXTRAPOLATED') ? 'forecast reuses last year' : ''].join(','));
    }
    downloadCsv(`wearable-plan-${label}.csv`, lines.join('\n'));
  }

  return (
    <div className="wear">
      <div className="wear-intro">
        <p>
          A <b>planning report</b>, not a to-do list. It projects the next 12 months from your board forecast so the
          team can order ahead of the <b>~{rows[0].wearable_report!.lead_days}-day</b> China lead. Warehouse stock is
          shared across channels, so it's <b>not</b> used here — these are Amazon needs only. Transfers to FBA still
          run through the normal worksheet (the <b>Ship to FBA</b> tab).
        </p>
        <button className="btn sm" onClick={() => setEditing(e => !e)}>{editing ? 'Hide forecast' : 'Edit forecast'}</button>
      </div>

      {editing && <ForecastEditor onClose={() => setEditing(false)} refresh={refresh} />}

      {/* Per-variant: how the aggregate forecast splits, and how far current sales are from the forecast pace. */}
      <div className="wear-section-title">Variant split &amp; forecast vs actual</div>
      <table className="data wear-variants">
        <thead><tr>
          <th className="plain">Product</th>
          <th className="plain">Share of sales</th>
          <th className="plain num">Selling now /mo</th>
          <th className="plain num">Forecast /mo</th>
          <th className="plain num">To meet forecast</th>
        </tr></thead>
        <tbody>
          {rows.map(r => {
            const w = r.wearable_report!;
            const mult = w.multiplier;
            return (
              <tr key={r.sku}>
                <td>
                  <span className="sku-code" style={{ cursor: 'pointer' }} onClick={() => openSku(r.sku)}>{r.qalo_sku ?? r.sku}</span>
                  {w.is_attach_product && <span className="wear-tag">attach</span>}
                  <div className="cell-title" style={{ maxWidth: 240 }}>{r.title}</div>
                </td>
                <td>{w.is_attach_product
                  ? <span title="sizing kits per smart-ring sold">{fmtNum(w.attach_rate ?? 0, 2)}× attach</span>
                  : `${Math.round(w.variant_share * 100)}%`}</td>
                <td className="num">{fmtInt(w.actual_run_rate_month)}</td>
                <td className="num">{fmtInt(w.forecast_run_rate_month)}</td>
                <td className="num">{mult === null
                  ? <span style={{ color: 'var(--muted)' }}>no sales yet</span>
                  : <span className={mult > 1.05 ? 'wear-up' : mult < 0.95 ? 'wear-down' : ''}>{mult.toFixed(2)}×</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rollup?.total_multiplier != null && (
        <div className="wear-note">
          Overall you're selling at <b>{rollup.total_multiplier.toFixed(2)}×</b> vs the forecast pace
          {rollup.total_multiplier > 1.02 ? ' — forecast is ahead of current sales, plan to scale up.'
            : rollup.total_multiplier < 0.98 ? ' — current sales are ahead of forecast.'
            : ' — roughly on track.'}
        </div>
      )}

      {/* Monthly ordering plan. */}
      <div className="wear-section-title" style={{ marginTop: 20 }}>
        Monthly plan — next 12 months
        <div className="spacer" />
        <div className="segmented sm">
          <button className={view === 'rollup' ? 'on' : ''} onClick={() => setView('rollup')}>All</button>
          {rows.map(r => (
            <button key={r.sku} className={view === r.sku ? 'on' : ''} onClick={() => setView(r.sku)}>
              {(r.qalo_sku ?? r.sku).replace(/^R-/, '')}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={exportCsv}>Export CSV</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data wear-months">
          <thead><tr>
            <th className="plain">Month</th>
            <th className="plain num">Forecast demand</th>
            <th className="plain num">Transfer to FBA</th>
            <th className="plain num">Order from China</th>
            <th className="plain">Lands</th>
            <th className="plain num">Ideal WH for Amazon</th>
          </tr></thead>
          <tbody>
            {shown.map(m => (
              <tr key={m.month}>
                <td className="mono">{prettyMonth(m.month)}
                  {(m.flags ?? []).includes('FORECAST_EXTRAPOLATED') &&
                    <span className="wear-tag" title="No forecast entered for this month — reuses last year's same month">est.</span>}
                </td>
                <td className="num">{fmtInt(m.forecast_demand)}</td>
                <td className="num">{fmtInt(m.expected_transfer)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{m.recommended_order > 0 ? fmtInt(m.recommended_order) : '—'}</td>
                <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{prettyMonth(m.order_lands_month)}</td>
                <td className="num">{fmtInt(m.ideal_wh_for_amazon)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wear-note">
        <b>Order from China</b> is what to place that month so it lands ~{lead} months later (the lead time), sized to
        cover that landing month's transfers to FBA. <b>Ideal WH for Amazon</b> is the stock you'd ideally hold at the
        warehouse earmarked for Amazon — enough to bridge the lead time plus a monthly cycle and safety.
      </div>
    </div>
  );
}

// Twelve monthly inputs for the aggregate smart-ring forecast (Amazon-basis units).
function ForecastEditor({ onClose, refresh }: { onClose: () => void; refresh: () => void }) {
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [units, setUnits] = useState<number[]>(Array(12).fill(0));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ForecastResponse>('/api/forecast').then(f => { setYear(f.year); setUnits(f.monthlyUnits); }).catch(() => {});
  }, []);

  const total = units.reduce((a, c) => a + (Number(c) || 0), 0);

  async function save() {
    setBusy(true);
    try {
      await api.put('/api/forecast', { year, monthlyUnits: units.map(u => Math.max(0, Math.round(Number(u) || 0))) });
      toast(`Forecast saved for ${year} — ${fmtInt(total)} units across the year.`);
      refresh();
      onClose();
    } catch (err: any) { toast(`Save failed: ${err.message}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="wear-forecast card-inset">
      <div className="wear-forecast-head">
        <b>Yearly smart-ring forecast</b>
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
          aggregate Amazon units — the tool splits it across variants by sales share
        </span>
        <div className="spacer" />
        <label className="mono" style={{ fontSize: 12 }}>Year&nbsp;
          <input className="cell-edit" style={{ width: 70 }} type="number" value={year}
            onChange={e => setYear(Math.round(Number(e.target.value) || year))} />
        </label>
      </div>
      <div className="wear-forecast-grid">
        {MONTHS.map((mo, i) => (
          <label key={mo} className="wear-fc-cell">
            <span>{mo}</span>
            <input className="cell-edit" type="number" min={0} value={units[i]}
              onChange={e => setUnits(u => u.map((v, j) => j === i ? Math.max(0, Math.round(Number(e.target.value) || 0)) : v))} />
          </label>
        ))}
      </div>
      <div className="wear-forecast-foot">
        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>Year total: <b>{fmtInt(total)}</b> units</span>
        <div className="spacer" />
        <button className="btn sm" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" disabled={busy} onClick={save}>Save forecast</button>
      </div>
    </div>
  );
}
