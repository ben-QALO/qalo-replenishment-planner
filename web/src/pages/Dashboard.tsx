import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtInt, fmtNum, STATUS_META, STATUS_TIERS, type SkusResponse, type SkuResult } from '../api.ts';
import { StatusBadge, Flags, toast, confirmDialog } from '../components/ui.tsx';
import { CountUp, ScoreGauge } from '../components/charts.tsx';

const ShipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
const OrderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5M12 13v8" />
  </svg>
);
const ReconcileIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8-5M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8 5" /><path d="M20 4v4h-4M4 20v-4h4" />
  </svg>
);

interface StatCardProps { label: string; value: number; sub: string; color: string; pct: number; icon: React.ReactNode; onClick: () => void; }
function StatCard({ label, value, sub, color, pct, icon, onClick }: StatCardProps) {
  return (
    <button className="stat-card" style={{ ['--card-c' as any]: color }} onClick={onClick}>
      <div className="sc-top"><span className="sc-icon">{icon}</span></div>
      <div className="sc-label">{label}</div>
      <div className="sc-n"><CountUp value={value} /></div>
      <div className="sc-sub">{sub}</div>
      <div className="sc-bar"><span style={{ width: `${Math.max(3, Math.min(100, pct * 100))}%` }} /></div>
    </button>
  );
}

const Chevron = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type QueueKey = 'ship' | 'po' | 'risk';

interface Worklist {
  transfers_to_review: number; transfers_to_send: number;
  transfers_to_reconcile: number; transfers_look_inbound: number; transfers_open_total: number;
  pos_to_action: number; new_products: number; no_velocity: number; total: number;
}

