import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtInt, fmtNum, type SkusResponse, type SkuResult } from '../api.ts';
import { StatusBadge, Flags, toast, downloadCsv } from '../components/ui.tsx';
import { CatalogDotMap, CountUp } from '../components/charts.tsx';

const Chevron = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type QueueKey = 'ship' | 'po' | 'risk';

interface Worklist {
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

  const shipRows = useMemo(() =>
    results.filter(r => r.include_in_plans && r.recommended_ship_qty > 0)
      .sort((a, b) => (a.fba_days_cover ?? 9999) - (b.fba_days_cover ?? 9999)),
    [results]);
  const poRows = useMemo(() =>
    results.filter(r => r.include_in_plans && r.recommended_po_qty > 0)
      .sort((a, b) => (a.place_by_date ?? '9999').localeCompare(b.place_by_date ?? '9999')),
    [results]);
  const riskRows = useMemo(() =>
    results.filter(r => r.status === 'AT_RISK' || r.status === 'UNCLASSIFIED'
      || (r.status === 'STOCKOUT' && r.recommended_ship_qty === 0 && r.classification === 'replenishable'))
      .sort((a, b) => b.risk_score - a.risk_score),
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
  const selectedRows = activeRows.filter(r => !unchecked[`${queue}:${r.sku}`] && qtyOf(r) > 0);
  const totalUnits = selectedRows.reduce((t, r) => t + qtyOf(r), 0);

  async function submitTransfers() {
    if (selectedRows.length === 0) return;
    if (!window.confirm(`Submit a transfer request for ${selectedRows.length} SKUs (${fmtInt(totalUnits)} units)?\n\nThis drops the units from usable warehouse stock now, and downloads the request file for the inventory team. You'll reconcile each one next session once it's inbound in Amazon.`)) return;
    setBusy(true);
    try {
      const lines = selectedRows.map(r => ({ sku: r.sku, qty: qtyOf(r) }));
      const res = await api.post<{ filename: string; csv: string; total_units: number }>('/api/transfers/submit', { lines });
      downloadCsv(res.filename, res.csv);
      toast(`Transfer request submitted — ${fmtInt(res.total_units)} units across ${lines.length} SKUs. Warehouse updated.`);
      setEdited({}); setUnchecked({});
      refresh();
    } catch (err: any) {
      toast(`Submit failed: ${err.message}`);
    } finally { setBusy(false); }
  }

  async function exportPoProposal() {
    if (selectedRows.length === 0) return;
    setBusy(true);
    try {
      const lines = selectedRows.map(r => ({ sku: r.sku, qty_recommended: r.recommended_po_qty, qty_final: qtyOf(r) }));
      const res = await api.post<{ id: number; filename: string; csv: string; total_units: number }>('/api/plans', { kind: 'china_po', lines });
      downloadCsv(res.filename, res.csv);
      toast(`${res.filename} — ${fmtInt(res.total_units)} units across ${lines.length} SKUs`);
      if (window.confirm('Also create a draft purchase order from this proposal?')) {
        await api.post(`/api/plans/${res.id}/create-po`);
        toast('Draft PO created — set its number and ETA under Warehouse & POs.');
      }
      setEdited({}); setUnchecked({});
      refresh();
    } catch (err: any) {
      toast(`Export failed: ${err.message}`);
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

  const wl = worklist;
  const wlItems = wl ? [
    { n: wl.transfers_to_reconcile, label: 'transfers to reconcile', hint: 'confirm created & inbound in Amazon', hash: '#/warehouse?tab=transfers', tone: 'var(--po)' },
    { n: wl.transfers_look_inbound, label: 'look inbound — reconcile', hint: 'Amazon appears to show these', hash: '#/warehouse?tab=transfers', tone: 'var(--ship)' },
    { n: wl.pos_to_action, label: 'POs to update', hint: 'draft to send, or overdue', hash: '#/warehouse?tab=pos', tone: 'var(--atrisk)' },
    { n: wl.new_products, label: 'new products to classify', hint: 'keep or ignore', hash: '#/skus?status=UNCLASSIFIED', tone: 'var(--atrisk)' },
    { n: wl.no_velocity, label: 'missing sales velocity', hint: 'set an expected rate', hash: '#/skus?flag=NO_VELOCITY', tone: 'var(--stockout)' },
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

      <div className="summary">
        <div className="sum-alert">
          <button className="sum-fig" style={{ ['--sf-c' as any]: 'var(--danger)' }} onClick={() => setQueue('ship')}>
            <div className="n"><CountUp value={s.stockout} /></div>
            <div className="lbl">Stocked out</div>
            <div className="sub">selling, zero at Amazon</div>
          </button>
          <button className="sum-fig" style={{ ['--sf-c' as any]: 'var(--danger)' }} onClick={() => setQueue('po')}>
            <div className="n"><CountUp value={s.critical} /></div>
            <div className="lbl">Will stock out</div>
            <div className="sub">gap even if you act today</div>
          </button>
        </div>
        <div className="sum-map">
          <div className="sum-map-head">
            <span className="wl-title">Catalog · {fmtInt(s.ok + s.stockout + s.critical + s.order_now + s.order_soon + s.at_risk + s.overstock + s.unclassified)} SKUs</span>
            <div className="map-legend">
              <span><i className="tone-danger" />{fmtInt(s.stockout + s.critical)} urgent</span>
              <span><i className="tone-ink" />{fmtInt(s.order_now + s.order_soon)} to order</span>
              <span><i className="tone-mid" />{fmtInt(s.ok)} healthy</span>
              <span><i className="tone-faint" />{fmtInt(s.overstock)} overstock</span>
              <span><i className="tone-ring" />{fmtInt(s.at_risk + s.unclassified)} at risk</span>
            </div>
          </div>
          <CatalogDotMap results={results} onPick={(status) => go(`#/skus?status=${status}`)} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="segmented">
            <button className={queue === 'ship' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--ship)' }} onClick={() => setQueue('ship')}>
              Ship to FBA <span className="seg-n">{shipRows.length}</span></button>
            <button className={queue === 'po' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--po)' }} onClick={() => setQueue('po')}>
              China PO <span className="seg-n">{poRows.length}</span></button>
            <button className={queue === 'risk' ? 'on' : ''} style={{ ['--seg-c' as any]: 'var(--atrisk)' }} onClick={() => setQueue('risk')}>
              At risk <span className="seg-n">{riskRows.length}</span></button>
          </div>
          <div className="spacer" />
          {queue !== 'risk' && (
            <>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {selectedRows.length} selected · {fmtInt(totalUnits)} units
              </span>
              <button className="btn primary" disabled={busy || selectedRows.length === 0}
                onClick={queue === 'ship' ? submitTransfers : exportPoProposal}>
                {queue === 'ship' ? 'Submit transfer request' : 'Export PO proposal'}
              </button>
            </>
          )}
        </div>

        <div style={{ maxHeight: 560, overflowY: 'auto' }}>
          {activeRows.length === 0 ? (
            <div className="empty">
              {queue === 'ship' && 'Nothing to ship — either FBA is covered, or the warehouse is empty (enter warehouse stock under Warehouse & POs).'}
              {queue === 'po' && 'No PO recommendations right now.'}
              {queue === 'risk' && 'No data problems. Everything is classified and has a velocity.'}
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
                <Th k="sku" label="SKU" />
                <Th k="status" label="Status" />
                <Th k="velocity" label="u/day" cls="num" />
                {queue === 'ship' ? (
                  <><Th k="fba_days_cover" label="FBA cover" cls="num" /><Th k="warehouse_on_hand" label="Warehouse" cls="num" /><Th k="recommended_ship_qty" label="Ship qty" cls="num" /></>
                ) : (
                  <><Th k="pipeline_days_cover" label="Pipeline cover" cls="num" /><Th k="place_by_date" label="Place by" /><Th k="recommended_po_qty" label="PO qty" cls="num" /></>
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
                              <div><div className="k">Velocity</div><div className="v">{fmtNum(r.velocity)}/day</div></div>
                              {queue === 'ship' ? (
                                <>
                                  <div><div className="k">At / heading to Amazon</div><div className="v">{fmtInt(r.fba_position)}</div></div>
                                  <div><div className="k">FBA cover</div><div className="v">{fmtNum(r.fba_days_cover, 0)}d</div></div>
                                  <div><div className="k">Reorder at</div><div className="v">{r.fba_rop_days}d</div></div>
                                  <div><div className="k">FBA target</div><div className="v">{r.fba_target_days}d</div></div>
                                  <div><div className="k">Warehouse usable</div><div className="v">{fmtInt(r.warehouse_on_hand)}</div></div>
                                  <div><div className="k">Cover after shipping {fmtInt(qty)}</div><div className="v">{r.velocity ? Math.round((r.fba_position + qty) / r.velocity) : '—'}d</div></div>
                                </>
                              ) : (
                                <>
                                  <div><div className="k">Total pipeline</div><div className="v">{fmtInt(r.total_pipeline)}</div></div>
                                  <div><div className="k">Pipeline cover</div><div className="v">{fmtNum(r.pipeline_days_cover, 0)}d</div></div>
                                  <div><div className="k">Reorder at</div><div className="v">{r.po_rop_days}d</div></div>
                                  <div><div className="k">Total target</div><div className="v">{r.po_target_days}d</div></div>
                                  <div><div className="k">Need by</div><div className="v">{r.need_by_arrival ?? '—'}</div></div>
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
