import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { SkuResult } from '../api.ts';
import { STATUS_META, TONE_FAMILY } from '../api.ts';

const M = { top: 12, right: 14, bottom: 24, left: 40 };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
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

export interface PlanEvent { day: number; kind: 'ship' | 'transfer_arrives' | 'po_placed' | 'po_arrives'; qty: number }
export interface PlanPoint { day: number; fba: number; inTransit?: number; warehouse?: number; onOrder?: number }
export interface PlanData { series: PlanPoint[]; events: PlanEvent[]; goalUnits: number }

// One lane per location, closest-to-customer first, on a cool teal→purple ramp built from
// the brand's cool stops — the same idea as the app's sleep lanes (Awake/REM/Light/Deep).
// Each lane is drawn on its OWN baseline so its real rise and fall is honest: nothing is
// stacked, so a flat warehouse reads flat instead of being dragged down by the base.
const LAYERS = [
  { key: 'fba', label: 'At Amazon', color: '#17BEBB', hint: 'sellable now — sells down daily, refills when a shipment lands' },
  { key: 'inTransit', label: 'Heading to Amazon', color: '#3FA4D6', hint: 'on the warehouse → Amazon leg' },
  { key: 'warehouse', label: 'In your warehouse', color: '#5E8FE4', hint: 'on hand, ready to ship to Amazon' },
  { key: 'onOrder', label: 'On order from China', color: '#7B78F9', hint: 'placed, still in production or transit' },
] as const;

// Which lane each event lands on (the lane whose rise it explains), and — for the three
// events that MOVE existing units toward the customer — which lane those units came from.
// po_placed has no source: it puts brand-new units into the pipeline.
const EV_LANE: Record<PlanEvent['kind'], number> = { transfer_arrives: 0, ship: 1, po_arrives: 2, po_placed: 3 };
const FLOW: Partial<Record<PlanEvent['kind'], { from: number; to: number }>> = {
  po_arrives: { from: 3, to: 2 },        // China order lands in the warehouse
  ship: { from: 2, to: 1 },              // warehouse stock leaves for Amazon
  transfer_arrives: { from: 1, to: 0 },  // that shipment becomes sellable at Amazon
};
/** One short, glanceable phrase per event — no sentences. */
function evLabel(e: PlanEvent): string {
  const q = e.qty.toLocaleString('en-US');
  switch (e.kind) {
    case 'po_placed': return `order ${q}`;
    case 'po_arrives': return `+${q} from China`;
    case 'ship': return `${q} → Amazon`;
    case 'transfer_arrives': return `+${q} sellable`;
  }
}

/**
 * The plan played forward as four independent lanes — how the units in each location rise
 * and fall over the next six months if you follow the recommendations. Un-stacked on
 * purpose: each lane sits on its own baseline and its own scale, so every location's true
 * shape is legible. The At Amazon lane carries the dashed goal line. Hover to scrub any day.
 */
