import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtInt, type SkusResponse } from '../api.ts';
import { toast } from '../components/ui.tsx';

export function WarehousePos({ data, refresh }: { data: SkusResponse; refresh: () => void }) {
  const [tab, setTab] = useState<'warehouse' | 'pos'>('warehouse');
  return (
    <div className="page">
      <h1>Warehouse & China POs</h1>
      <div className="h-sub">The two things Amazon can't see: your US warehouse stock and what's on order from China. Keep these current and the recommendations stay honest.</div>
      <div className="tabs">
        <button className={tab === 'warehouse' ? 'on' : ''} onClick={() => setTab('warehouse')}>US Warehouse</button>
        <button className={tab === 'pos' ? 'on' : ''} onClick={() => setTab('pos')}>Purchase Orders</button>
      </div>
      {tab === 'warehouse' ? <Warehouse data={data} refresh={refresh} /> : <Pos refresh={refresh} />}
    </div>
  );
}

function Warehouse({ data, refresh }: { data: SkusResponse; refresh: () => void }) {
  const [meta, setMeta] = useState<Record<string, { updated_at: string; updated_via: string }>>({});
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);

  const loadMeta = () => api.get<{ rows: any[] }>('/api/warehouse').then(d =>
    setMeta(Object.fromEntries(d.rows.map(r => [r.sku, { updated_at: r.updated_at, updated_via: r.updated_via }]))));
  useEffect(() => { loadMeta(); }, []);

  const rows = useMemo(() => {
    let out = data.results.filter(r => r.classification === 'replenishable' || r.classification === 'watch' || r.warehouse_on_hand > 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(r => r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));
    }
    return out.sort((a, b) => a.sku.localeCompare(b.sku));
  }, [data.results, search]);

  async function saveQty(sku: string) {
    const raw = edits[sku];
    if (raw === undefined || raw === '') return;
    try {
      await api.put(`/api/warehouse/${encodeURIComponent(sku)}`, { qty: Number(raw) });
      setEdits(e => { const n = { ...e }; delete n[sku]; return n; });
      loadMeta();
      refresh();
    } catch (err: any) { toast(err.message); }
  }

  async function bulkPaste() {
    const rows = paste.split('\n')
      .map(l => l.split(/[\t,;]/).map(c => c.trim()))
      .filter(c => c.length >= 2 && c[0] && Number.isFinite(Number(c[1])))
      .map(c => ({ sku: c[0], qty: Number(c[1]) }));
    if (rows.length === 0) { toast('Nothing usable — paste lines like "SKU,qty".'); return; }
    try {
      const res = await api.post<{ updated: number }>('/api/warehouse/bulk', { rows, via: 'csv' });
      toast(`Updated ${res.updated} warehouse quantities.`);
      setPaste(''); setShowPaste(false);
      loadMeta(); refresh();
    } catch (err: any) { toast(err.message); }
  }

  const staleCutoff = Date.now() - 30 * 86_400_000;

  return (
    <>
      <div className="toolbar">
        <input className="field" style={{ width: 240 }} placeholder="Search SKU…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn" onClick={() => setShowPaste(s => !s)}>Paste counts (SKU,qty)</button>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Type a quantity and press Enter (or click away) to save.</span>
      </div>
      {showPaste && (
        <div className="card" style={{ marginBottom: 14, padding: 14 }}>
          <textarea className="field" style={{ width: '100%', minHeight: 110, fontFamily: 'var(--mono)', fontSize: 12 }}
            placeholder={'MSB09,140\nMXG09,80\n…one SKU per line (comma or tab separated)'}
            value={paste} onChange={e => setPaste(e.target.value)} />
          <div style={{ marginTop: 8 }}><button className="btn primary sm" onClick={bulkPaste}>Apply counts</button></div>
        </div>
      )}
      <div className="card">
        <div style={{ maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
          <table className="data">
            <thead><tr>
              <th className="plain">SKU</th><th className="num">On hand</th>
              <th className="plain">Last updated</th><th className="plain">Via</th>
              <th className="num">FBA avail</th><th className="num">Rec. ship</th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const m = meta[r.sku];
                const stale = m && new Date(m.updated_at).getTime() < staleCutoff;
                return (
                  <tr key={r.sku}>
                    <td><span className="sku-code">{r.sku}</span><div className="cell-title" style={{ maxWidth: 300 }}>{r.title}</div></td>
                    <td className="num">
                      <input className={`cell-edit${edits[r.sku] !== undefined ? ' dirty' : ''}`} type="number" min={0}
                        value={edits[r.sku] ?? r.warehouse_on_hand}
                        onChange={e => setEdits(m2 => ({ ...m2, [r.sku]: e.target.value }))}
                        onBlur={() => saveQty(r.sku)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                    </td>
                    <td className="mono" style={{ color: stale ? 'var(--atrisk)' : 'var(--muted)', fontSize: 11 }}>
                      {m ? m.updated_at.slice(0, 10) : 'never'}{stale ? ' (stale)' : ''}
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m?.updated_via ?? ''}</td>
                    <td className="num">{fmtInt(r.fba_available)}</td>
                    <td className="num" style={{ color: r.recommended_ship_qty > 0 ? 'var(--ship)' : undefined, fontWeight: r.recommended_ship_qty > 0 ? 700 : undefined }}>
                      {r.recommended_ship_qty || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

const PO_STATUSES = ['draft', 'ordered', 'in_transit', 'received', 'cancelled'];

function Pos({ refresh }: { refresh: () => void }) {
  const [pos, setPos] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ po_number: '', supplier: '', ordered_date: '', expected_arrival: '', notes: '', linesText: '' });
  const [receiving, setReceiving] = useState<any | null>(null);
  const [recLines, setRecLines] = useState<Record<string, string>>({});
  const [addToWh, setAddToWh] = useState(true);

  const load = () => api.get<{ pos: any[] }>('/api/pos').then(d => setPos(d.pos));
  useEffect(() => { load(); }, []);

  const todayStr = new Date().toISOString().slice(0, 10);

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

  async function setEta(po: any) {
    const eta = window.prompt('Expected arrival (YYYY-MM-DD):', po.expected_arrival ?? '');
    if (eta === null) return;
    try { await api.patch(`/api/pos/${po.id}`, { expected_arrival: eta }); load(); refresh(); } catch (err: any) { toast(err.message); }
  }

  async function receive() {
    if (!receiving) return;
    const lines = receiving.lines.map((l: any) => ({ sku: l.sku, qty_received: Number(recLines[l.sku] ?? l.qty_ordered) }));
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
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>POs with status ordered / in transit count into pipeline cover.</span>
      </div>

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

      {pos.length === 0 ? (
        <div className="card"><div className="empty">No purchase orders yet. Create one for each open order with your manufacturer so pipeline cover is honest.</div></div>
      ) : pos.map(po => {
        const overdue = po.expected_arrival && po.expected_arrival < todayStr && (po.status === 'ordered' || po.status === 'in_transit');
        const totalOrdered = po.lines.reduce((s: number, l: any) => s + l.qty_ordered, 0);
        const totalReceived = po.lines.reduce((s: number, l: any) => s + l.qty_received, 0);
        return (
          <div className="card" key={po.id} style={{ marginBottom: 12 }}>
            <div className="card-head">
              <h3 className="mono">{po.po_number ?? `PO #${po.id}`}</h3>
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
              {(po.status === 'ordered' || po.status === 'in_transit') && (
                <>
                  <button className="btn sm" onClick={() => setEta(po)}>Set ETA</button>
                  <button className="btn sm primary" onClick={() => { setReceiving(po); setRecLines({}); }}>Receive…</button>
                </>
              )}
              {po.status === 'draft' && <button className="btn sm danger" onClick={() => { if (window.confirm('Delete this draft PO?')) api.del(`/api/pos/${po.id}`).then(() => { load(); refresh(); }); }}>Delete</button>}
            </div>
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
          </div>
        );
      })}
    </>
  );
}
