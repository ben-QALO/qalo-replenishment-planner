import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { SkuResult } from '../api.ts';

const M = { top: 12, right: 14, bottom: 24, left: 40 };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}
function diffDays(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000);
}
const fmtDate = (d: string) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(d.slice(5,7))-1]} ${Number(d.slice(8,10))}`;

/** Shared dot-matrix column renderer — the signature visual language. */
function DotGrid({ columns, rows, W, H, dotR = 2.3 }: {
  columns: { fill: number; top?: number; danger?: boolean }[]; rows: number; W: number; H: number; dotR?: number;
}) {
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const n = columns.length;
  const stepX = iw / n;
  const stepY = ih / (rows - 1);
  const baseY = M.top + ih;
  const dots: React.ReactNode[] = [];
  columns.forEach((col, c) => {
    const cx = M.left + stepX * (c + 0.5);
    const fillRows = Math.max(col.danger ? 1 : 0, Math.round(col.fill * (rows - 1)));
    for (let r = 0; r < fillRows; r++) {
      dots.push(<circle key={`f${c}-${r}`} cx={cx} cy={baseY - r * stepY} r={dotR}
        fill={col.danger && r === 0 ? 'var(--danger)' : 'var(--chart-1)'} />);
    }
    const topRows = Math.round((col.top ?? 0) * (rows - 1));
    for (let r = fillRows; r < fillRows + topRows; r++) {
      dots.push(<circle key={`t${c}-${r}`} cx={cx} cy={baseY - r * stepY} r={dotR} fill="var(--chart-2)" />);
    }
  });
  return <>{dots}</>;
}

export interface PoArrival { date: string; qty: number; label: string }

/** Runway: projected Amazon stock draining at velocity, rendered as dot-matrix columns. */
export function RunwayChart({ r, today, poArrivals }: { r: SkuResult; today: string; poArrivals: PoArrival[] }) {
  const W = 620, H = 190, ROWS = 9;
  const model = useMemo(() => {
    const v = r.velocity ?? 0;
    const horizon = Math.max(r.po_rop_days + 20, 120, ...poArrivals.map(p => diffDays(p.date, today) + 20));
    const H_DAYS = Math.min(240, Math.ceil(horizon));
    const cols = 34;
    const bucket = H_DAYS / cols;
    const arrivals = poArrivals
      .map(p => ({ day: Math.max(0, diffDays(p.date, today)), qty: p.qty }))
      .filter(a => a.day <= H_DAYS);
    // Project stock day by day, then sample per bucket.
    const perDay: number[] = [];
    let stock = r.fba_position, ai = 0;
    const sorted = [...arrivals].sort((a, b) => a.day - b.day);
    for (let d = 0; d <= H_DAYS; d++) {
      while (ai < sorted.length && sorted[ai].day === d) { stock += sorted[ai].qty; ai++; }
      perDay.push(Math.max(0, stock));
      stock = Math.max(0, stock - v);
    }
    const sampled: number[] = [];
    for (let c = 0; c < cols; c++) sampled.push(perDay[Math.round(c * bucket)] ?? 0);
    const maxU = Math.max(10, ...sampled);
    const zeroDay = perDay.findIndex(s => s <= 0);
    const zeroCol = zeroDay >= 0 ? Math.round(zeroDay / bucket) : -1;
    return { sampled, maxU, H_DAYS, zeroDay, zeroCol, cols, bucket, v };
  }, [r, today, poArrivals]);

  const columns = model.sampled.map((val, c) => ({
    fill: val / model.maxU,
    danger: c === model.zeroCol,
  }));
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom, baseY = M.top + ih;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img" aria-label="Projected stock runway">
      {[0, 0.5, 1].map(f => (
        <text key={f} x={M.left - 8} y={baseY - f * ih + 3} textAnchor="end" fontSize="9" fill="var(--muted)" fontFamily="var(--mono)">{Math.round(model.maxU * f)}</text>
      ))}
      <DotGrid columns={columns} rows={ROWS} W={W} H={H} />
      {model.zeroDay >= 0 && (
        <text x={M.left + (iw / model.cols) * (model.zeroCol + 0.5)} y={baseY + 16} textAnchor="middle" fontSize="9" fontWeight="600" fill="var(--danger)" fontFamily="var(--mono)">
          OUT {fmtDate(addDays(today, model.zeroDay))}
        </text>
      )}
      <text x={M.left} y={baseY + 16} fontSize="9" fill="var(--muted)" fontFamily="var(--mono)">TODAY</text>
      <text x={W - M.right} y={baseY + 16} textAnchor="end" fontSize="9" fill="var(--muted)" fontFamily="var(--mono)">+{model.H_DAYS}D</text>
    </svg>
  );
}

export interface HistoryRow {
  snapshot_date: string; available: number; inbound: number; reserved: number; units_shipped_t30: number | null;
}

/** Stock history as dot-matrix: available (ink) with inbound stacked on top (faint). */
export function HistoryChart({ rows }: { rows: HistoryRow[] }) {
  const W = 620, H = 176, ROWS = 9;
  if (rows.length < 2) {
    return <div className="empty">Stock history builds as you import snapshots week over week — {rows.length === 1 ? 'one so far.' : 'none yet.'}</div>;
  }
  const maxU = Math.max(10, ...rows.map(r => r.available + r.inbound));
  const columns = rows.map(r => ({ fill: r.available / maxU, top: r.inbound / maxU }));
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom, baseY = M.top + ih;
  const tickEvery = Math.max(1, Math.ceil(rows.length / 6));
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img" aria-label="Stock history">
        {[0, 0.5, 1].map(f => (
          <text key={f} x={M.left - 8} y={baseY - f * ih + 3} textAnchor="end" fontSize="9" fill="var(--muted)" fontFamily="var(--mono)">{Math.round(maxU * f)}</text>
        ))}
        <DotGrid columns={columns} rows={ROWS} W={W} H={H} />
        {rows.map((r, i) => i % tickEvery === 0 && (
          <text key={i} x={M.left + (iw / rows.length) * (i + 0.5)} y={baseY + 15} textAnchor="middle" fontSize="8.5" fill="var(--muted)" fontFamily="var(--mono)">{fmtDate(r.snapshot_date)}</text>
        ))}
      </svg>
      <div className="chart-legend">
        <span className="key"><span className="swatch" style={{ background: 'var(--chart-1)' }} /> Available</span>
        <span className="key"><span className="swatch" style={{ background: 'var(--chart-2)' }} /> Inbound</span>
      </div>
    </>
  );
}

/* ── Catalog dot-map: one dot per tracked SKU, shaded by status ────────────── */

const TONE: Record<string, string> = {
  STOCKOUT: 'danger', CRITICAL: 'danger',
  ORDER_NOW: 'ink', ORDER_SOON: 'ink',
  OK: 'mid', OVERSTOCK: 'faint',
  AT_RISK: 'ring', UNCLASSIFIED: 'ring',
};
const TONE_ORDER = ['danger', 'ink', 'ring', 'mid', 'faint'];

export function CatalogDotMap({ results, onPick }: { results: SkuResult[]; onPick?: (status: string) => void }) {
  const dots = useMemo(() => {
    const tracked = results.filter(r => r.status !== 'NOT_REPLENISHABLE');
    return tracked
      .map(r => ({ sku: r.sku, status: r.status, tone: TONE[r.status] ?? 'mid' }))
      .sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));
  }, [results]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 20); return () => clearTimeout(t); }, []);

  return (
    <div className="dotmap" aria-label="Catalog status map">
      {dots.map((d, i) => (
        <span key={d.sku} className={`dot-cell tone-${d.tone}${mounted ? ' in' : ''}`}
          style={{ transitionDelay: `${Math.min(i * 1.5, 600)}ms` }}
          title={`${d.sku} — ${d.status.toLowerCase().replace(/_/g, ' ')}`}
          onClick={() => onPick?.(d.status)} />
      ))}
    </div>
  );
}

/* ── Count-up number ───────────────────────────────────────────────────────── */

export function CountUp({ value, className }: { value: number; className?: string }) {
  const [n, setN] = useState(0);
  const raf = useRef<number>();
  useEffect(() => {
    const start = performance.now();
    const dur = 700;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(eased * value));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [value]);
  return <span className={className}>{n}</span>;
}
