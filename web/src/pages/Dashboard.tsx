import React, { useMemo, useState } from 'react';
import { api, fmtInt, fmtNum, type SkusResponse, type SkuResult } from '../api.ts';
import { StatusBadge, Flags, Tile, toast, downloadCsv } from '../components/ui.tsx';

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
  const [busy, setBusy] = useState(false);

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
    { n: wl.no_velocity, label: 'missing sales velocity', hint: 'set an expected rate', hash: '#/skus?status=AT_RISK', tone: 'var(--stockout)' },
  ].filter(i => i.n > 0) : [];

  return (
    <div className="page">
      <h1>Action Center</h1>
      <div className="h-sub">What needs a decision today, worst first. Every number can be audited on the SKU page.</div>

      <div className={`worklist${wlItems.length === 0 ? ' clear' : ''}`}>
        {wlItems.length === 0 ? (
          <span className="wl-clear">✓ Nothing to reconcile or update — the numbers below are current.</span>
        ) : (
          <>
            <span className="wl-title">Needs your attention</span>
            {wlItems.map((i, idx) => (
              <button key={idx} className="wl-item" style={{ ['--wl-c' as any]: i.tone }} onClick={() => go(i.hash)}>
                <span className="wl-n">{fmtInt(i.n)}</span>
                <span className="wl-lbl">{i.label}<em>{i.hint}</em></span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="tiles">
        <Tile n={s.stockout} label="Stocked out" color="var(--stockout)" sub="selling, zero available" onClick={() => setQueue('ship')} />
        <Tile n={s.critical} label="Stockout locked in" color="var(--critical)" sub="gap even if you act today" onClick={() => setQueue('po')} />
        <Tile n={s.ship_skus} label="Ship to FBA now" color="var(--ship)" sub={`${fmtInt(s.ship_units_total)} units ready`} selected={queue === 'ship'} onClick={() => setQueue('ship')} />
        <Tile n={s.po_skus} label="Add to China PO" color="var(--po)" sub={`${fmtInt(s.po_units_total)} units suggested`} selected={queue === 'po'} onClick={() => setQueue('po')} />
        <Tile n={s.at_risk + s.unclassified} label="At risk — review" color="var(--atrisk)" sub={`${s.unclassified} new to classify`} selected={queue === 'risk'} onClick={() => setQueue('risk')} />
        <Tile n={s.ok} label="Healthy" color="var(--ok)" sub={`${s.overstock} overstocked`} />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div className="tabs" style={{ border: 'none', margin: 0 }}>
            <button className={queue === 'ship' ? 'on' : ''} onClick={() => setQueue('ship')}>Ship to FBA ({shipRows.length})</button>
            <button className={queue === 'po' ? 'on' : ''} onClick={() => setQueue('po')}>Next China PO ({poRows.length})</button>
            <button className={queue === 'risk' ? 'on' : ''} onClick={() => setQueue('risk')}>At risk ({riskRows.length})</button>
          </div>
          <div className="spacer" />
          {queue !== 'risk' && (
            <>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {selectedRows.length} SKUs · {fmtInt(totalUnits)} units
              </span>
              <button className="btn primary" disabled={busy || selectedRows.length === 0}
                onClick={queue === 'ship' ? submitTransfers : exportPoProposal}>
                {queue === 'ship' ? 'Submit transfer request' : 'Export PO proposal'}
              </button>
            </>
          )}
        </div>

        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
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
                    <td style={{ maxWidth: 380, fontSize: 12 }}>{r.why}</td>
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
            <table className="data">
              <thead><tr>
                <th className="plain" style={{ width: 30 }}></th>
                <th className="plain">SKU</th>
                <th className="plain">Status</th>
                <th className="num">u/day</th>
                {queue === 'ship' ? (
                  <>
                    <th className="num">FBA cover</th>
                    <th className="num">Warehouse</th>
                    <th className="num">Ship qty</th>
                    <th className="num">After (days)</th>
                  </>
                ) : (
                  <>
                    <th className="num">Pipeline cover</th>
                    <th className="plain">Place by</th>
                    <th className="plain">Need by</th>
                    <th className="num">PO qty</th>
                  </>
                )}
                <th className="plain">Why</th>
              </tr></thead>
              <tbody>
                {activeRows.slice(0, 300).map(r => {
                  const key = `${queue}:${r.sku}`;
                  const qty = qtyOf(r);
                  const overdue = queue === 'po' && r.place_by_date && r.place_by_date < (data.today ?? '');
                  return (
                    <tr key={r.sku}>
                      <td><input type="checkbox" checked={!unchecked[key]} onChange={e => setUnchecked(u => ({ ...u, [key]: !e.target.checked }))} /></td>
                      <td><span className="sku-code" style={{ cursor: 'pointer' }} onClick={() => openSku(r.sku)}>{r.sku}</span>
                        <div className="cell-title" style={{ maxWidth: 250 }}>{r.title}</div></td>
                      <td><StatusBadge status={r.status} /> <Flags flags={r.flags} max={1} /></td>
                      <td className="num">{fmtNum(r.velocity)}</td>
                      {queue === 'ship' ? (
                        <>
                          <td className="num" style={{ color: (r.fba_days_cover ?? 999) < 14 ? 'var(--stockout)' : undefined, fontWeight: (r.fba_days_cover ?? 999) < 14 ? 700 : undefined }}>
                            {fmtNum(r.fba_days_cover, 0)}d</td>
                          <td className="num">{fmtInt(r.warehouse_on_hand)}</td>
                          <td className="num">
                            <input className={`cell-edit${edited[key] !== undefined ? ' dirty' : ''}`} type="number" min={0} value={qty}
                              onChange={e => setEdited(m => ({ ...m, [key]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                          </td>
                          <td className="num">{r.velocity ? Math.round(((r.fba_position + qty) / r.velocity)) : '—'}d</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{fmtNum(r.pipeline_days_cover, 0)}d</td>
                          <td className="mono" style={{ color: overdue ? 'var(--stockout)' : undefined, fontWeight: overdue ? 700 : undefined }}>
                            {r.place_by_date ?? '—'}{overdue ? ' !' : ''}</td>
                          <td className="mono">{r.need_by_arrival ?? '—'}</td>
                          <td className="num">
                            <input className={`cell-edit${edited[key] !== undefined ? ' dirty' : ''}`} type="number" min={0} value={qty}
                              onChange={e => setEdited(m => ({ ...m, [key]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                          </td>
                        </>
                      )}
                      <td style={{ minWidth: 230, maxWidth: 320 }}><div className="why" style={{ fontSize: 11.5, padding: '4px 8px' }}>{r.why}</div></td>
                    </tr>
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
