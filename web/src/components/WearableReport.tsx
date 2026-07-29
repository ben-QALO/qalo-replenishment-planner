import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtInt, fmtNum, type SkuResult, type WearableRollup, type WearableMonth, type ForecastResponse, type ForecastMonth } from '../api.ts';
import { toast, downloadCsv, downloadFromApi } from './ui.tsx';

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
  const [exporting, setExporting] = useState(false);

  // What the smart rings are selling right now, all sizes together. The forecast is entered on the
  // same basis (aggregate ring units), so this is the figure a month's entry has to beat to have any
  // effect — the plan never orders for less than actual sales. Excludes the sizing kit, which rides
  // along at its attach rate rather than being part of the ring forecast.
  const actualPerMonth = useMemo(() => rows
    .filter(r => !r.wearable_report!.is_attach_product)
    .reduce((a, r) => a + r.wearable_report!.actual_run_rate_month, 0), [rows]);

  // The workbook the inventory team plans from: what to order from China per SKU per month, what to
  // earmark for Amazon out of stock already held, and the fortnightly FBA pull behind both.
  async function exportWorkbook() {
    setExporting(true);
    try {
      await downloadFromApi('/api/exports/wearable-plan.xlsx', 'smart-ring-ordering-plan.xlsx');
      toast('Excel plan downloaded — ready to send to the inventory team.');
    } catch (err: any) { toast(`Export failed: ${err.message}`); }
    finally { setExporting(false); }
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        No smart-ring plan yet. Tag your smart rings as <b>WEARABLE · smart ring</b> (and the sizing kit as
        <b> WEARABLE · sizing kit</b>) on the SKU or All SKUs page, then enter the monthly forecast below.
        <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => setEditing(true)}>Enter forecast</button></div>
        {editing && <ForecastEditor onClose={() => setEditing(false)} refresh={refresh} actualPerMonth={0} />}
      </div>
    );
  }

  const monthsFor = (sku: string): WearableMonth[] =>
    sku === 'rollup' ? (rollup?.months ?? []) : (rows.find(r => r.sku === sku)?.wearable_report?.months ?? []);
  const shown = monthsFor(view);
  const lead = rows[0].wearable_report!.lead_months;

  function exportCsv() {
    const header = ['Month', 'Forecast demand (Amazon)', 'Units Amazon pulls from warehouse',
      'Cumulative pulled', 'Must be at warehouse by', 'China order to place', 'Order lands',
      'Warehouse held for Amazon (planned)', 'Notes'];
    const label = view === 'rollup' ? 'all-smart-rings' : view;
    const lines = [header.join(',')];
    for (const m of shown) {
      lines.push([prettyMonth(m.month), m.forecast_demand, m.expected_transfer, m.cumulative_transfer,
        m.must_be_at_warehouse_by, m.recommended_order,
        prettyMonth(m.order_lands_month), m.warehouse_for_amazon,
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
        <div className="wear-intro-actions">
          <button className="btn sm primary" disabled={exporting} onClick={exportWorkbook}>
            {exporting ? 'Building…' : 'Export for inventory team (Excel)'}
          </button>
          <button className="btn sm" onClick={() => setEditing(e => !e)}>{editing ? 'Hide forecast' : 'Edit forecast'}</button>
          <span className="wear-intro-hint">
            Multi-tab workbook: what to earmark for Amazon <b>now</b>, 12 months of China orders, the
            monthly demand behind them, and the every-2-weeks FBA pull — with how each number was worked out.
          </span>
        </div>
      </div>

      {editing && <ForecastEditor onClose={() => setEditing(false)} refresh={refresh} actualPerMonth={actualPerMonth} />}

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
        <button className="btn sm" onClick={exportCsv} title="Just this one table as a CSV. For the full workbook the inventory team plans from, use “Export for inventory team” above.">
          Copy this table (CSV)
        </button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data wear-months">
          <thead><tr>
            <th className="plain">Month</th>
            <th className="plain num" title="What the plan is sizing for: your forecast, or your actual sales rate where that is higher">Planned demand</th>
            <th className="plain num">Amazon pulls from WH</th>
            <th className="plain num">Cumulative</th>
            <th className="plain num">Order from China</th>
            <th className="plain">Lands</th>
          </tr></thead>
          <tbody>
            {shown.map(m => (
              <tr key={m.month}>
                <td className="mono">{prettyMonth(m.month)}
                  {(m.flags ?? []).includes('FORECAST_EXTRAPOLATED') &&
                    <span className="wear-tag" title="No forecast entered for this month — reuses last year's same month">est.</span>}
                  {(m.flags ?? []).includes('PLANNED_AT_ACTUAL') &&
                    <span className="wear-tag" title="Your forecast for this month is below what this product is actually selling, so the plan uses the real sales rate instead — it never plans for less than you're selling">at actual</span>}
                </td>
                <td className="num">{fmtInt(m.forecast_demand)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{fmtInt(m.expected_transfer)}</td>
                <td className="num" style={{ color: 'var(--muted)' }}>{fmtInt(m.cumulative_transfer)}</td>
                <td className="num" style={{ fontWeight: 600, color: 'var(--grad-purple)' }}>{m.recommended_order > 0 ? fmtInt(m.recommended_order) : '—'}</td>
                <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{prettyMonth(m.order_lands_month)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="wear-note">
        <b>Planned demand</b> is your forecast, lifted to your real sales rate for any month where the
        forecast has fallen behind (tagged <b>at actual</b>) — the plan never sizes for less than you're
        selling. <b>Amazon pulls from WH</b> is the number to give your inventory team — the units Amazon will take out of the
        warehouse that month, which they add to what retail and Shopify need. You never have to know the shared totals.
        <br /><b>Order from China</b> is what to place that month so it lands ~{lead} months later, sized to cover the
        pull in the month it arrives.
      </div>
    </div>
  );
}

/**
 * The forecast editor: one box per real calendar month, starting this month.
 *
 * There is deliberately NO year field. The plan runs a rolling 12 months, so it straddles two
 * calendar years — and the previous year-at-a-time editor turned that into a trap. It opened on
 * whichever year was highest on file rather than the one you were editing, typing a different year
 * did not reload that year's figures, and saving then wrote the old year's numbers over the year you
 * had typed, without saying so. Naming each month removes the ambiguity entirely.
 *
 * `actualPerMonth` is what the smart rings are currently selling. It's shown here because a forecast
 * below the real sales rate is silently ignored by the planner (it never plans below demonstrated
 * demand), so a figure that looks saved but has no effect would otherwise be invisible.
 */
function ForecastEditor({ onClose, refresh, actualPerMonth }: {
  onClose: () => void; refresh: () => void; actualPerMonth: number;
}) {
  const [months, setMonths] = useState<ForecastMonth[] | null>(null);
  const [planMonths, setPlanMonths] = useState(12);
  const [leadMonths, setLeadMonths] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refetched every time the editor opens, so it always shows what is actually stored.
  useEffect(() => {
    api.get<ForecastResponse>('/api/forecast')
      .then(f => { setMonths(f.months); setPlanMonths(f.plan_months); setLeadMonths(f.lead_months); })
      .catch(err => setError(`Could not load the forecast: ${err.message}`));
  }, []);

  const setUnits = (month: string, raw: string) =>
    setMonths(ms => (ms ?? []).map(m => m.month === month
      ? { ...m, units: Math.max(0, Math.round(Number(raw) || 0)), entered: true }
      : m));

  const planWindow = (months ?? []).filter(m => m.in_plan_window);
  const ahead = (months ?? []).filter(m => !m.in_plan_window);
  const planTotal = planWindow.reduce((a, m) => a + m.units, 0);
  const blanks = (months ?? []).filter(m => !m.entered || m.units === 0).length;
  const belowActual = planWindow.filter(m => m.units > 0 && m.units < actualPerMonth).length;

  async function save() {
    if (!months) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ saved: { month: string; units: number }[] }>(
        '/api/forecast', { months: months.map(m => ({ month: m.month, units: m.units })) });
      // Report what the server stored, not what we hoped it stored.
      toast(`Saved ${res.saved.length} months — ${fmtInt(planTotal)} units across the next ${planMonths}.`);
      refresh();
      onClose();
    } catch (err: any) {
      setError(`Save failed: ${err.message}`);
      setBusy(false);
    }
  }

  const cell = (m: ForecastMonth) => {
    const low = m.units > 0 && m.units < actualPerMonth;
    return (
      <label key={m.month} className={`wear-fc-cell${m.entered && m.units > 0 ? '' : ' blank'}`}>
        <span>{prettyMonth(m.month)}</span>
        <input className="cell-edit" type="number" min={0} value={m.units}
          onChange={e => setUnits(m.month, e.target.value)} />
        {low && <em title={`Below what you're selling now (~${fmtInt(actualPerMonth)}/mo), so the plan will use the real sales rate for this month instead`}>below actual</em>}
      </label>
    );
  };

  if (error && !months) return <div className="wear-forecast card-inset"><div className="wear-fc-error">{error}</div></div>;
  if (!months) return <div className="wear-forecast card-inset"><span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>Loading forecast…</span></div>;

  return (
    <div className="wear-forecast card-inset">
      <div className="wear-forecast-head">
        <b>Smart-ring forecast</b>
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
          total Amazon units per month — the tool splits each month across the sizes by sales share
        </span>
      </div>

      <div className="wear-fc-hint">
        Enter what you expect to sell on Amazon in each month. Across all sizes you're currently
        selling about <b>{fmtInt(actualPerMonth)} a month</b> — any month you set below that is ignored,
        because the plan never orders for less than you're actually selling.
      </div>

      <div className="wear-fc-label">The {planMonths} months your plan covers</div>
      <div className="wear-forecast-grid">{planWindow.map(cell)}</div>

      {ahead.length > 0 && (
        <>
          <div className="wear-fc-label">
            Also needed — an order placed at the end of the window lands about {leadMonths} months later
          </div>
          <div className="wear-forecast-grid ahead">{ahead.map(cell)}</div>
        </>
      )}

      {error && <div className="wear-fc-error">{error}</div>}

      <div className="wear-forecast-foot">
        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          Next {planMonths} months: <b>{fmtInt(planTotal)}</b> units
          {blanks > 0 && <> · <span className="wear-fc-warn">{blanks} month{blanks === 1 ? '' : 's'} still empty</span></>}
          {/* Scope the count explicitly: "below actual" markers also appear on the lead-time months
              beyond the window, and an unqualified number would look like it disagreed with them. */}
          {belowActual > 0 && <> · <span className="wear-fc-warn">{belowActual} of the {planMonths} below your current sales</span></>}
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save forecast'}
        </button>
      </div>
    </div>
  );
}
