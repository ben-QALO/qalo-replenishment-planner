import React, { useEffect, useState } from 'react';
import { api, fmtInt, type SkusResponse } from '../api.ts';
import { toast, downloadCsv, confirmDialog } from '../components/ui.tsx';

/**
 * A blur-to-save inline text/number editor. Defined at MODULE scope (not inside a component
 * body) so its identity is stable across parent renders — otherwise React remounts the
 * <input> on every keystroke and the field loses focus after one character.
 */
function InlineEdit({ value, onChange, onSave, className = 'field', dirty = false, type = 'text', min, style, stopPropagation = false }: {
  value: string | number; onChange: (v: string) => void; onSave: () => void;
  className?: string; dirty?: boolean; type?: string; min?: number; style?: React.CSSProperties; stopPropagation?: boolean;
}) {
  return (
    <input className={`${className}${dirty ? ' dirty' : ''}`} type={type} min={min} style={style} value={value}
      onClick={stopPropagation ? (e => e.stopPropagation()) : undefined}
      onChange={e => onChange(e.target.value)}
      onBlur={onSave}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

export function WarehousePos({ data, refresh, initialTab }: { data: SkusResponse; refresh: () => void; initialTab?: string | null }) {
  const [tab, setTab] = useState<'transfers' | 'pos'>(initialTab === 'pos' ? 'pos' : 'transfers');
  return (
    <div className="page">
      <h1>Transfers &amp; POs</h1>
      <div className="h-sub">The things Amazon can't see: transfers in flight from your US warehouse to FBA, and what's on order from China. Keep these current and the recommendations stay honest. (Warehouse stock is set by the NetSuite import on the Imports page.)</div>
      <div className="tabs">
        <button className={tab === 'transfers' ? 'on' : ''} onClick={() => setTab('transfers')}>Transfers to FBA</button>
        <button className={tab === 'pos' ? 'on' : ''} onClick={() => setTab('pos')}>China POs</button>
      </div>
      {tab === 'transfers' && <Transfers data={data} refresh={refresh} />}
      {tab === 'pos' && <Pos refresh={refresh} />}
    </div>
  );
}

const TRANSFER_STATUS_META: Record<string, { c: string; bg: string; label: string }> = {
  proposed: { c: 'var(--atrisk)', bg: 'var(--atrisk-bg)', label: 'awaiting review' },
  reviewed: { c: 'var(--po)', bg: 'var(--po-bg)', label: 'reviewed — ready to export' },
  reconciled: { c: 'var(--ok)', bg: 'var(--ok-bg)', label: 'exported' },
  cancelled: { c: 'var(--neutral)', bg: 'var(--neutral-bg)', label: 'cancelled' },
  draft: { c: 'var(--atrisk)', bg: 'var(--atrisk-bg)', label: 'draft' },
};

// A shipment = the batch of lines created and reviewed together.
type Batch = { key: string; rows: any[] };
function groupByBatch(rows: any[]): Batch[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = r.batch_id ?? `single-${r.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, rows }));
}

function Transfers({ data, refresh }: { data: SkusResponse; refresh: () => void }) {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [qtyEdits, setQtyEdits] = useState<Record<number, string>>({});
  const [reviewNote, setReviewNote] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [batchNameEdits, setBatchNameEdits] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState<{ key: 'sku' | 'qty'; dir: 1 | -1 }>({ key: 'sku', dir: 1 });
  const load = () => api.get<{ transfers: any[] }>('/api/transfers').then(d => setTransfers(d.transfers));
  useEffect(() => { load(); }, []);

  // Sort SKUs within a shipment, and edit the shipment's name.
  const sortRows = (rows: any[]) => [...rows].sort((a, b) => {
    const va = sortKey.key === 'sku' ? a.sku : a.qty, vb = sortKey.key === 'sku' ? b.sku : b.qty;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortKey.dir;
  });
  const headerSort = (key: 'sku' | 'qty') => setSortKey(s => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  const sortArrow = (key: string) => (sortKey.key === key ? (sortKey.dir === 1 ? ' ↑' : ' ↓') : '');
  async function renameBatch(batchId: string) {
    const name = (batchNameEdits[batchId] ?? '').trim();
    if (!name) { setBatchNameEdits(m => { const n = { ...m }; delete n[batchId]; return n; }); return; }
    try {
      await api.post('/api/transfers/batch/rename', { batch_id: batchId, name });
      setBatchNameEdits(m => { const n = { ...m }; delete n[batchId]; return n; });
      load();
    } catch (e: any) { toast(e.message); }
  }

  // Latest usable warehouse stock per SKU, so the inventory team can sanity-check each ask.
  const whBySku = new Map(data.results.map(r => [r.sku, r.warehouse_on_hand]));
  const whOf = (sku: string) => whBySku.get(sku) ?? 0;

  const proposed = transfers.filter(t => t.status === 'proposed');
  const reviewed = transfers.filter(t => t.status === 'reviewed');
  const closed = transfers.filter(t => t.status === 'reconciled' || t.status === 'cancelled');
  const todayStr = new Date().toISOString().slice(0, 10);
  const ageDays = (d: string | null) => d ? Math.round((Date.parse(todayStr) - Date.parse(d.slice(0, 10))) / 86400000) : 0;
  const units = (rows: any[]) => rows.reduce((s, r) => s + (r.qty ?? 0), 0);

  // Shipment collapse: `collapsed` holds the batches whose state is flipped from their stage
  // default (proposed/reviewed default open, in-transit default collapsed).
  const isOpen = (key: string, defOpen: boolean) => collapsed.has(key) ? !defOpen : defOpen;
  const toggleBatch = (key: string) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const setAll = (open: boolean) => {
    // A group is flipped iff the requested state differs from its stage default.
    const defs: [string, boolean][] = [
      ...groupByBatch(proposed).map(b => [b.key, true] as [string, boolean]),
      ...groupByBatch(reviewed).map(b => [b.key, true] as [string, boolean]),
    ];
    setCollapsed(new Set(defs.filter(([, d]) => open !== d).map(([k]) => k)));
  };

  const selIn = (rows: any[]) => rows.filter(r => sel.has(r.id)).map(r => r.id);
  const toggleSection = (rows: any[], checked: boolean) =>
    setSel(prev => { const n = new Set(prev); rows.forEach(r => checked ? n.add(r.id) : n.delete(r.id)); return n; });
  const toggleRow = (id: number, checked: boolean) =>
    setSel(prev => { const n = new Set(prev); checked ? n.add(id) : n.delete(id); return n; });
  const clearSel = () => setSel(new Set());

  async function saveQty(id: number) {
    const raw = qtyEdits[id];
    if (raw === undefined) return;
    const q = Math.round(Number(raw));
    if (!Number.isFinite(q) || q <= 0) { toast('Quantity must be a positive number.'); return; }
    try {
      await api.patch(`/api/transfers/${id}`, { qty: q });
      setQtyEdits(e => { const n = { ...e }; delete n[id]; return n; });
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }
  async function reviewSel(ids: number[]) {
    if (ids.length === 0) return;
    try {
      const res = await api.post<{ reviewed: number }>('/api/transfers/review-bulk', { ids, note: reviewNote || undefined });
      toast(`${res.reviewed} request(s) marked reviewed — ready for the Amazon team to send.`);
      clearSel(); setReviewNote(''); load(); refresh();
    } catch (err: any) { toast(err.message); }
  }
  async function reopenSel(ids: number[]) {
    if (ids.length === 0) return;
    try {
      const res = await api.post<{ reopened: number }>('/api/transfers/reopen-bulk', { ids });
      toast(`${res.reopened} request(s) sent back to the inventory team.`);
      clearSel(); load(); refresh();
    } catch (err: any) { toast(err.message); }
  }
  async function exportSel(ids: number[]) {
    if (ids.length === 0) return;
    if (!await confirmDialog({
      title: `Export ${ids.length} request(s)?`,
      body: `Downloads the warehouse request file and marks these done for this cycle. This does NOT change any warehouse numbers — create the real shipment in Amazon, and your next NetSuite + Amazon upload will reflect it.`,
      confirmLabel: 'Export request',
    })) return;
    try {
      const res = await api.post<{ filename: string; csv: string; line_count: number; total_units: number }>('/api/transfers/export-bulk', { ids });
      downloadCsv(res.filename, res.csv);
      toast(`Exported ${res.line_count} line(s) — ${fmtInt(res.total_units)} units. File downloaded.`);
      clearSel(); load(); refresh();
    } catch (err: any) { toast(err.message); }
  }
  async function cancelSel(ids: number[]) {
    if (ids.length === 0) return;
    if (!await confirmDialog({
      title: `Cancel ${ids.length} request(s)?`,
      body: 'Removes them from the worksheet. Nothing to undo — the tool never changed your warehouse numbers.',
      confirmLabel: 'Cancel requests', cancelLabel: 'Keep', danger: true,
    })) return;
    try {
      const res = await api.post<{ cancelled: number }>('/api/transfers/cancel-bulk', { ids });
      toast(`${res.cancelled} cancelled.`);
      clearSel(); load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  const RowBox = ({ id }: { id: number }) => (
    <input type="checkbox" checked={sel.has(id)} onChange={e => toggleRow(id, e.target.checked)} />
  );
  const qtyInput = (t: any) => (
    <InlineEdit type="number" min={1} className="cell-edit" style={{ width: 72 }}
      value={qtyEdits[t.id] ?? t.qty} dirty={qtyEdits[t.id] !== undefined}
      onChange={v => setQtyEdits(m => ({ ...m, [t.id]: v }))} onSave={() => saveQty(t.id)} />
  );
  const Requested = ({ t }: { t: any }) =>
    (t.requested_qty != null && t.requested_qty !== t.qty)
      ? <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>asked {fmtInt(t.requested_qty)}</span>
      : <span style={{ color: 'var(--muted)' }}>—</span>;
  // Latest warehouse stock; flagged red when it can't cover the current quantity.
  const WhCell = ({ t }: { t: any }) => {
    const wh = whOf(t.sku), short = wh < (t.qty ?? 0);
    return <span className="mono" title={short ? 'Warehouse can’t cover this quantity' : 'Units in your warehouse'}
      style={{ color: short ? 'var(--stockout)' : undefined, fontWeight: short ? 700 : undefined }}>{fmtInt(wh)}{short ? ' ⚠' : ''}</span>;
  };
  const Product = ({ t }: { t: any }) => (
    <><span className="sku-code">{t.sku}</span><div className="cell-title" style={{ maxWidth: 300 }}>{t.title}</div></>
  );

  // Shipment header row (a full-width cell inside a per-batch <tbody>).
  function shipHead(b: Batch, colSpan: number, defOpen: boolean, dateLabel: string, actions: React.ReactNode) {
    const open = isOpen(b.key, defOpen);
    const allSel = b.rows.length > 0 && b.rows.every(r => sel.has(r.id));
    const isSingle = b.key.startsWith('single-');
    const batchName = b.rows[0]?.batch_name;
    const changed = b.rows.filter(r => r.requested_qty != null && r.requested_qty !== r.qty).length;
    return (
      <tr className="ship-group">
        <td colSpan={colSpan}>
          <div className="ship-head">
            <button className={`caret${open ? ' open' : ''}`} onClick={() => toggleBatch(b.key)} aria-label={open ? 'Collapse' : 'Expand'}>▸</button>
            <input type="checkbox" checked={allSel} onClick={e => e.stopPropagation()} onChange={e => toggleSection(b.rows, e.target.checked)} />
            {isSingle
              ? <span className="mono ship-id">—</span>
              : <InlineEdit style={{ fontWeight: 600, width: 210, fontSize: 12 }} stopPropagation
                  value={batchNameEdits[b.key] ?? batchName ?? b.key}
                  onChange={v => setBatchNameEdits(m => ({ ...m, [b.key]: v }))}
                  onSave={() => renameBatch(b.key)} />}
            <span className="ship-meta">{dateLabel} · {b.rows.length} SKU{b.rows.length === 1 ? '' : 's'} · {fmtInt(units(b.rows))} units{changed > 0 ? ` · ${changed} adjusted` : ''}</span>
            <div className="spacer" />
            {actions}
          </div>
        </td>
      </tr>
    );
  }

  const anyOpen = transfers.length > 0;

  return (
    <>
      <div className="toolbar">
        <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>
          Requests flow left to right: the <b>Amazon team</b> creates them from the Action Center → the <b>inventory
          team</b> reviews and adjusts quantities → the <b>Amazon team</b> exports the finalized request and makes the
          real shipment in Amazon. This is a worksheet — it never changes your warehouse numbers (NetSuite + Amazon do).
        </span>
        {anyOpen && (
          <>
            <button className="btn sm" onClick={() => setAll(true)}>Expand all</button>
            <button className="btn sm" onClick={() => setAll(false)}>Collapse all</button>
          </>
        )}
        <a className="btn sm" href="/api/transfers/export.csv">⭳ Export CSV</a>
      </div>

      {/* STEP 2 — inventory team reviews */}
      <div className="card">
        <div className="card-head">
          <h3>Proposed — inventory team to review</h3>
          <span className="stage-meta">{proposed.length} SKU{proposed.length === 1 ? '' : 's'} · {fmtInt(units(proposed))} units</span>
          <div className="spacer" />
          {selIn(proposed).length > 0 && (
            <>
              <input className="field" style={{ width: 200 }} placeholder="Optional note on the adjustment…"
                value={reviewNote} onChange={e => setReviewNote(e.target.value)} />{' '}
              <button className="btn sm primary" onClick={() => reviewSel(selIn(proposed))}>Mark {selIn(proposed).length} reviewed</button>{' '}
              <button className="btn sm danger" onClick={() => cancelSel(selIn(proposed))}>Cancel {selIn(proposed).length}</button>
            </>
          )}
        </div>
        {proposed.length === 0 ? <div className="empty">Nothing awaiting review. The Amazon team creates requests from the Action Center → Ship to FBA.</div> : (
          <table className="data">
            <thead><tr>
              <th className="plain" style={{ width: 32 }}></th>
              <th className="plain sortable" style={{ cursor: 'pointer' }} onClick={() => headerSort('sku')}>Product{sortArrow('sku')}</th><th className="num">In warehouse</th><th className="num sortable" style={{ cursor: 'pointer' }} onClick={() => headerSort('qty')}>Qty (editable){sortArrow('qty')}</th><th className="num">Originally asked</th>
              <th className="plain">Age</th><th className="plain"></th>
            </tr></thead>
            {groupByBatch(proposed).map(b => {
              const open = isOpen(b.key, true);
              const ids = b.rows.map(r => r.id);
              return (
                <tbody key={b.key}>
                  {shipHead(b, 7, true, `created ${ageDays(b.rows[0].created_at)}d ago`, (
                    <>
                      <button className="btn sm primary" onClick={() => reviewSel(ids)}>Mark shipment reviewed</button>{' '}
                      <button className="btn sm danger" onClick={() => cancelSel(ids)}>Cancel shipment</button>
                    </>
                  ))}
                  {open && sortRows(b.rows).map(t => (
                    <tr key={t.id}>
                      <td><RowBox id={t.id} /></td>
                      <td><Product t={t} /></td>
                      <td className="num"><WhCell t={t} /></td>
                      <td className="num">{qtyInput(t)}</td>
                      <td className="num"><Requested t={t} /></td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{ageDays(t.created_at)}d</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm primary" onClick={() => reviewSel([t.id])}>Mark reviewed</button>{' '}
                        <button className="btn sm" onClick={() => cancelSel([t.id])}>Cancel</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        )}
      </div>

      {/* STEP 3 — Amazon team exports the finalized request */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h3>Reviewed — Amazon team to export the request</h3>
          <span className="stage-meta">{reviewed.length} SKU{reviewed.length === 1 ? '' : 's'} · {fmtInt(units(reviewed))} units</span>
          <div className="spacer" />
          {selIn(reviewed).length > 0 && (
            <>
              <button className="btn sm primary" onClick={() => exportSel(selIn(reviewed))}>Export {selIn(reviewed).length} request(s)</button>{' '}
              <button className="btn sm" onClick={() => reopenSel(selIn(reviewed))}>Send {selIn(reviewed).length} back</button>{' '}
              <button className="btn sm danger" onClick={() => cancelSel(selIn(reviewed))}>Cancel {selIn(reviewed).length}</button>
            </>
          )}
        </div>
        {reviewed.length === 0 ? <div className="empty">Nothing to export yet. Reviewed shipments land here for the Amazon team to export and hand to the warehouse.</div> : (
          <table className="data">
            <thead><tr>
              <th className="plain" style={{ width: 32 }}></th>
              <th className="plain sortable" style={{ cursor: 'pointer' }} onClick={() => headerSort('sku')}>Product{sortArrow('sku')}</th><th className="num">In warehouse</th><th className="num sortable" style={{ cursor: 'pointer' }} onClick={() => headerSort('qty')}>Qty (editable){sortArrow('qty')}</th><th className="num">Originally asked</th>
              <th className="plain">Reviewed</th><th className="plain"></th>
            </tr></thead>
            {groupByBatch(reviewed).map(b => {
              const open = isOpen(b.key, true);
              const ids = b.rows.map(r => r.id);
              return (
                <tbody key={b.key}>
                  {shipHead(b, 7, true, `reviewed ${b.rows[0].reviewed_at?.slice(0, 10) ?? '—'}`, (
                    <>
                      <button className="btn sm primary" onClick={() => exportSel(ids)}>Export request</button>{' '}
                      <button className="btn sm" onClick={() => reopenSel(ids)}>Send back</button>{' '}
                      <button className="btn sm danger" onClick={() => cancelSel(ids)}>Cancel shipment</button>
                    </>
                  ))}
                  {open && sortRows(b.rows).map(t => (
                    <tr key={t.id}>
                      <td><RowBox id={t.id} /></td>
                      <td><Product t={t} />{t.review_note ? <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>“{t.review_note}”</div> : null}</td>
                      <td className="num"><WhCell t={t} /></td>
                      <td className="num">{qtyInput(t)}</td>
                      <td className="num"><Requested t={t} /></td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{t.reviewed_at?.slice(0, 10) ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm primary" onClick={() => exportSel([t.id])}>Export</button>{' '}
                        <button className="btn sm" onClick={() => reopenSel([t.id])}>Back</button>{' '}
                        <button className="btn sm" onClick={() => cancelSel([t.id])}>Cancel</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        )}
      </div>

      {closed.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-head"><h3>Recently closed</h3><span className="stage-meta">exported &amp; cancelled requests</span></div>
          <table className="data">
            <thead><tr><th className="plain">Shipment</th><th className="plain">Product</th><th className="num">Qty</th><th className="num">Asked</th><th className="plain">Exported</th><th className="plain">Outcome</th></tr></thead>
            <tbody>
              {closed.slice(0, 60).map(t => (
                <tr key={t.id}>
                  <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.batch_name ?? '—'}</td>
                  <td className="sku-code">{t.sku}</td>
                  <td className="num">{fmtInt(t.qty)}</td>
                  <td className="num">{t.requested_qty != null && t.requested_qty !== t.qty ? <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtInt(t.requested_qty)}</span> : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{t.reconciled_at?.slice(0, 10) ?? '—'}</td>
                  <td>
                    <span className="badge" style={{
                      ['--b-c' as any]: t.status === 'reconciled' ? 'var(--ok)' : 'var(--neutral)',
                      ['--b-bg' as any]: t.status === 'reconciled' ? 'var(--ok-bg)' : 'var(--neutral-bg)',
                    }}>{t.status === 'reconciled' ? `exported ${t.reconciled_at?.slice(0, 10) ?? ''}` : 'cancelled'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const PO_ACTIVE = ['draft', 'ordered', 'in_transit'];

// Sort a PO's lines by the chosen key (SKU or quantity). Returns a copy.
function sortPoLines(lines: any[], key: 'sku' | 'qty', dir: 1 | -1): any[] {
  return [...lines].sort((a, b) => {
    const va = key === 'sku' ? a.sku : a.qty_ordered;
    const vb = key === 'sku' ? b.sku : b.qty_ordered;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

function Pos({ refresh }: { refresh: () => void }) {
  const [pos, setPos] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ po_number: '', supplier: '', ordered_date: '', expected_arrival: '', notes: '', linesText: '' });
  const [receiving, setReceiving] = useState<any | null>(null);
  const [recLines, setRecLines] = useState<Record<string, string>>({});
  const [addToWh, setAddToWh] = useState(true);
  const [openPo, setOpenPo] = useState<Record<number, boolean>>({});
  const [etaEditId, setEtaEditId] = useState<number | null>(null);
  const [etaDraft, setEtaDraft] = useState('');
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [lineEdits, setLineEdits] = useState<Record<string, string>>({});   // `${poId}:${sku}` → qty draft
  const [nameEdits, setNameEdits] = useState<Record<number, string>>({});    // poId → name draft
  const [lineSort, setLineSort] = useState<{ key: 'sku' | 'qty'; dir: 1 | -1 }>({ key: 'sku', dir: 1 });

  const load = () => api.get<{ pos: any[] }>('/api/pos').then(d => setPos(d.pos));
  useEffect(() => { load(); }, []);

  const todayStr = new Date().toISOString().slice(0, 10);
  const isActive = (po: any) => PO_ACTIVE.includes(po.status);
  const inReview = (po: any) => po.review_state === 'proposed' || po.review_state === 'reviewed';
  const poOpen = (po: any) => openPo[po.id] ?? isActive(po);

  const proposedPOs = pos.filter(po => po.review_state === 'proposed');
  const reviewedPOs = pos.filter(po => po.review_state === 'reviewed');
  const normalPOs = pos.filter(po => !inReview(po));

  // Review-flow actions (mirror transfers).
  async function reviewPo(id: number) {
    try { await api.post(`/api/pos/${id}/review`, {}); toast('PO marked reviewed — ready to place.'); load(); refresh(); } catch (e: any) { toast(e.message); }
  }
  async function reopenPo(id: number) {
    try { await api.post(`/api/pos/${id}/reopen`, {}); toast('PO sent back for review.'); load(); refresh(); } catch (e: any) { toast(e.message); }
  }
  async function placeOrder(id: number) {
    if (!await confirmDialog({ title: 'Place this order with China?', body: 'Marks the PO as ordered so the pipeline counts it. Set the ETA once the factory confirms.', confirmLabel: 'Place order' })) return;
    try { await api.post(`/api/pos/${id}/place-order`, {}); toast('Order placed — now on order from China.'); load(); refresh(); } catch (e: any) { toast(e.message); }
  }
  async function cancelPo(id: number) {
    if (!await confirmDialog({ title: 'Cancel this PO?', confirmLabel: 'Cancel PO', cancelLabel: 'Keep', danger: true })) return;
    try { await api.patch(`/api/pos/${id}`, { status: 'cancelled' }); toast('PO cancelled.'); load(); refresh(); } catch (e: any) { toast(e.message); }
  }
  async function saveLine(poId: number, sku: string) {
    const key = `${poId}:${sku}`;
    const raw = lineEdits[key];
    if (raw === undefined) return;
    const q = Math.round(Number(raw));
    if (!Number.isFinite(q) || q <= 0) { toast('Quantity must be a positive number.'); return; }
    try {
      await api.patch(`/api/pos/${poId}/line`, { sku, qty: q });
      setLineEdits(m => { const n = { ...m }; delete n[key]; return n; });
      load(); refresh();
    } catch (e: any) { toast(e.message); }
  }
  async function saveName(poId: number) {
    const name = (nameEdits[poId] ?? '').trim();
    if (!name) { setNameEdits(m => { const n = { ...m }; delete n[poId]; return n; }); return; }
    try {
      await api.patch(`/api/pos/${poId}`, { name });
      setNameEdits(m => { const n = { ...m }; delete n[poId]; return n; });
      load();
    } catch (e: any) { toast(e.message); }
  }
  const headerClick = (key: 'sku' | 'qty') =>
    setLineSort(s => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) } : { key, dir: 1 }));
  const arrow = (key: string) => (lineSort.key === key ? (lineSort.dir === 1 ? ' ↑' : ' ↓') : '');

  const nameInput = (po: any) => (
    <InlineEdit style={{ fontWeight: 600, width: 240, fontSize: 13 }}
      value={nameEdits[po.id] ?? po.name ?? `PO #${po.id}`}
      onChange={v => setNameEdits(m => ({ ...m, [po.id]: v }))} onSave={() => saveName(po.id)} />
  );

  // A PO awaiting review or ready to place — the China mirror of a transfer batch.
  function reviewCard(po: any) {
    const stage = po.review_state as 'proposed' | 'reviewed';
    const lines = sortPoLines(po.lines, lineSort.key, lineSort.dir);
    const totalOrdered = po.lines.reduce((s: number, l: any) => s + l.qty_ordered, 0);
    const changed = po.lines.filter((l: any) => l.requested_qty != null && l.requested_qty !== l.qty_ordered).length;
    return (
      <div className="card" key={po.id} style={{ marginBottom: 12 }}>
        <div className="card-head po-head">
          {nameInput(po)}
          <span className="badge" style={{ ['--b-c' as any]: stage === 'proposed' ? 'var(--atrisk)' : 'var(--po)', ['--b-bg' as any]: stage === 'proposed' ? 'var(--atrisk-bg)' : 'var(--po-bg)' }}>
            {stage === 'proposed' ? 'awaiting review' : 'reviewed — ready to place'}
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {fmtInt(totalOrdered)} units · {po.lines.length} SKUs{changed > 0 ? ` · ${changed} adjusted` : ''}
          </span>
          <div className="spacer" />
          {stage === 'proposed' && <button className="btn sm primary" onClick={() => reviewPo(po.id)}>Mark reviewed</button>}
          {stage === 'reviewed' && <>
            <button className="btn sm primary" onClick={() => placeOrder(po.id)}>Place order</button>{' '}
            <button className="btn sm" onClick={() => reopenPo(po.id)}>Send back</button>
          </>}{' '}
          <button className="btn sm danger" onClick={() => cancelPo(po.id)}>Cancel</button>
        </div>
        <table className="data">
          <thead><tr>
            <th className="sortable" onClick={() => headerClick('sku')} style={{ cursor: 'pointer' }}>SKU{arrow('sku')}</th>
            <th className="num sortable" onClick={() => headerClick('qty')} style={{ cursor: 'pointer' }}>Qty (editable){arrow('qty')}</th>
            <th className="num">Originally asked</th>
          </tr></thead>
          <tbody>
            {lines.map((l: any) => {
              const key = `${po.id}:${l.sku}`;
              const adjusted = l.requested_qty != null && l.requested_qty !== l.qty_ordered;
              return (
                <tr key={l.sku}>
                  <td className="sku-code">{l.sku}</td>
                  <td className="num">
                    <InlineEdit type="number" min={1} className="cell-edit" style={{ width: 80 }}
                      value={lineEdits[key] ?? l.qty_ordered} dirty={lineEdits[key] !== undefined}
                      onChange={v => setLineEdits(m => ({ ...m, [key]: v }))} onSave={() => saveLine(po.id, l.sku)} />
                  </td>
                  <td className="num">
                    {adjusted
                      ? <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>asked {fmtInt(l.requested_qty)}</span>
                      : <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const visible = normalPOs.filter(po => filter === 'all' ? true : filter === 'open' ? isActive(po) : !isActive(po));

  // Summary across placed POs — the pipeline the team is actually waiting on (review POs
  // aren't ordered yet, so they don't count here).
  const active = normalPOs.filter(isActive);
  const outstanding = active.reduce((s, po) => s + po.lines.reduce((a: number, l: any) => a + Math.max(0, l.qty_ordered - l.qty_received), 0), 0);
  const overdueCount = active.filter(po => po.expected_arrival && po.expected_arrival < todayStr).length;
  const nextEta = active.map(po => po.expected_arrival).filter(Boolean).sort()[0] ?? null;

  const setAllOpen = (open: boolean) => setOpenPo(Object.fromEntries(visible.map(po => [po.id, open])));

  async function create() {
    const lines = form.linesText.split('\n')
      .map(l => l.split(/[\t,;]/).map(c => c.trim()))
      .filter(c => c.length >= 2 && c[0] && Number(c[1]) > 0)
      .map(c => ({ sku: c[0], qty_ordered: Number(c[1]) }));
    if (lines.length === 0) { toast('Add at least one line: "SKU,qty" per line.'); return; }
    try {
      await api.post('/api/pos', { ...form, status: 'ordered', lines });
      toast('PO created.');
      setCreating(false);
      setForm({ po_number: '', supplier: '', ordered_date: '', expected_arrival: '', notes: '', linesText: '' });
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  async function setStatus(po: any, status: string) {
    try { await api.patch(`/api/pos/${po.id}`, { status }); load(); refresh(); } catch (err: any) { toast(err.message); }
  }

  async function saveEta(po: any) {
    try { await api.patch(`/api/pos/${po.id}`, { expected_arrival: etaDraft || null }); setEtaEditId(null); load(); refresh(); } catch (err: any) { toast(err.message); }
  }

  async function receive() {
    if (!receiving) return;
    const lines = receiving.lines.map((l: any) => {
      const n = Math.round(Number(recLines[l.sku] ?? l.qty_ordered));
      return { sku: l.sku, qty_received: Number.isFinite(n) && n >= 0 ? n : 0 };
    });
    try {
      await api.post(`/api/pos/${receiving.id}/receive`, { lines, add_to_warehouse: addToWh });
      toast(addToWh ? 'PO received — units added to warehouse.' : 'PO received.');
      setReceiving(null); setRecLines({});
      load(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn primary" onClick={() => setCreating(c => !c)}>{creating ? 'Close' : '+ New PO'}</button>
        <div className="tabs" style={{ border: 'none', margin: 0 }}>
          {(['open', 'closed', 'all'] as const).map(f => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)} style={{ padding: '6px 12px' }}>
              {f === 'open' ? `Open (${active.length})` : f === 'closed' ? 'Closed' : 'All'}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <a className="btn sm" href="/api/pos/export.csv">⭳ Export CSV</a>
        {visible.length > 0 && (
          <>
            <button className="btn sm" onClick={() => setAllOpen(true)}>Expand all</button>
            <button className="btn sm" onClick={() => setAllOpen(false)}>Collapse all</button>
          </>
        )}
      </div>

      {(proposedPOs.length > 0 || reviewedPOs.length > 0) && (
        <>
          <div className="card-head" style={{ padding: '0 0 8px', border: 'none' }}>
            <h3>For review — team to finalize &amp; place</h3>
            <span className="stage-meta">{proposedPOs.length + reviewedPOs.length} PO{proposedPOs.length + reviewedPOs.length === 1 ? '' : 's'}</span>
          </div>
          {proposedPOs.map(po => reviewCard(po))}
          {reviewedPOs.map(po => reviewCard(po))}
          <div style={{ height: 18 }} />
        </>
      )}

      {active.length > 0 && (
        <div className="po-summary">
          <div><span className="k">Open POs</span><span className="v">{active.length}</span></div>
          <div><span className="k">Units on order</span><span className="v">{fmtInt(outstanding)}</span></div>
          <div><span className="k">Next arrival</span><span className="v">{nextEta ?? '—'}</span></div>
          <div><span className="k">Overdue</span><span className="v" style={{ color: overdueCount > 0 ? 'var(--stockout)' : undefined }}>{overdueCount}</span></div>
        </div>
      )}

      {creating && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <label style={{ fontSize: 12 }}>PO number<br /><input className="field" style={{ width: '100%' }} value={form.po_number} onChange={e => setForm(f => ({ ...f, po_number: e.target.value }))} /></label>
            <label style={{ fontSize: 12 }}>Supplier<br /><input className="field" style={{ width: '100%' }} value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} /></label>
            <label style={{ fontSize: 12 }}>Ordered date<br /><input className="field" type="date" style={{ width: '100%' }} value={form.ordered_date} onChange={e => setForm(f => ({ ...f, ordered_date: e.target.value }))} /></label>
            <label style={{ fontSize: 12 }}>Expected arrival (US warehouse)<br /><input className="field" type="date" style={{ width: '100%' }} value={form.expected_arrival} onChange={e => setForm(f => ({ ...f, expected_arrival: e.target.value }))} /></label>
          </div>
          <label style={{ fontSize: 12, display: 'block', marginTop: 10 }}>Lines — one per row, "SKU,quantity"<br />
            <textarea className="field" style={{ width: '100%', minHeight: 110, fontFamily: 'var(--mono)', fontSize: 12 }}
              placeholder={'MSB09,500\nMXG09,300'} value={form.linesText} onChange={e => setForm(f => ({ ...f, linesText: e.target.value }))} /></label>
          <div style={{ marginTop: 10 }}><button className="btn primary" onClick={create}>Create PO</button></div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="card"><div className="empty">{filter === 'open' ? 'No open purchase orders. Create one for each open order with your manufacturer so your total days of stock is honest.' : 'Nothing here.'}</div></div>
      ) : visible.map(po => {
        const overdue = po.expected_arrival && po.expected_arrival < todayStr && isActive(po);
        const totalOrdered = po.lines.reduce((s: number, l: any) => s + l.qty_ordered, 0);
        const totalReceived = po.lines.reduce((s: number, l: any) => s + l.qty_received, 0);
        const open = poOpen(po);
        return (
          <div className="card" key={po.id} style={{ marginBottom: 12 }}>
            <div className="card-head po-head">
              <button className={`caret${open ? ' open' : ''}`} onClick={() => setOpenPo(m => ({ ...m, [po.id]: !open }))} aria-label={open ? 'Collapse' : 'Expand'}>▸</button>
              {nameInput(po)}
              {po.po_number && <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{po.po_number}</span>}
              {po.supplier && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{po.supplier}</span>}
              <span className="badge" style={{
                ['--b-c' as any]: po.status === 'received' ? 'var(--ok)' : po.status === 'cancelled' ? 'var(--neutral)' : po.status === 'draft' ? 'var(--atrisk)' : 'var(--po)',
                ['--b-bg' as any]: po.status === 'received' ? 'var(--ok-bg)' : po.status === 'cancelled' ? 'var(--neutral-bg)' : po.status === 'draft' ? 'var(--atrisk-bg)' : 'var(--po-bg)',
              }}>{po.status.replace('_', ' ')}</span>
              {po.expected_arrival && (
                <span className="mono" style={{ fontSize: 11.5, color: overdue ? 'var(--stockout)' : 'var(--muted)', fontWeight: overdue ? 700 : 400 }}>
                  ETA {po.expected_arrival}{overdue ? ' — OVERDUE' : ''}
                </span>
              )}
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {fmtInt(totalReceived)}/{fmtInt(totalOrdered)} units · {po.lines.length} SKUs
              </span>
              <div className="spacer" />
              {po.status === 'draft' && <button className="btn sm" onClick={() => setStatus(po, 'ordered')}>Mark ordered</button>}
              {(po.status === 'ordered') && <button className="btn sm" onClick={() => setStatus(po, 'in_transit')}>Mark in transit</button>}
              {isActive(po) && (
                <>
                  <button className="btn sm" onClick={() => { setEtaEditId(etaEditId === po.id ? null : po.id); setEtaDraft(po.expected_arrival ?? ''); }}>Set ETA</button>
                  <button className="btn sm primary" onClick={() => { setReceiving(po); setRecLines({}); setOpenPo(m => ({ ...m, [po.id]: true })); }}>Receive…</button>
                </>
              )}
              {po.status === 'draft' && <button className="btn sm danger" onClick={async () => { if (await confirmDialog({ title: 'Delete this draft PO?', confirmLabel: 'Delete', danger: true })) { await api.del(`/api/pos/${po.id}`); load(); refresh(); } }}>Delete</button>}
            </div>
            {etaEditId === po.id && (
              <div style={{ padding: '10px 16px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hairline)', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12 }}>Expected arrival (US warehouse):</span>
                <input className="field" type="date" value={etaDraft} onChange={e => setEtaDraft(e.target.value)} />
                <button className="btn sm primary" onClick={() => saveEta(po)}>Save</button>
                <button className="btn sm" onClick={() => setEtaEditId(null)}>Cancel</button>
              </div>
            )}
            {open && (
              <>
                {po.notes && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--muted)' }}>{po.notes}</div>}
                {receiving?.id === po.id && (
                  <div style={{ padding: '12px 16px', background: 'var(--surface-2)', borderTop: '1px solid var(--hairline)' }}>
                    <b style={{ fontSize: 12.5 }}>Received quantities</b>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '10px 0' }}>
                      {po.lines.map((l: any) => (
                        <label key={l.sku} style={{ fontSize: 11.5 }} className="mono">{l.sku}<br />
                          <input className="cell-edit" type="number" min={0}
                            value={recLines[l.sku] ?? l.qty_ordered}
                            onChange={e => setRecLines(m => ({ ...m, [l.sku]: e.target.value }))} /></label>
                      ))}
                    </div>
                    <label style={{ fontSize: 12.5 }}>
                      <input type="checkbox" checked={addToWh} onChange={e => setAddToWh(e.target.checked)} /> Add received units to warehouse on-hand
                    </label>
                    <div style={{ marginTop: 10 }}>
                      <button className="btn primary sm" onClick={receive}>Confirm receipt</button>{' '}
                      <button className="btn sm" onClick={() => setReceiving(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                <table className="data">
                  <thead><tr><th className="plain">SKU</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Outstanding</th></tr></thead>
                  <tbody>
                    {po.lines.map((l: any) => (
                      <tr key={l.sku}>
                        <td className="sku-code">{l.sku}</td>
                        <td className="num">{fmtInt(l.qty_ordered)}</td>
                        <td className="num">{fmtInt(l.qty_received)}</td>
                        <td className="num">{fmtInt(l.qty_ordered - l.qty_received)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