export function PlanChart({ r, today, plan }: { r: SkuResult; today: string; plan: PlanData }) {
  const W = 960;
  const padLeft = 14, padRight = 64, padTop = 6, padBottom = 34;
  const headerH = 18, laneH = 60, laneGap = 22;
  const H = padTop + LAYERS.length * (headerH + laneH + laneGap) - laneGap + padBottom;
  const iw = W - padLeft - padRight;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const v = r.velocity ?? 0;
  const S = plan.series;
  const H_DAYS = S.length - 1;
  const val = (pt: PlanPoint, k: string): number =>
    k === 'fba' ? pt.fba : k === 'inTransit' ? (pt.inTransit ?? 0) : k === 'warehouse' ? (pt.warehouse ?? 0) : (pt.onOrder ?? 0);
  const total = (pt: PlanPoint) => LAYERS.reduce((s, l) => s + val(pt, l.key), 0);
  const x = (day: number) => padLeft + (day / H_DAYS) * iw;
  const days = (u: number) => (v > 0 ? Math.round(u / v) : 0);

  // Per-lane geometry + independent vertical scale.
  const laneMax = (li: number) => {
    const key = LAYERS[li].key;
    const peak = Math.max(1, ...S.map(pt => val(pt, key)));
    return li === 0 ? Math.max(peak, plan.goalUnits) : peak; // At Amazon lane must fit the goal line
  };
  const stripTop = (li: number) => padTop + li * (headerH + laneH + laneGap) + headerH;
  const stripBottom = (li: number) => stripTop(li) + laneH;
  const yInLane = (li: number, u: number) => stripBottom(li) - (u / laneMax(li)) * laneH;
  const laneArea = (li: number) => {
    const key = LAYERS[li].key;
    const pts = S.map(pt => `${x(pt.day).toFixed(1)},${yInLane(li, val(pt, key)).toFixed(1)}`);
    return `M${x(0).toFixed(1)},${stripBottom(li).toFixed(1)} L${pts.join(' L')} L${x(H_DAYS).toFixed(1)},${stripBottom(li).toFixed(1)} Z`;
  };
  const laneLine = (li: number) => {
    const key = LAYERS[li].key;
    return 'M' + S.map(pt => `${x(pt.day).toFixed(1)},${yInLane(li, val(pt, key)).toFixed(1)}`).join(' L');
  };

  const ticks = [30, 60, 90, 120, 150].filter(d => d < H_DAYS);
  const now = S[0], hov = hoverDay !== null ? S[hoverDay] : null;
  const endDate = addDays(today, H_DAYS);
  const monthsOut = Math.round(H_DAYS / 30);

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (e.clientX - rect.left) * (W / rect.width);
    const d = Math.round(((px - padLeft) / iw) * H_DAYS);
    setHoverDay(Math.max(0, Math.min(H_DAYS, d)));
  }

  const shownPt = hov ?? now;
  return (
    <div className="plan">
      {/* Sleep-stages-style headline: the big total, then the sellable breakdown */}
      <div className="plan-head">
        <div className="plan-hero">
          <div className="plan-n">{total(shownPt).toLocaleString('en-US')}<em>units</em></div>
          <div className="plan-hero-sub">{hov ? `In the pipeline on ${fmtDate(addDays(today, hoverDay!))}` : 'In your pipeline today'}</div>
        </div>
        <div className="plan-facts">
          <div><span className="pf-k">Sellable at Amazon</span><span className="pf-v" style={{ color: '#17BEBB' }}>{shownPt.fba.toLocaleString('en-US')}</span><span className="pf-s">{days(shownPt.fba)}d cover</span></div>
          <div><span className="pf-k">Amazon goal</span><span className="pf-v">{plan.goalUnits.toLocaleString('en-US')}</span><span className="pf-s">{r.fba_target_days}d target</span></div>
        </div>
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}
        role="img" aria-label="Units in each location over the next 6 months if you follow the plan"
        onMouseMove={onMove} onMouseLeave={() => setHoverDay(null)}>
        {LAYERS.map((l, li) => {
          const top = stripTop(li), bottom = stripBottom(li);
          const peak = Math.max(0, ...S.map(pt => val(pt, l.key)));
          const goalYInLane = li === 0 ? yInLane(0, plan.goalUnits) : null;
          return (
            <g key={l.key}>
              {/* lane header: colour dot + label + peak value */}
              <circle cx={padLeft + 3} cy={top - 8} r={3.5} fill={l.color} />
              <text x={padLeft + 12} y={top - 4} fontSize="12" fontWeight="600" fill="var(--ink)" fontFamily="var(--sans)">{l.label}</text>
              <text x={W - padRight} y={top - 4} textAnchor="end" fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">PEAK {Math.round(peak).toLocaleString('en-US')}</text>
              {/* lane track */}
              <rect x={padLeft} y={top} width={iw} height={laneH} rx="6" fill="var(--surface-2)" opacity="0.5" />
              <line x1={padLeft} x2={W - padRight} y1={bottom} y2={bottom} stroke="var(--hairline)" strokeWidth="1" />
              {/* the area + top line */}
              <path d={laneArea(li)} fill={l.color} fillOpacity="0.82" />
              <path d={laneLine(li)} fill="none" stroke={l.color} strokeWidth="1.4" />
              {/* At Amazon goal line */}
              {goalYInLane !== null && (
                <>
                  <line x1={padLeft} x2={W - padRight} y1={goalYInLane} y2={goalYInLane} stroke="var(--ink)" strokeWidth="1.1" strokeDasharray="4 4" />
                  <text x={padLeft + 5} y={goalYInLane - 4} fontSize="8.5" fill="var(--ink-2)" fontFamily="var(--mono)">GOAL {plan.goalUnits.toLocaleString('en-US')}</text>
                </>
              )}
              {/* hover marker for this lane */}
              {hoverDay !== null && hov && (
                <>
                  <circle cx={x(hoverDay)} cy={yInLane(li, val(hov, l.key))} r={3.2} fill={l.color} stroke="var(--surface)" strokeWidth="1.5" />
                  <text x={x(hoverDay)} y={yInLane(li, val(hov, l.key)) - 7} textAnchor="middle" fontSize="10" fontWeight="700"
                    fill="var(--ink)" fontFamily="var(--mono)">{val(hov, l.key).toLocaleString('en-US')}</text>
                </>
              )}
            </g>
          );
        })}
        {/* shared hover crosshair spanning all lanes */}
        {hoverDay !== null && (
          <line x1={x(hoverDay)} x2={x(hoverDay)} y1={padTop + headerH - 2} y2={H - padBottom}
            stroke="var(--ink)" strokeWidth="1" strokeOpacity="0.35" pointerEvents="none" />
        )}

        {/* Flow connectors — a dashed thread tying a lane's drop to the rise it feeds, so the
            SAME units are visibly moving one step closer to the customer (China→warehouse→
            heading→Amazon). Brightens near the hovered day. */}
        {plan.events.map((e, i) => {
          const f = FLOW[e.kind];
          if (!f || !S[e.day]) return null;
          const near = hoverDay !== null && Math.abs(e.day - hoverDay) <= 3;
          const y1 = yInLane(f.from, val(S[e.day], LAYERS[f.from].key));
          const y2 = yInLane(f.to, val(S[e.day], LAYERS[f.to].key));
          return (
            <line key={`fl${i}`} x1={x(e.day)} x2={x(e.day)} y1={y1} y2={y2}
              stroke={LAYERS[f.to].color} strokeWidth={near ? 1.6 : 1}
              strokeDasharray="3 3" strokeOpacity={near ? 0.95 : 0.4} pointerEvents="none" />
          );
        })}

        {/* Event markers — a diamond on the lane each event explains. The reason (qty + what
            happened) appears only for events near the hovered day, so it never clutters. */}
        {plan.events.map((e, i) => {
          const lane = EV_LANE[e.kind];
          if (lane === undefined || !S[e.day]) return null;
          const cx = x(e.day), cy = yInLane(lane, val(S[e.day], LAYERS[lane].key)), r = 4;
          const c = LAYERS[lane].color;
          const near = hoverDay !== null && Math.abs(e.day - hoverDay) <= 3;
          return (
            <g key={`ev${i}`} pointerEvents="none">
              <path d={`M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`}
                fill={c} stroke="var(--surface)" strokeWidth="1.3" />
              {near && (
                // Reason sits BELOW the diamond so it never collides with the lane's
                // running-level label (which sits above the hover dot).
                <text x={cx} y={cy + r + 12} textAnchor="middle" fontSize="9.5" fontWeight="700"
                  fill={c} fontFamily="var(--mono)" stroke="var(--surface)" strokeWidth="2.5"
                  paintOrder="stroke">{evLabel(e)}</text>
              )}
            </g>
          );
        })}
        {/* x axis: faint month ticks (endpoints are labelled below the chart) */}
        {ticks.map(d => (
          <text key={d} x={x(d)} y={H - padBottom + 18} textAnchor="middle" fontSize="9.5" fill="var(--faint)" fontFamily="var(--mono)">
            {fmtDate(addDays(today, d))}
          </text>
        ))}
      </svg>

      {/* Legend for the new language: diamonds = events, dashed thread = same units moving */}
      <div style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)', margin: '10px 0 2px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6,1 L11,6 L6,11 L1,6 Z" fill="var(--ink-2)" /></svg>
          an event — placed, shipped, or arrived
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="20" height="12" viewBox="0 0 20 12" aria-hidden="true"><line x1="10" y1="1" x2="10" y2="11" stroke="var(--ink-2)" strokeWidth="1.4" strokeDasharray="3 3" /></svg>
          the same units moving toward Amazon
        </span>
        <span style={{ opacity: 0.8 }}>hover a day for the numbers &amp; reason</span>
      </div>

      {/* Endpoint framing, like the sleep chart's In bed / Awake */}
      <div className="plan-ends">
        <div><b>TODAY</b><span>{fmtDate(today)}</span></div>
        <div className="r"><b>IN {monthsOut} MONTHS</b><span>{fmtDate(endDate)}</span></div>
      </div>
    </div>
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

