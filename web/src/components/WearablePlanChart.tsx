import React, { useMemo, useState } from 'react';
import { fmtInt, type WearablePlan } from '../api.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const W = 900, H = 300;
const PAD = { l: 52, r: 16, t: 18, b: 34 };

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pretty = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * The smart-ring forward projection: does FBA stay in stock if the team follows this plan?
 *
 * Deliberately shows only what's trustworthy for a WEARABLE product — stock at Amazon, stock on the
 * way to Amazon, and the forward-looking goal. The warehouse and open China POs are shared with
 * retail/Shopify, so they are NOT drawn here; what the plan reports instead is the demand Amazon
 * places on the warehouse (see the schedule below the chart).
 */
export function WearablePlanChart({ plan, today }: { plan: WearablePlan; today: string }) {
  const [hover, setHover] = useState<number | null>(null);

  const { series } = plan;
  const maxY = useMemo(
    () => Math.max(1, ...series.map(s => Math.max(s.fba + s.in_transit, s.goal))) * 1.08,
    [series],
  );
  const lastDay = series.length ? series[series.length - 1].day : 1;
  const x = (day: number) => PAD.l + (day / Math.max(1, lastDay)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / maxY) * (H - PAD.t - PAD.b);

  const path = (get: (s: typeof series[0]) => number) =>
    series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.day).toFixed(1)},${y(get(s)).toFixed(1)}`).join(' ');

  // Stacked area: sellable at Amazon, with in-transit riding on top so total pipeline is visible.
  const areaFba = `${path(s => s.fba)} L${x(lastDay).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const areaTotal = `${path(s => s.fba + s.in_transit)} L${x(lastDay).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  // Month boundaries for the axis.
  const ticks = useMemo(() => {
    const out: { day: number; label: string }[] = [];
    let lastMonth = '';
    for (const s of series) {
      const iso = addDays(today, s.day);
      const mk = iso.slice(0, 7);
      if (mk !== lastMonth) { out.push({ day: s.day, label: MONTHS[Number(iso.slice(5, 7)) - 1] }); lastMonth = mk; }
    }
    return out;
  }, [series, today]);

  const dry = series.filter(s => s.fba <= 0);
  const hoverPt = hover === null ? null : series.find(s => s.day === hover) ?? null;

  return (
    <div className="wpc">
      <svg viewBox={`0 0 ${W} ${H}`} className="wpc-svg" role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const d = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * lastDay);
          setHover(Math.max(0, Math.min(lastDay, d)));
        }}>
        <defs>
          <linearGradient id="wpcFba" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--grad-teal)" stopOpacity="0.42" />
            <stop offset="100%" stopColor="var(--grad-teal)" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* Any stretch with an empty shelf — the thing this plan exists to prevent. */}
        {dry.length > 0 && (
          <rect x={x(dry[0].day)} y={PAD.t} width={Math.max(2, x(dry[dry.length - 1].day) - x(dry[0].day))}
            height={H - PAD.t - PAD.b} fill="var(--danger)" opacity="0.14" />
        )}

        {/* Y grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(maxY * f)} y2={y(maxY * f)} stroke="var(--hairline)" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(maxY * f) + 3.5} textAnchor="end" className="wpc-ax">{fmtInt(Math.round(maxY * f))}</text>
          </g>
        ))}

        {/* Total pipeline (in transit stacked over sellable), then sellable on top */}
        <path d={areaTotal} fill="var(--grad-purple)" opacity="0.16" />
        <path d={areaFba} fill="url(#wpcFba)" />
        <path d={path(s => s.fba + s.in_transit)} fill="none" stroke="var(--grad-purple)" strokeWidth="1.4" opacity="0.65" />
        <path d={path(s => s.fba)} fill="none" stroke="var(--grad-teal)" strokeWidth="2.4" />

        {/* The forward-looking goal: units needed to cover the next N days of forecast demand */}
        <path d={path(s => s.goal)} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />

        {/* Where each transfer lands */}
        {plan.transfers.map((t, i) => (
          t.arrives_day <= lastDay ? (
            <g key={i}>
              <line x1={x(t.arrives_day)} x2={x(t.arrives_day)} y1={H - PAD.b} y2={H - PAD.b + 5}
                stroke="var(--c-ship)" strokeWidth="2" />
              <circle cx={x(t.arrives_day)} cy={y(series.find(s => s.day === t.arrives_day)?.fba ?? 0)} r="3"
                fill="var(--c-ship)" />
            </g>
          ) : null
        ))}

        {/* X axis */}
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="var(--hairline-2)" strokeWidth="1" />
        {ticks.map(t => (
          <text key={t.day} x={x(t.day)} y={H - PAD.b + 16} textAnchor="middle" className="wpc-ax">{t.label}</text>
        ))}

        {/* Hover scrub */}
        {hoverPt && (
          <g>
            <line x1={x(hoverPt.day)} x2={x(hoverPt.day)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink)" strokeWidth="1" opacity="0.35" />
            <circle cx={x(hoverPt.day)} cy={y(hoverPt.fba)} r="4" fill="var(--grad-teal)" />
          </g>
        )}
      </svg>

      <div className="wpc-legend">
        <span><i style={{ background: 'var(--grad-teal)' }} /> Sellable at Amazon</span>
        <span><i style={{ background: 'var(--grad-purple)', opacity: 0.6 }} /> On the way to Amazon</span>
        <span><i className="dash" /> Goal — the forecast demand it must cover</span>
        <span><i style={{ background: 'var(--c-ship)' }} /> A transfer lands</span>
      </div>

      {hoverPt ? (
        <div className="wpc-read">
          <b>{pretty(addDays(today, hoverPt.day))}</b> · sellable <b>{fmtInt(hoverPt.fba)}</b>
          {hoverPt.in_transit > 0 && <> · on the way <b>{fmtInt(hoverPt.in_transit)}</b></>}
          {' '}· goal <b>{fmtInt(hoverPt.goal)}</b>
          {hoverPt.fba <= 0 && <span style={{ color: 'var(--stockout)' }}> · OUT OF STOCK</span>}
        </div>
      ) : (
        <div className="wpc-read">
          {plan.stockout_day < 0
            ? <span style={{ color: 'var(--ok)' }}>✓ Stays in stock the whole way — if the transfers below are made on time.</span>
            : <span style={{ color: 'var(--stockout)' }}>
                ⚠ Runs out around {pretty(addDays(today, plan.stockout_day))} — a transfer takes {plan.ship_leg_days} days
                to land, so it can't be fixed faster than that. Ship now and consider air freight.
              </span>}
        </div>
      )}
    </div>
  );
}

/** The exact units Amazon will pull from the warehouse, every review cycle. */
export function WearableTransferSchedule({ plan, today }: { plan: WearablePlan; today: string }) {
  if (plan.transfers.length === 0) {
    return <div className="empty">No transfers needed in this window — Amazon is covered by what it already holds.</div>;
  }
  const total = plan.transfers.reduce((s, t) => s + t.qty, 0);
  return (
    <>
      <table className="data">
        <thead><tr>
          <th className="plain">Ship on</th>
          <th className="plain num">Units to transfer</th>
          <th className="plain">Lands at Amazon</th>
        </tr></thead>
        <tbody>
          {plan.transfers.map((t, i) => (
            <tr key={i}>
              <td className="mono">{pretty(t.date)}{t.day === 0 && <span className="wear-tag">next</span>}</td>
              <td className="num" style={{ fontWeight: 600 }}>{fmtInt(t.qty)}</td>
              <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{pretty(t.arrives_date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="wear-note">
        Every <b>{plan.review_period_days} days</b>, sized so Amazon holds enough for the demand ahead. Over this
        window Amazon will pull <b>{fmtInt(total)}</b> units out of the warehouse — that total is what the inventory
        team needs from you, on top of whatever retail and Shopify need.
      </div>
    </>
  );
}
