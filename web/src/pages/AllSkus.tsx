import React, { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, fmtInt, fmtNum, type SkusResponse, type SkuResult } from '../api.ts';
import { StatusBadge, Flags, toast } from '../components/ui.tsx';

const STATUS_FILTERS = ['STOCKOUT', 'CRITICAL', 'ORDER_NOW', 'ORDER_SOON', 'AT_RISK', 'OVERSTOCK', 'OK', 'UNCLASSIFIED', 'NOT_REPLENISHABLE'];
const CLASSES = ['unclassified', 'replenishable', 'watch', 'discontinued', 'ignore'];

type SortKey = keyof SkuResult | 'none';

export function AllSkus({ data, refresh, openSku, initialStatus, initialFlag }: {
  data: SkusResponse; refresh: () => void; openSku: (sku: string) => void;
  initialStatus?: string | null; initialFlag?: string | null;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(initialStatus ?? null);
  const [flagFilter, setFlagFilter] = useState<string | null>(initialFlag ?? null);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'none', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState('classification');
  const [bulkValue, setBulkValue] = useState('replenishable');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    let out = data.results;
    if (statusFilter) out = out.filter(r => r.status === statusFilter);
    if (flagFilter) out = out.filter(r => r.flags.includes(flagFilter));
    if (classFilter) out = out.filter(r => r.classification === classFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(r => r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));
    }
    if (sort.key !== 'none') {
      out = [...out].sort((a, b) => {
        const av = a[sort.key as keyof SkuResult];
        const bv = b[sort.key as keyof SkuResult];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
    }
    return out;
  }, [data.results, statusFilter, flagFilter, classFilter, search, sort]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  const toggleSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');

  async function applyBulk() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (bulkField === 'clear_overrides') {
        patch.velocity_override = null;
        patch.growth_multiplier = null;
        patch.template_override_id = null;
        patch.param_overrides = null;
      } else if (bulkField === 'classification' || bulkField === 'fulfillment_channel') {
        patch[bulkField] = bulkValue;
      } else {
        const n = Number(bulkValue);
        if (!Number.isFinite(n)) { toast('Enter a number.'); setBusy(false); return; }
        patch[bulkField] = n;
      }
      const res = await api.post<{ changed: number }>('/api/skus/bulk', { skus: [...selected], patch });
      toast(`Updated ${res.changed} SKUs.`);
      setSelected(new Set());
      refresh();
    } catch (err: any) { toast(err.message); } finally { setBusy(false); }
  }

  const allVisibleSelected = rows.length > 0 && rows.every(r => selected.has(r.sku));

  return (
    <div className="page">
      <h1>All SKUs</h1>
      <div className="h-sub">{data.results.length} SKUs in the catalog · {rows.length} matching current filters</div>

      <div className="toolbar">
        <input className="field" style={{ width: 240 }} placeholder="Search SKU or product name…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="field" value={classFilter ?? ''} onChange={e => setClassFilter(e.target.value || null)}>
          <option value="">All classifications</option>
          {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {flagFilter && (
          <button className="chip on" onClick={() => setFlagFilter(null)}>
            flag: {flagFilter.toLowerCase().replace(/_/g, ' ')} ✕
          </button>
        )}
        {STATUS_FILTERS.map(sf => (
          <button key={sf} className={`chip${statusFilter === sf ? ' on' : ''}`}
            onClick={() => setStatusFilter(statusFilter === sf ? null : sf)}>
            {sf.toLowerCase().replace(/_/g, ' ')} {data.results.filter(r => r.status === sf).length}
          </button>
        ))}
      </div>

      <div className="card">
        <div ref={parentRef} style={{ height: 'calc(100vh - 300px)', minHeight: 360, overflowY: 'auto' }}>
          <table className="data" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th className="plain" style={{ width: 34 }}>
                  <input type="checkbox" checked={allVisibleSelected}
                    onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.sku)) : new Set())} />
                </th>
                <th style={{ width: 210 }} onClick={() => toggleSort('sku')}>SKU{arrow('sku')}</th>
                <th style={{ width: 130 }} onClick={() => toggleSort('status')}>Status{arrow('status')}</th>
                <th style={{ width: 105 }} onClick={() => toggleSort('classification')}>Class{arrow('classification')}</th>
                <th className="num" style={{ width: 76 }} onClick={() => toggleSort('velocity')} title="Units sold per day">Sold/day{arrow('velocity')}</th>
                <th className="num" style={{ width: 68 }} onClick={() => toggleSort('fba_available')} title="Sellable now at Amazon">At Amazon{arrow('fba_available')}</th>
                <th className="num" style={{ width: 68 }} onClick={() => toggleSort('fba_inbound')} title="On the way to Amazon">Incoming{arrow('fba_inbound')}</th>
                <th className="num" style={{ width: 68 }} onClick={() => toggleSort('warehouse_on_hand')} title="Units in your warehouse">Warehouse{arrow('warehouse_on_hand')}</th>
                <th className="num" style={{ width: 68 }} onClick={() => toggleSort('open_po_units')} title="Units on order from China">On order{arrow('open_po_units')}</th>
                <th className="num" style={{ width: 84 }} onClick={() => toggleSort('fba_days_cover')} title="Days of stock left at Amazon">Days at Amazon{arrow('fba_days_cover')}</th>
                <th className="num" style={{ width: 84 }} onClick={() => toggleSort('pipeline_days_cover')} title="Days of stock left across everything">Days total{arrow('pipeline_days_cover')}</th>
                <th className="num" style={{ width: 76 }} onClick={() => toggleSort('recommended_ship_qty')} title="Units to ship to Amazon">To ship{arrow('recommended_ship_qty')}</th>
                <th className="num" style={{ width: 76 }} onClick={() => toggleSort('recommended_po_qty')} title="Units to order from China">To order{arrow('recommended_po_qty')}</th>
                <th className="plain">Flags</th>
              </tr>
            </thead>
            <tbody>
              {virtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: virtualizer.getVirtualItems()[0].start }} aria-hidden="true"><td colSpan={14} style={{ padding: 0, border: 'none' }} /></tr>
              )}
              {virtualizer.getVirtualItems().map(vi => {
                const r = rows[vi.index];
                return (
                  <tr key={r.sku} className="clickable" onClick={() => openSku(r.sku)}>
                    <td onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.sku)}
                        onChange={e => setSelected(prev => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(r.sku) : next.delete(r.sku);
                          return next;
                        })} />
                    </td>
                    <td>
                      <span className="sku-code">{r.sku}</span>
                      <div className="cell-title" style={{ maxWidth: 190 }}>{r.title}</div>
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.classification}
                      {r.fulfillment_channel === 'fbm' && <span className="flag" style={{ marginLeft: 4 }} title="Merchant-fulfilled — never shipped to FBA">FBM</span>}</td>
                    <td className="num">
                      {fmtNum(r.velocity)}
                      {r.velocity_source === 'manual' && <span className="flag" style={{ marginLeft: 4 }}>M</span>}
                    </td>
                    <td className="num">{fmtInt(r.fba_available)}</td>
                    <td className="num">{fmtInt(r.fba_inbound)}</td>
                    <td className="num">{fmtInt(r.warehouse_on_hand)}</td>
                    <td className="num">{fmtInt(r.open_po_units)}</td>
                    <td className="num">{fmtNum(r.fba_days_cover, 0)}</td>
                    <td className="num">{fmtNum(r.pipeline_days_cover, 0)}</td>
                    <td className="num" style={{ fontWeight: r.recommended_ship_qty > 0 ? 700 : undefined, color: r.recommended_ship_qty > 0 ? 'var(--ship)' : undefined }}>
                      {r.recommended_ship_qty || ''}</td>
                    <td className="num" style={{ fontWeight: r.recommended_po_qty > 0 ? 700 : undefined, color: r.recommended_po_qty > 0 ? 'var(--po)' : undefined }}>
                      {r.recommended_po_qty || ''}</td>
                    <td><Flags flags={r.flags} max={2} /></td>
                  </tr>
                );
              })}
              {virtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)!.end) }} aria-hidden="true"><td colSpan={14} style={{ padding: 0, border: 'none' }} /></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulkbar">
          <span><span className="n">{selected.size}</span> selected</span>
          <button className="btn sm" onClick={() => setSelected(new Set(rows.map(r => r.sku)))}>
            Select all {rows.length} matching
          </button>
          <span style={{ opacity: 0.5 }}>·</span>
          <select value={bulkField} onChange={e => {
            setBulkField(e.target.value);
            if (e.target.value === 'classification') setBulkValue('replenishable');
            else if (e.target.value === 'fulfillment_channel') setBulkValue('fbm');
            else setBulkValue('');
          }}>
            <option value="classification">Classify as</option>
            <option value="fulfillment_channel">Set fulfillment</option>
            <option value="case_pack">Set case pack</option>
            <option value="moq">Set MOQ</option>
            <option value="order_multiple">Set order multiple</option>
            <option value="velocity_override">Set sales rate (sold/day)</option>
            <option value="growth_multiplier">Set growth multiplier</option>
            <option value="clear_overrides">Clear all overrides</option>
          </select>
          {bulkField === 'classification' ? (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}>
              {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : bulkField === 'fulfillment_channel' ? (
            <select value={bulkValue} onChange={e => setBulkValue(e.target.value)}>
              <option value="fba">FBA</option>
              <option value="fbm">FBM</option>
            </select>
          ) : bulkField !== 'clear_overrides' ? (
            <input type="number" step="any" placeholder="value" value={bulkValue} onChange={e => setBulkValue(e.target.value)} style={{ width: 90 }} />
          ) : null}
          <button className="btn sm primary" style={{ background: '#e9b44c', borderColor: '#e9b44c', color: 'var(--ink)' }}
            disabled={busy} onClick={applyBulk}>Apply</button>
          <button className="btn sm" style={{ background: 'transparent', color: 'var(--surface)' }}
            onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
    </div>
  );
}