/* ── Catalog dot-map: one dot per tracked SKU, shaded by status family ──────────
   Colour + grouping come from STATUS_META / TONE_FAMILY (the single source of truth). */

const CLS_FOR_STATUS = (status: string): string => {
  const tone = STATUS_META[status]?.tone;
  return TONE_FAMILY.find(f => f.tone === tone)?.cls ?? 'tone-mid';
};

export function CatalogDotMap({ results, onPick }: { results: SkuResult[]; onPick?: (status: string) => void }) {
  const dots = useMemo(() => {
    const order = TONE_FAMILY.map(f => f.cls);
    return results
      .filter(r => r.status !== 'NOT_REPLENISHABLE')
      .map(r => ({ sku: r.sku, status: r.status, cls: CLS_FOR_STATUS(r.status) }))
      .sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
  }, [results]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 20); return () => clearTimeout(t); }, []);

  return (
    <div className="dotmap" aria-label="Catalog status map">
      {dots.map((d, i) => (
        <span key={d.sku} className={`dot-cell ${d.cls}${mounted ? ' in' : ''}`}
          style={{ transitionDelay: `${Math.min(i * 1.5, 600)}ms` }}
          title={`${d.sku} — ${STATUS_META[d.status]?.label ?? d.status}`}
          onClick={() => onPick?.(d.status)} />
      ))}
    </div>
  );
}

