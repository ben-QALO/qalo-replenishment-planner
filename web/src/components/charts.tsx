import React, { useMemo, useState } from 'react';
import type { SkuResult } from '../api.ts';

const M = { top: 14, right: 16, bottom: 26, left: 44 };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}
const fmtDate = (d: string) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(d.slice(5,7))-1]} ${Number(d.slice(8,10))}`;

export interface PoArrival { date: string; qty: number; label: string }

/**
 * Runway: projected Amazon-side stock draining at current velocity, step-ups at
 * open-PO arrivals, red marker where the line touches zero.
 */
export function RunwayChart({ r, today, poArrivals }: { r: SkuResult; today: string; poArrivals: PoArrival[] }) {
  const [hover, setHover] = useState<{ x: number; day: number; units: number } | null>(null);
  const W = 620, H = 190;
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;

  const model = useMemo(() => {
    const v = r.velocity ?? 0;
    const horizon = Math.max(r.po_rop_days + 20, 120,
      ...poArrivals.map(p => diffDays(p.date, today) + 20));
    const H_DAYS = Math.min(240, Math.ceil(horizon));
    const arrivals = poArrivals
      .map(p => ({ day: Math.max(0, diffDays(p.date, today)), qty: p.qty, label: p.label }))
      .filter(a => a.day <= H_DAYS)
      .sort((a, b) => a.day - b.day);
    const pts: { day: number; units: number }[] = [];
    let stock = r.fba_position;
    let ai = 0;
    for (let d = 0; d <= H_DAYS; d++) {
      while (ai < arrivals.length && arrivals[ai].day === d) { stock += arrivals[ai].qty; ai++; }
      pts.push({ day: d, units: Math.max(0, stock) });
      stock = Math.max(0, stock - v);
    }
    const maxU = Math.max(10, ...pts.map(p => p.units));
    const zeroDay = pts.find(p => p.units <= 0)?.day ?? null;
    return { pts, maxU, H_DAYS, arrivals, zeroDay, v };
  }, [r, today, poArrivals]);

  const x = (day: number) => M.left + (day / model.H_DAYS) * iw;
  const y = (u: number) => M.top + ih - (u / model.maxU) * ih;

  const path = model.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.units).toFixed(1)}`).join(' ');
  const area = `${path} L${x(model.H_DAYS).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;

  const yTicks = useMemo(() => {
    const step = Math.pow(10, Math.floor(Math.log10(model.maxU)));
    const n = model.maxU / step;
    const s = n >= 5 ? step * 2 : n >= 2.5 ? step : step / 2;
    const ticks: number[] = [];
    for (let t = 0; t <= model.maxU; t += s) ticks.push(Math.round(t));
    return ticks.slice(0, 6);
  }, [model.maxU]);

  const xTicks = useMemo(() => {
    const every = model.H_DAYS > 160 ? 60 : model.H_DAYS > 80 ? 30 : 14;
    const ticks: number[] = [];
    for (let d = 0; d <= model.H_DAYS; d += every) ticks.push(d);
    return ticks;
  }, [model.H_DAYS]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const day = Math.round(((px - M.left) / iw) * model.H_DAYS);
    if (day < 0 || day > model.H_DAYS) { setHover(null); return; }
    setHover({ x: x(day), day, units: model.pts[day]?.units ?? 0 });
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
      aria-label="Projected stock runway">
      {yTicks.map(t => (
        <g key={t}>
          <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="var(--hairline)" strokeWidth="1" />
          <text x={M.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">{t}</text>
        </g>
      ))}
      {xTicks.map(d => (
        <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">
          {d === 0 ? 'today' : fmtDate(addDays(today, d))}
        </text>
      ))}
      <path d={area} fill="var(--chart-1)" opacity="0.09" />
      <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" />
      {model.arrivals.map((a, i) => (
        <g key={i}>
          <line x1={x(a.day)} x2={x(a.day)} y1={M.top} y2={M.top + ih} stroke="var(--chart-2)" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x={x(a.day) + 4} y={M.top + 10} fontSize="9.5" fill="var(--chart-2)" fontFamily="var(--mono)">+{a.qty} {a.label}</text>
        </g>
      ))}
      {model.zeroDay !== null && (
        <g>
          <circle cx={x(model.zeroDay)} cy={y(0)} r="5" fill="var(--stockout)" stroke="var(--surface)" strokeWidth="2" />
          <text x={Math.min(x(model.zeroDay) + 8, W - 90)} y={y(0) - 7} fontSize="10" fontWeight="700" fill="var(--stockout)" fontFamily="var(--mono)">
            out {fmtDate(addDays(today, model.zeroDay))}
          </text>
        </g>
      )}
      {hover && (
        <g pointerEvents="none">
          <line x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + ih} stroke="var(--ink-2)" strokeWidth="1" opacity="0.5" />
          <rect x={Math.min(hover.x + 6, W - 132)} y={M.top + 2} width="126" height="30" rx="5" fill="var(--ink)" opacity="0.92" />
          <text x={Math.min(hover.x + 14, W - 124)} y={M.top + 15} fontSize="9.5" fill="#e9e7dd" fontFamily="var(--mono)">
            {fmtDate(addDays(today, hover.day))} (+{hover.day}d)
          </text>
          <text x={Math.min(hover.x + 14, W - 124)} y={M.top + 27} fontSize="9.5" fill="#fff" fontWeight="700" fontFamily="var(--mono)">
            {Math.round(hover.units)} units
          </text>
        </g>
      )}
    </svg>
  );
}

export interface HistoryRow {
  snapshot_date: string; available: number; inbound: number; reserved: number;
  units_shipped_t30: number | null;
}

/** Weekly snapshot history: available + inbound stacked areas with a 2px surface gap. */
export function HistoryChart({ rows }: { rows: HistoryRow[] }) {
  const W = 620, H = 170;
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  if (rows.length < 2) {
    return <div className="empty">Stock history builds up as you import snapshots week over week — {rows.length === 1 ? 'one snapshot so far.' : 'no snapshots yet.'}</div>;
  }
  const maxU = Math.max(10, ...rows.map(r => r.available + r.inbound));
  const x = (i: number) => M.left + (i / (rows.length - 1)) * iw;
  const y = (u: number) => M.top + ih - (u / maxU) * ih;

  const availPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.available).toFixed(1)}`).join(' ');
  const availArea = `${availPath} L${x(rows.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const stackPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.available + r.inbound).toFixed(1)}`).join(' ');

  const tickEvery = Math.max(1, Math.ceil(rows.length / 7));

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img" aria-label="Stock history">
        {[0, 0.5, 1].map(f => (
          <g key={f}>
            <line x1={M.left} x2={W - M.right} y1={y(maxU * f)} y2={y(maxU * f)} stroke="var(--hairline)" strokeWidth="1" />
            <text x={M.left - 6} y={y(maxU * f) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">{Math.round(maxU * f)}</text>
          </g>
        ))}
        <path d={availArea} fill="var(--chart-1)" opacity="0.14" />
        <path d={availPath} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" />
        <path d={stackPath} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeLinejoin="round" strokeDasharray="1 0" />
        {rows.map((r, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(r.available)} r="3" fill="var(--chart-1)" stroke="var(--surface)" strokeWidth="2">
              <title>{`${r.snapshot_date}: ${r.available} available, ${r.inbound} inbound`}</title>
            </circle>
            {i % tickEvery === 0 && (
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">{fmtDate(r.snapshot_date)}</text>
            )}
          </g>
        ))}
      </svg>
      <div className="chart-legend">
        <span className="key"><span className="swatch" style={{ background: 'var(--chart-1)' }} /> Available at FBA</span>
        <span className="key"><span className="swatch" style={{ background: 'var(--chart-2)' }} /> Available + inbound</span>
      </div>
    </>
  );
}
