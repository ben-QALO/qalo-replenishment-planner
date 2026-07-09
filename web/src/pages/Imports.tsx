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
        Drop the FBA Inventory export here weekly (Seller Central → Inventory → Inventory Planning → download, or the report your team already pulls). Each import becomes a dated snapshot.
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
        {busy ? 'Working…' : <><b>Drop your FBA Inventory export</b> (.csv / .txt) — or click to choose a file</>}
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