/* ── QRNT gradient ramp ──────────────────────────────────────────────────────
   The three brand stops (purple → teal → lime) interpolated in RGB. Used to
   colour the score gauge segment-by-segment, exactly like the app's Q Score. */
const QRNT_STOPS: [number, [number, number, number]][] = [
  [0, [123, 120, 249]],   // #7B78F9 purple
  [0.52, [23, 190, 187]], // #17BEBB teal
  [1, [233, 251, 74]],    // #E9FB4A lime
];
function qrnt(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < QRNT_STOPS.length; i++) {
    const [p0, c0] = QRNT_STOPS[i - 1], [p1, c1] = QRNT_STOPS[i];
    if (x <= p1) {
      const f = (x - p0) / (p1 - p0);
      const rgb = c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
      return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }
  }
  return `rgb(${QRNT_STOPS[2][1].join(',')})`;
}

function scoreBand(score: number): string {
  if (score >= 85) return 'GREAT';
  if (score >= 70) return 'GOOD';
  if (score >= 55) return 'FAIR';
  if (score >= 35) return 'POOR';
  return 'CRITICAL';
}

/**
 * The signature Q Score gauge: a 270°, segment-by-segment arc that fills with the
 * QRNT gradient up to `score`, dark beyond it. Big Termina numeral in the centre with
 * a tiny eyebrow label above and the band word below — one-to-one with the app.
 */
export function ScoreGauge({ score, eyebrow = 'CATALOG', caption }: { score: number; eyebrow?: string; caption?: string }) {
  const N = 44, SEG = 270, START = 135; // degrees; gap centred at the bottom
  const cx = 100, cy = 100, rIn = 68, rOut = 86;
  const [fill, setFill] = useState(0);
  useEffect(() => {
    const start = performance.now(), dur = 900, from = 0;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setFill(from + (score - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score]);
  const band = scoreBand(score);
  const segs = Array.from({ length: N }, (_, i) => {
    const frac = (i + 0.5) / N;
    const on = frac * 100 <= fill;
    const a = ((START + frac * SEG) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return {
      x1: cx + rIn * cos, y1: cy + rIn * sin, x2: cx + rOut * cos, y2: cy + rOut * sin,
      color: on ? qrnt(frac) : 'var(--hairline-2)', on,
    };
  });
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 200" role="img" aria-label={`${eyebrow} score ${score} of 100 — ${band}`}>
        {segs.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            stroke={s.color} strokeWidth={5.5} strokeLinecap="round"
            style={{ opacity: s.on ? 1 : 0.55, transition: 'stroke 120ms linear' }} />
        ))}
      </svg>
      <div className="gauge-center">
        <div className="gauge-eyebrow">{eyebrow}</div>
        <div className="gauge-n"><CountUp value={score} /></div>
        <div className="gauge-band">{band}</div>
      </div>
      {caption && <div className="gauge-caption">{caption}</div>}
    </div>
  );
}

/**
 * A single domain ring — the Sleep / Vitality / Movement pattern. One brand colour, a
 * circular progress track, a big centre numeral, and label + sub beneath. Clickable.
 */
export function MetricRing({ value, pct, color, label, sub, icon, onClick }: {
  value: number; pct: number; color: string; label: string; sub?: string;
  icon?: React.ReactNode; onClick?: () => void;
}) {
  const r = 40, C = 2 * Math.PI * r;
  const [draw, setDraw] = useState(0);
  useEffect(() => {
    const start = performance.now(), dur = 850;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setDraw(pct * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pct]);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="metric-ring" onClick={onClick} style={{ ['--ring-c' as any]: color }}>
      <div className="ring-viz">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--hairline)" strokeWidth="7" />
          <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, draw)))}
            transform="rotate(-90 50 50)" />
        </svg>
        <div className="ring-mid">
          <span className="ring-n"><CountUp value={value} /></span>
          {icon && <span className="ring-icon" style={{ color }}>{icon}</span>}
        </div>
      </div>
      <div className="ring-label">{label}</div>
      {sub && <div className="ring-sub">{sub}</div>}
    </Tag>
  );
}

/**
 * The tiny top-right progress ring from the app (its "92%" chip). Here it shows how
 * fresh the data is — full & teal when just imported, draining and reddening as it ages.
 */
export function MiniRing({ pct, color, children, title }: {
  pct: number; color: string; children: React.ReactNode; title?: string;
}) {
  const r = 15, C = 2 * Math.PI * r;
  return (
    <span className="mini-ring" title={title} style={{ ['--mr-c' as any]: color }}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--hairline-2)" strokeWidth="3" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, pct)))} transform="rotate(-90 20 20)" />
      </svg>
      <span className="mini-ring-txt">{children}</span>
    </span>
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