export function Dashboard({ data, worklist, refresh, openSku, go }: {
  data: SkusResponse; worklist: Worklist | null; refresh: () => void;
  openSku: (sku: string) => void; go: (hash: string) => void;
}) {
  const [queue, setQueue] = useState<QueueKey>('ship');
  const [edited, setEdited] = useState<Record<string, number>>({});
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const toggleExpand = (key: string) => setExpanded(m => ({ ...m, [key]: !m[key] }));

  // Column headers differ per queue, so reset any sort when switching queues.
  useEffect(() => { setSort(null); }, [queue]);
  const headerClick = (key: string) => setSort(s => (s && s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) } : { key, dir: 1 }));
  const arrow = (key: string) => (sort?.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  const s = data.summary;
  const results = data.results;

  // Default order across every queue: best sellers first (most units sold per day),
  // tie-broken by revenue per day.
  const byBestSeller = (a: SkuResult, b: SkuResult) =>
    (b.velocity ?? 0) - (a.velocity ?? 0) || (b.daily_revenue - a.daily_revenue);

  const shipRows = useMemo(() =>
    results.filter(r => r.include_in_plans && r.recommended_ship_qty > 0).sort(byBestSeller),
    [results]);
  const poRows = useMemo(() =>
    results.filter(r => r.include_in_plans && r.recommended_po_qty > 0).sort(byBestSeller),
    [results]);
  const riskRows = useMemo(() =>
    results.filter(r => r.status === 'AT_RISK' || r.status === 'UNCLASSIFIED'
      || (r.status === 'STOCKOUT' && r.recommended_ship_qty === 0 && r.classification === 'replenishable'))
      .sort(byBestSeller),
    [results]);

  const activeRows = queue === 'ship' ? shipRows : queue === 'po' ? poRows : riskRows;

  // Sortable queue: click a header to sort; falls back to each queue's default order.
  const sortVal = (r: SkuResult, key: string): number | string => {
    switch (key) {
      case 'sku': return r.sku;
      case 'status': return r.status;
      case 'place_by_date': return r.place_by_date ?? '9999-99-99';
      case 'velocity': return r.velocity ?? -1;
      case 'fba_days_cover': return r.fba_days_cover ?? Number.POSITIVE_INFINITY;
      case 'pipeline_days_cover': return r.pipeline_days_cover ?? Number.POSITIVE_INFINITY;
      case 'warehouse_on_hand': return r.warehouse_on_hand;
      case 'recommended_ship_qty': return r.recommended_ship_qty;
      case 'recommended_po_qty': return r.recommended_po_qty;
      default: return 0;
    }
  };
  const displayRows = useMemo(() => {
    if (!sort) return activeRows;
    return [...activeRows].sort((a, b) => {
      const av = sortVal(a, sort.key), bv = sortVal(b, sort.key);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
  }, [activeRows, sort]);

  const Th = ({ k, label, cls = '' }: { k: string; label: string; cls?: string }) => (
    <th className={`sortable ${cls}`} onClick={() => headerClick(k)}>{label}{arrow(k)}</th>
  );

  const qtyOf = (r: SkuResult) => edited[`${queue}:${r.sku}`] ?? (queue === 'ship' ? r.recommended_ship_qty : r.recommended_po_qty);
  const selectableRows = activeRows.filter(r => qtyOf(r) > 0);
  const selectedRows = selectableRows.filter(r => !unchecked[`${queue}:${r.sku}`]);
  const totalUnits = selectedRows.reduce((t, r) => t + qtyOf(r), 0);
  const allSelected = selectableRows.length > 0 && selectedRows.length === selectableRows.length;

  function toggleSelectAll() {
    const keys = selectableRows.map(r => `${queue}:${r.sku}`);
    setUnchecked(u => {
      const next = { ...u };
      if (allSelected) keys.forEach(k => { next[k] = true; });   // clear all
      else keys.forEach(k => { delete next[k]; });               // select all
      return next;
    });
  }

  async function submitTransfers() {
    if (selectedRows.length === 0) return;
    if (!await confirmDialog({
      title: `Create a transfer request for ${selectedRows.length} products?`,
      body: `${fmtInt(totalUnits)} units.\n\nThis starts a request the inventory team can review and adjust under Transfers & POs → Transfers to FBA. Nothing leaves your warehouse until it's finalized and sent.`,
      confirmLabel: 'Create request',
    })) return;
    setBusy(true);
    try {
      const lines = selectedRows.map(r => ({ sku: r.sku, qty: qtyOf(r) }));
      const res = await api.post<{ total_units: number; line_count: number }>('/api/transfers/propose', { lines });
      toast(`Request created — ${fmtInt(res.total_units)} units across ${res.line_count} products. The inventory team can review it under Transfers & POs → Transfers to FBA.`);
      setEdited({}); setUnchecked({});
      refresh();
    } catch (err: any) {
      toast(`Create failed: ${err.message}`);
    } finally { setBusy(false); }
  }

  async function proposePo() {
    if (selectedRows.length === 0) return;
    if (!await confirmDialog({
      title: `Create a PO for review for ${selectedRows.length} products?`,
      body: `${fmtInt(totalUnits)} units.\n\nThis starts a China PO the team can review and adjust under Transfers & POs → China POs. Nothing is ordered until it's finalized and placed.`,
      confirmLabel: 'Create PO for review',
    })) return;
    setBusy(true);
    try {
      const lines = selectedRows.map(r => ({ sku: r.sku, qty: qtyOf(r) }));
      const res = await api.post<{ total_units: number; line_count: number }>('/api/pos/propose', { lines });
      toast(`PO for review created — ${fmtInt(res.total_units)} units across ${res.line_count} products. Review it under Transfers & POs → China POs.`);
      setEdited({}); setUnchecked({});
      refresh();
    } catch (err: any) {
      toast(`Create failed: ${err.message}`);
    } finally { setBusy(false); }
  }

  async function quickFix(r: SkuResult, action: string) {
    try {
      if (action === 'replenishable' || action === 'ignore') {
        await api.patch(`/api/skus/${encodeURIComponent(r.sku)}`, { classification: action });
      } else if (action === 'velocity') {
        const v = window.prompt(`Expected daily sales for ${r.sku} (units/day):`);
        if (!v) return;
        await api.patch(`/api/skus/${encodeURIComponent(r.sku)}`, { velocity_override: Number(v) });
      }
      refresh();
    } catch (err: any) { toast(err.message); }
  }

  if (!s) return null;

  // Count per status TIER, for the catalog-map families (keyed to STATUS_META tiers).
  // The score, rings, and catalog map are scoped to the SKUs you actively keep in
  // stock (classification 'replenishable') — the same set the To ship / To order plan
  // rings use. New/undecided and discontinued items are left out so they don't distort
  // readiness. Status counts are tallied from those rows directly.
  const keepInStock = useMemo(() => results.filter(r => r.classification === 'replenishable'), [results]);
  const countOf = useMemo(() => {
    const c: Record<string, number> = {
      STOCKOUT: 0, CRITICAL: 0, ORDER_NOW: 0, ORDER_SOON: 0,
      OK: 0, OVERSTOCK: 0, AT_RISK: 0, UNCLASSIFIED: 0, NOT_REPLENISHABLE: 0,
    };
    for (const r of keepInStock) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [keepInStock]);

  const activeTotal = keepInStock.length;
  const share = (n: number) => (activeTotal === 0 ? 0 : n / activeTotal);

  // In-Stock Score — of the sales you're making, what share is on SKUs that are actually
  // in stock at Amazon. Weighted by velocity, so a top seller going dark hurts far more
  // than a trickle seller. A stockout you physically cannot fix this cycle — the warehouse
  // holds less than one full case, so nothing is shippable — is left out entirely rather
  // than counted against you.
  const settingsMap = data.settings ?? {};
  const blockedByCasePack = (r: SkuResult): boolean => {
    const cp = settingsMap[r.sku]?.case_pack ?? 0;
    return r.fba_available === 0 && r.recommended_ship_qty === 0
      && cp > 1 && r.warehouse_on_hand > 0 && r.warehouse_on_hand < cp;
  };
  const selling = keepInStock.filter(r => (r.velocity ?? 0) > 0);
  const scored = selling.filter(r => !blockedByCasePack(r));
  const wTotal = scored.reduce((sum, r) => sum + (r.velocity ?? 0), 0);
  const wInStock = scored.reduce((sum, r) => sum + (r.fba_available > 0 ? (r.velocity ?? 0) : 0), 0);
  const inStockScore = wTotal === 0 ? 100 : Math.round(100 * wInStock / wTotal);
  const excludedCasePack = selling.length - scored.length;

  const wl = worklist;
  const reconcileCount = (wl?.transfers_to_reconcile ?? 0) + (wl?.transfers_look_inbound ?? 0);
  const wlItems = wl ? [
    { n: wl.transfers_to_review, label: 'requests to review', hint: 'inventory team: check & adjust quantities', hash: '#/warehouse?tab=transfers', tone: 'var(--po)' },
    { n: wl.transfers_to_send, label: 'requests to send', hint: 'Amazon team: finalize & send to the warehouse', hash: '#/warehouse?tab=transfers', tone: 'var(--ship)' },
    { n: wl.transfers_to_reconcile, label: 'transfers to reconcile', hint: 'confirm created & inbound in Amazon', hash: '#/warehouse?tab=transfers', tone: 'var(--po)' },
    { n: wl.transfers_look_inbound, label: 'look inbound — reconcile', hint: 'Amazon appears to show these', hash: '#/warehouse?tab=transfers', tone: 'var(--ship)' },
    { n: wl.pos_to_action, label: 'POs to update', hint: 'draft to send, or overdue', hash: '#/warehouse?tab=pos', tone: 'var(--atrisk)' },
    { n: wl.new_products, label: 'new products to classify', hint: 'keep or ignore', hash: '#/skus?status=UNCLASSIFIED', tone: 'var(--atrisk)' },
    { n: wl.no_velocity, label: 'missing a sales rate', hint: 'set expected units sold per day', hash: '#/skus?flag=NO_VELOCITY', tone: 'var(--stockout)' },
  ].filter(i => i.n > 0) : [];

  const coverClass = (d: number | null) => d === null ? '' : d < 14 ? 'q-cover hot' : d < 30 ? 'q-cover warn' : 'q-cover';

  return (
    <div className="page">
      <h1>Action Center</h1>
      <div className="h-sub">What needs a decision today. Clear the tasks up top, then work the queue — every number opens its full reasoning.</div>

      {wlItems.length > 0 && (
        <div className="worklist">
          <span className="wl-title">To do first</span>
          {wlItems.map((i, idx) => (
            <button key={idx} className="wl-item" title={i.hint} style={{ ['--wl-c' as any]: i.tone }} onClick={() => go(i.hash)}>
              <span className="wl-n">{fmtInt(i.n)}</span>
              <span className="wl-lbl">{i.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="home-top">
        <div className="summary score-block">
          <div className="sum-hero">
            <ScoreGauge score={inStockScore} eyebrow="IN STOCK"
              caption={excludedCasePack > 0
                ? `sales-weighted · ${excludedCasePack} case-pack-blocked excluded`
                : 'of sales, weighted by top sellers'} />
            <div className="hero-alerts">
              <button className="sum-fig" style={{ ['--sf-c' as any]: 'var(--danger)' }} onClick={() => setQueue('ship')}>
                <div className="n"><CountUp value={countOf.STOCKOUT} /></div>
                <div className="lbl">{STATUS_META.STOCKOUT.label}</div>
                <div className="sub">selling, zero at Amazon</div>
              </button>
              <button className="sum-fig" style={{ ['--sf-c' as any]: 'var(--danger)' }} onClick={() => setQueue('po')}>
                <div className="n"><CountUp value={countOf.CRITICAL} /></div>
                <div className="lbl">{STATUS_META.CRITICAL.label}</div>
                <div className="sub">gap even if you act today</div>
              </button>
            </div>
          </div>
        </div>

        <div className="stat-cards side">
          <StatCard label="To ship" value={s.ship_units_total} sub={`units to Amazon · ${fmtInt(s.ship_skus)} SKUs`}
            color="var(--c-ship)" pct={share(s.ship_skus)} icon={<ShipIcon />} onClick={() => setQueue('ship')} />
          <StatCard label="To order" value={s.po_units_total} sub={`units from China · ${fmtInt(s.po_skus)} SKUs`}
            color="var(--c-order)" pct={share(s.po_skus)} icon={<OrderIcon />} onClick={() => setQueue('po')} />
          <StatCard label="To reconcile" value={reconcileCount} sub="transfers to confirm inbound"
            color="var(--c-health)" pct={wl && wl.transfers_open_total > 0 ? reconcileCount / wl.transfers_open_total : 0}
            icon={<ReconcileIcon />} onClick={() => go('#/warehouse?tab=transfers')} />
        </div>
      </div>

      <details className="status-key">
        <summary>What the labels mean</summary>
        <div className="status-key-grid">
          {STATUS_TIERS.map(t => (
            <div key={t} className="status-key-row">
              <StatusBadge status={t} />
              <span>{STATUS_META[t].help}</span>
            </div>
          ))}
        </div>
      </details>

      <div className="card">
        <div className="card-head">
          <div className="segmented">
            <button className={queue === 'ship' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--ship)' }} onClick={() => setQueue('ship')}>
              Ship to FBA <span className="seg-n">{shipRows.length}</span></button>
            <button className={queue === 'po' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--po)' }} onClick={() => setQueue('po')}>
              China PO <span className="seg-n">{poRows.length}</span></button>
            <button className={queue === 'risk' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--atrisk)' }} onClick={() => setQueue('risk')}>
              Needs info <span className="seg-n">{riskRows.length}</span></button>
          </div>
          <div className="spacer" />
          {queue !== 'risk' && (
            <>
              <button className="btn sm" disabled={selectableRows.length === 0} onClick={toggleSelectAll}>
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {selectedRows.length} selected · {fmtInt(totalUnits)} units
              </span>
              <button className="btn primary" disabled={busy || selectedRows.length === 0}
                onClick={queue === 'ship' ? submitTransfers : proposePo}>
                {queue === 'ship' ? 'Create transfer for review' : 'Create PO for review'}
              </button>
            </>
          )}
        </div>

        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {activeRows.length === 0 ? (
            <div className="empty">
              {queue === 'ship' && 'Nothing to ship — either FBA is covered, or the warehouse is empty (import your NetSuite warehouse report on the Imports page).'}
              {queue === 'po' && 'No PO recommendations right now.'}
              {queue === 'risk' && 'No data problems. Everything is classified and has a sales rate.'}
            </div>
          ) : queue === 'risk' ? (
            <table className="data">
              <thead><tr>
                <th className="plain">SKU</th><th className="plain">Status</th><th className="plain">Why</th><th className="plain">Fix</th>
              </tr></thead>
              <tbody>
                {riskRows.slice(0, 200).map(r => (
                  <tr key={r.sku}>
                    <td><span className="sku-code" style={{ cursor: 'pointer' }} onClick={() => openSku(r.sku)}>{r.sku}</span>
                      <div className="cell-title">{r.title}</div></td>
                    <td><StatusBadge status={r.status} /> <Flags flags={r.flags} max={2} /></td>
                    <td style={{ maxWidth: 400 }}><span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 13, color: 'var(--ink-2)' }}>{r.why}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.status === 'UNCLASSIFIED' && (
                        <>
                          <button className="btn sm" onClick={() => quickFix(r, 'replenishable')}>Replenish</button>{' '}
                          <button className="btn sm" onClick={() => quickFix(r, 'ignore')}>Ignore</button>
                        </>
                      )}
                      {r.flags.includes('NO_VELOCITY') && (
                        <button className="btn sm" onClick={() => quickFix(r, 'velocity')}>Set velocity</button>
                      )}
                      {r.status === 'STOCKOUT' && !r.flags.includes('NO_VELOCITY') && r.classification === 'replenishable' && (
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>needs warehouse stock or a PO</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="queue">
              <thead><tr>
                <th className="plain" style={{ width: 26 }}></th>
                <th className="plain" style={{ width: 28 }}></th>
                <Th k="sku" label="Product" />
                <Th k="status" label="Status" />
                <Th k="velocity" label="Sold/day" cls="num" />
                {queue === 'ship' ? (
                  <><Th k="fba_days_cover" label="Days left at Amazon" cls="num" /><Th k="warehouse_on_hand" label="In warehouse" cls="num" /><Th k="recommended_ship_qty" label="Units to ship" cls="num" /></>
                ) : (
                  <><Th k="pipeline_days_cover" label="Days left (total)" cls="num" /><Th k="place_by_date" label="Order by" /><Th k="recommended_po_qty" label="Units to order" cls="num" /></>
                )}
              </tr></thead>
              <tbody>
                {displayRows.slice(0, 300).map(r => {
                  const key = `${queue}:${r.sku}`;
                  const qty = qtyOf(r);
                  const isOpen = !!expanded[key];
                  const overdue = queue === 'po' && r.place_by_date && r.place_by_date < (data.today ?? '');
                  const stop = (e: React.MouseEvent) => e.stopPropagation();
                  return (
                    <React.Fragment key={r.sku}>
                      <tr className={`qrow${isOpen ? ' open' : ''}`} onClick={() => toggleExpand(key)}>
                        <td className="q-expand"><Chevron /></td>
                        <td onClick={stop}><input type="checkbox" checked={!unchecked[key]} onChange={e => setUnchecked(u => ({ ...u, [key]: !e.target.checked }))} /></td>
                        <td onClick={stop}>
                          <span className="sku-code" style={{ cursor: 'pointer' }} onClick={() => openSku(r.sku)}>{r.sku}</span>
                          <div className="cell-title" style={{ maxWidth: 260 }}>{r.title}</div>
                        </td>
                        <td><StatusBadge status={r.status} /> <Flags flags={r.flags} max={1} /></td>
                        <td className="num">{fmtNum(r.velocity)}</td>
                        {queue === 'ship' ? (
                          <>
                            <td className="num"><span className={coverClass(r.fba_days_cover)}>{fmtNum(r.fba_days_cover, 0)}d</span></td>
                            <td className="num">{fmtInt(r.warehouse_on_hand)}</td>
                            <td className="num" onClick={stop}>
                              <input className={`cell-edit${edited[key] !== undefined ? ' dirty' : ''}`} type="number" min={0} value={qty}
                                onChange={e => setEdited(m => ({ ...m, [key]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num"><span className={coverClass(r.pipeline_days_cover)}>{fmtNum(r.pipeline_days_cover, 0)}d</span></td>
                            <td className="mono" style={{ color: overdue ? 'var(--stockout)' : undefined, fontWeight: overdue ? 700 : undefined }}>
                              {r.place_by_date ?? '—'}{overdue ? ' !' : ''}</td>
                            <td className="num" onClick={stop}>
                              <input className={`cell-edit${edited[key] !== undefined ? ' dirty' : ''}`} type="number" min={0} value={qty}
                                onChange={e => setEdited(m => ({ ...m, [key]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                            </td>
                          </>
                        )}
                      </tr>
                      {isOpen && (
                        <tr className="q-detail">
                          <td colSpan={8}>
                           <div className="q-detail-inner">
                            <div className="why">{r.why}</div>
                            <div className="math">
                              <div><div className="k">Sold/day</div><div className="v">{fmtNum(r.velocity)}</div></div>
                              {queue === 'ship' ? (
                                <>
                                  <div><div className="k">At / heading to Amazon</div><div className="v">{fmtInt(r.fba_position)}</div></div>
                                  <div><div className="k">Days of stock left</div><div className="v">{fmtNum(r.fba_days_cover, 0)}d</div></div>
                                  <div><div className="k">Need to hit goal</div><div className="v">{fmtInt(r.transfer_required)}</div></div>
                                  <div><div className="k">Warehouse can spare</div><div className="v">{fmtInt(r.transfer_safe)}</div></div>
                                  {r.transfer_shortage > 0 && <div><div className="k" style={{ color: 'var(--stockout)' }}>Short by</div><div className="v" style={{ color: 'var(--stockout)' }}>{fmtInt(r.transfer_shortage)}</div></div>}
                                  <div><div className="k">Stock when it lands</div><div className="v">{r.velocity && r.fba_days_cover !== null ? `${Math.round(r.fba_target_days)}d goal` : '—'}</div></div>
                                </>
                              ) : (
                                <>
                                  <div><div className="k">Total across pipeline</div><div className="v">{fmtInt(r.total_pipeline)}</div></div>
                                  <div><div className="k">Days of stock left</div><div className="v">{fmtNum(r.pipeline_days_cover, 0)}d</div></div>
                                  <div><div className="k">Lands at warehouse</div><div className="v">{r.need_by_arrival ?? '—'}</div></div>
                                  <div><div className="k">Place order by</div><div className="v">{r.place_by_date ?? '—'}</div></div>
                                </>
                              )}
                              <div style={{ alignSelf: 'flex-end' }}>
                                <button className="btn sm" onClick={() => openSku(r.sku)}>Open full detail →</button>
                              </div>
                            </div>
                           </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
