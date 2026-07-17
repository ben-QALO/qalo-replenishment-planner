import React, { useEffect, useState } from 'react';
import { api, fmtInt } from '../api.ts';
import { toast } from '../components/ui.tsx';

interface Preview {
  file_id: string; filename: string; snapshot_date: string;
  rows_total: number; rows_ok: number;
  rows_skipped: { row: number; reason: string }[];
  new_skus: { sku: string; title: string | null; units_shipped_t30: number | null }[];
  warnings: string[];
  replaces_existing: { revision: number; imported_at: string } | null;
  already_imported: boolean;
}

export function Imports({ refresh }: { refresh: () => void }) {
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<{ newSkus: string[] } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [triageSel, setTriageSel] = useState<Set<string>>(new Set());
  const [whOver, setWhOver] = useState(false);
  const [whResult, setWhResult] = useState<any | null>(null);
  const [brOver, setBrOver] = useState(false);
  const [brResult, setBrResult] = useState<any | null>(null);
  const [keep, setKeep] = useState<{ entries: any[]; count: number; kept_skus: number; ignored_skus: number } | null>(null);
  const [keepText, setKeepText] = useState('');

  const loadKeep = () => api.get<any>('/api/keep-list').then(setKeep).catch(() => {});
  useEffect(() => { loadKeep(); }, []);

  async function importWarehouse(file: File) {
    setBusy(true); setWhResult(null);
    try {
      const res = await api.upload<any>('/api/warehouse/import', file);
      setWhResult(res);
      toast(`Warehouse updated — ${res.matched} SKUs matched (${res.with_stock} with stock).`);
      refresh();
    } catch (err: any) { toast(`Warehouse import failed: ${err.message}`); } finally { setBusy(false); }
  }

  async function importBusinessReport(file: File) {
    setBusy(true); setBrResult(null);
    try {
      const res = await api.upload<any>('/api/business-report/import', file);
      setBrResult(res);
      toast(`Business Report imported — ${res.matched} tracked ${res.by_sku ? 'SKUs' : 'ASINs'} matched (${res.with_sales} with sales).`);
      refresh();
    } catch (err: any) { toast(`Business Report import failed: ${err.message}`); } finally { setBusy(false); }
  }

  async function applyKeep() {
    if (!keepText.trim()) { toast('Paste your ASINs or SKUs first.'); return; }
    setBusy(true);
    try {
      const res = await api.post<any>('/api/keep-list', { text: keepText });
      toast(`Keep list applied — ${res.kept_skus} SKUs kept, ${res.ignored_skus} ignored${res.preserved_skus ? `, ${res.preserved_skus} manual kept as-is` : ''}${res.not_found.length ? `, ${res.not_found.length} not found` : ''}.`);
      setKeepText(''); loadKeep(); refresh();
    } catch (err: any) { toast(err.message); } finally { setBusy(false); }
  }

  const loadHistory = () => api.get<{ imports: any[] }>('/api/imports').then(d => setHistory(d.imports));
  useEffect(() => { loadHistory(); }, []);

  async function handleFile(file: File) {
    setBusy(true);
    setPreview(null);
    setCommitted(null);
    try {
      const p = await api.upload<Preview>('/api/imports/preview', file);
      setPreview(p);
    } catch (err: any) {
      toast(`Could not read file: ${err.message}`);
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ newSkus: string[]; revision: number; replacedPrevious: boolean; alreadyImported: boolean }>(
        '/api/imports/commit', { file_id: preview.file_id });
      if (res.alreadyImported) {
        toast('This exact file was already imported — nothing changed.');
      } else {
        toast(res.replacedPrevious
          ? `Replaced ${preview.snapshot_date} snapshot (now revision ${res.revision}).`
          : `Snapshot ${preview.snapshot_date} imported.`);
        if (res.newSkus.length > 0) {
          setCommitted({ newSkus: res.newSkus });
          setTriageSel(new Set(res.newSkus));
        }
      }
      setPreview(null);
      loadHistory();
      refresh();
    } catch (err: any) { toast(`Import failed: ${err.message}`); } finally { setBusy(false); }
  }

  async function triage(classification: 'replenishable' | 'ignore') {
    if (!committed || triageSel.size === 0) return;
    try {
      await api.post('/api/skus/bulk', { skus: [...triageSel], patch: { classification } });
      toast(`${triageSel.size} SKUs marked ${classification}.`);
      const remaining = committed.newSkus.filter(s => !triageSel.has(s));
      setCommitted(remaining.length > 0 ? { newSkus: remaining } : null);
      setTriageSel(new Set(remaining));
      refresh();
    } catch (err: any) { toast(err.message); }
  }

  return (
    <div className="page">
      <h1>Imports</h1>
      <div className="h-sub">
        Each planning session, drop your files: the Amazon FBA Inventory export, your NetSuite warehouse report, and the Amazon Business Report (for true FBM + FBA sales). Then submit your transfers from the Action Center.
      </div>

      <div className="grid-2">
        <div>
          <h2 style={{ marginTop: 4 }}>1 · Amazon FBA export</h2>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '-4px 0 10px' }}>
            Get it from{' '}
            <a href="https://sellercentral.amazon.com/reportcentral/MANAGE_INVENTORY_HEALTH/1"
              target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent)', borderBottom: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}>
              Seller Central → Manage Inventory Health ↗
            </a>
          </div>
          <div
            className={`dropzone${over ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.csv,.txt,.tsv';
              input.onchange = () => { if (input.files?.[0]) handleFile(input.files[0]); };
              input.click();
            }}
          >
            {busy ? 'Working…' : <><b>Drop your FBA Inventory export</b> (.csv / .txt)</>}
          </div>
        </div>
        <div>
          <h2 style={{ marginTop: 4 }}>2 · NetSuite warehouse report</h2>
          <div
            className={`dropzone${whOver ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); setWhOver(true); }}
            onDragLeave={() => setWhOver(false)}
            onDrop={e => { e.preventDefault(); setWhOver(false); const f = e.dataTransfer.files[0]; if (f) importWarehouse(f); }}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.xls,.xml';
              input.onchange = () => { if (input.files?.[0]) importWarehouse(input.files[0]); };
              input.click();
            }}
          >
            {busy ? 'Working…' : <><b>Drop your NetSuite warehouse report</b> (Qalo Amazon Inventory Report .xls)</>}
          </div>
          {whResult && (
            <div className="card" style={{ marginTop: 10, padding: '10px 14px', fontSize: 12.5 }}>
              <b>{whResult.matched}</b> SKUs matched from the <span className="mono">{whResult.qty_column}</span> column ({whResult.with_stock} with stock).
              {whResult.tracked_missing_count > 0 && (
                <div style={{ color: 'var(--atrisk)', marginTop: 4 }}>
                  {whResult.tracked_missing_count} tracked SKUs weren't in this file (treated as 0 on-hand): {whResult.tracked_missing_sample.slice(0, 6).join(', ')}{whResult.tracked_missing_count > 6 ? '…' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 4 }}>3 · Amazon Business Report <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}>— true FBM + FBA sales</span></h2>
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '-4px 0 10px', maxWidth: '86ch' }}>
          The FBA export only shows FBA sales — a product that's out of stock on FBA, or a new item you're testing via merchant-fulfilled (FBM), won't show its real velocity. This report fixes that. Use the <b>Detail Page Sales &amp; Traffic by SKU</b> report (last 30 days) from{' '}
          <a href="https://sellercentral.amazon.com/business-reports/ref=xx_sitemetric_dnav_xx#/report?id=102%3ADetailSalesTrafficBySKU&chartCols=&columns=0%2F1%2F2%2F3%2F8%2F9%2F14%2F15%2F20%2F21%2F26%2F27%2F28%2F29%2F30%2F31%2F32%2F33%2F34%2F35%2F36%2F37"
            target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', borderBottom: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)' }}>
            Seller Central → Business Reports ↗
          </a>. The <b>by-SKU</b> report is preferred: when one product sells through several SKUs (an FBA SKU plus an FBM one), it keeps each SKU's sales separate so demand isn't double-counted, then credits the FBM sales to your FBA SKU. The older by-Child-ASIN report still works.
        </div>
        <div
          className={`dropzone${brOver ? ' over' : ''}`}
          onDragOver={e => { e.preventDefault(); setBrOver(true); }}
          onDragLeave={() => setBrOver(false)}
          onDrop={e => { e.preventDefault(); setBrOver(false); const f = e.dataTransfer.files[0]; if (f) importBusinessReport(f); }}
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv,.txt';
            input.onchange = () => { if (input.files?.[0]) importBusinessReport(input.files[0]); };
            input.click();
          }}
        >
          {busy ? 'Working…' : <><b>Drop your Business Report</b> (Sales &amp; Traffic by SKU .csv)</>}
        </div>
        {brResult && (
          <div className="card" style={{ marginTop: 10, padding: '10px 14px', fontSize: 12.5 }}>
            <b>{brResult.matched}</b> tracked ASINs matched ({brResult.with_sales} with sales) from the <span className="mono">{brResult.units_column}</span> column · {brResult.window_days}-day window. This now drives velocity for matched SKUs.
          </div>
        )}
      </div>

      <div className="card" style={{ margin: '18px 0', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 650 }}>Products to keep in stock</h3>
          {keep && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{keep.count} on the list · {keep.kept_skus} SKUs kept · {keep.ignored_skus} ignored</span>}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 10px' }}>
          Paste the ASINs (or SKUs) you actually stock — one per line, or comma-separated. Everything on the list becomes replenishable; everything else is set to ignore so it drops out of every view. Re-runnable anytime.
        </div>
        <textarea className="field" style={{ width: '100%', minHeight: 90, fontFamily: 'var(--mono)', fontSize: 12 }}
          placeholder={'B0XXXXXXXX\nB0YYYYYYYY\n… or paste SKUs'} value={keepText} onChange={e => setKeepText(e.target.value)} />
        <div style={{ marginTop: 8 }}>
          <button className="btn primary sm" disabled={busy} onClick={applyKeep}>Apply keep list</button>
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <h3>Review before import — {preview.filename}</h3>
            <div className="spacer" />
            <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || preview.already_imported} onClick={commit}>
              {preview.replaces_existing ? `Replace ${preview.snapshot_date} snapshot` : `Import as ${preview.snapshot_date}`}
            </button>
          </div>
          <div style={{ padding: '14px 16px' }}>
            <dl className="kv">
              <dt>Snapshot date</dt><dd>{preview.snapshot_date}</dd>
              <dt>Rows parsed</dt><dd>{fmtInt(preview.rows_ok)} of {fmtInt(preview.rows_total)}</dd>
              <dt>Rows skipped</dt><dd>{preview.rows_skipped.length === 0 ? 'none' : preview.rows_skipped.map(s => `row ${s.row}: ${s.reason}`).join('; ')}</dd>
              <dt>New SKUs</dt><dd>{preview.new_skus.length}</dd>
            </dl>
            {preview.already_imported && (
              <div className="banner" style={{ marginTop: 10, borderRadius: 6 }}>This exact file has already been imported.</div>
            )}
            {preview.replaces_existing && !preview.already_imported && (
              <div className="banner" style={{ marginTop: 10, borderRadius: 6 }}>
                A snapshot for {preview.snapshot_date} already exists (revision {preview.replaces_existing.revision}) — importing will replace it.
              </div>
            )}
            {preview.warnings.map((w, i) => (
              <div key={i} className="banner" style={{ marginTop: 8, borderRadius: 6 }}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {committed && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head">
            <h3>Classify {committed.newSkus.length} new SKUs</h3>
            <div className="spacer" />
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{triageSel.size} selected</span>
            <button className="btn sm" onClick={() => setTriageSel(new Set(committed.newSkus))}>All</button>
            <button className="btn sm" onClick={() => setTriageSel(new Set())}>None</button>
            <button className="btn sm primary" onClick={() => triage('replenishable')}>Mark replenishable</button>
            <button className="btn sm" onClick={() => triage('ignore')}>Mark ignore</button>
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="data">
              <tbody>
                {committed.newSkus.map(sku => (
                  <tr key={sku}>
                    <td style={{ width: 30 }}>
                      <input type="checkbox" checked={triageSel.has(sku)}
                        onChange={e => setTriageSel(prev => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(sku) : next.delete(sku);
                          return next;
                        })} />
                    </td>
                    <td className="sku-code">{sku}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2>Import history</h2>
      <div className="card">
        {history.length === 0 ? <div className="empty">No imports yet.</div> : (
          <table className="data">
            <thead><tr>
              <th className="plain">When</th><th className="plain">File</th><th className="plain">Status</th>
              <th className="num">Rows</th><th className="num">New SKUs</th><th className="plain">Warnings</th>
            </tr></thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td className="mono">{h.imported_at?.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.filename}</td>
                  <td>
                    <span className="badge" style={{
                      ['--b-c' as any]: h.status === 'failed' ? 'var(--stockout)' : 'var(--ok)',
                      ['--b-bg' as any]: h.status === 'failed' ? 'var(--stockout-bg)' : 'var(--ok-bg)',
                    }}>{h.status}</span>
                  </td>
                  <td className="num">{fmtInt(h.rows_ok)}</td>
                  <td className="num">{fmtInt(h.new_skus)}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--muted)', maxWidth: 300 }}>
                    {h.error ?? (Array.isArray(h.warnings) && h.warnings.length > 0 ? h.warnings.join(' · ') : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
