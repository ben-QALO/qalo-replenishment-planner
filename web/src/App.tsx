import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtInt, type SkusResponse } from './api.ts';
import { Drawer, ToastHost } from './components/ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { AllSkus } from './pages/AllSkus.tsx';
import { SkuDetail } from './pages/SkuDetail.tsx';
import { Imports } from './pages/Imports.tsx';
import { WarehousePos } from './pages/WarehousePos.tsx';
import { Templates } from './pages/Templates.tsx';

const SunIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
  </svg>
);
const MoonIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </svg>
);

type Route = { page: string; sku?: string; params: URLSearchParams };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const params = new URLSearchParams(query ?? '');
  if (path.startsWith('sku/')) return { page: 'skus', sku: decodeURIComponent(path.slice(4)), params };
  return { page: path || 'dashboard', params };
}

interface DashMeta {
  today: string;
  snapshot: { snapshot_date: string; age_days: number; row_count: number; revision: number } | null;
  active_template: { id: number; name: string } | null;
  warehouse: { last_updated: string | null; sku_count: number };
  worklist: any;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [version, setVersion] = useState(0);
  const [skus, setSkus] = useState<SkusResponse | null>(null);
  const [meta, setMeta] = useState<DashMeta | null>(null);
  const [templates, setTemplates] = useState<{ id: number; name: string }[]>([]);
  const [drawerSku, setDrawerSku] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark') ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('qalo-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const refresh = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      setRoute(r);
      if (r.sku) setDrawerSku(r.sku);
    };
    window.addEventListener('hashchange', onHash);
    onHash();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.get<SkusResponse>('/api/skus').then(setSkus).catch(() => setSkus(null));
    api.get<DashMeta>('/api/dashboard').then(setMeta).catch(() => setMeta(null));
    api.get<{ templates: any[] }>('/api/templates').then(d => setTemplates(d.templates.map(t => ({ id: t.id, name: t.name })))).catch(() => {});
  }, [version]);

  const go = useCallback((hash: string) => { window.location.hash = hash; }, []);

  const openSku = useCallback((sku: string) => {
    setDrawerSku(sku);
    if (window.location.hash !== `#/sku/${encodeURIComponent(sku)}`) {
      history.replaceState(null, '', `#/sku/${encodeURIComponent(sku)}`);
    }
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerSku(null);
    history.replaceState(null, '', `#/${route.page === 'dashboard' ? '' : route.page}`);
  }, [route.page]);

  const counts = skus?.summary;
  const hotCount = (counts?.stockout ?? 0) + (counts?.critical ?? 0);
  const hasData = !!meta?.snapshot;

  const nav = [
    { key: 'dashboard', label: 'Action Center', hash: '#/', count: hotCount > 0 ? hotCount : undefined, hot: true },
    { key: 'skus', label: 'All SKUs', hash: '#/skus', count: skus?.results.length || undefined },
    { key: 'imports', label: 'Imports', hash: '#/imports' },
    { key: 'warehouse', label: 'Warehouse & POs', hash: '#/warehouse' },
    { key: 'templates', label: 'Templates & Settings', hash: '#/templates' },
  ];

  const staleness = useMemo(() => {
    if (!meta?.snapshot) return 'dead';
    if (meta.snapshot.age_days > 7) return 'stale';
    return 'ok';
  }, [meta]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">
          <div className="brand">QALO</div>
          <div className="sub">Replenishment Planner</div>
        </div>
        <nav className="nav">
          {nav.map(n => (
            <a key={n.key} href={n.hash} className={route.page === n.key ? 'active' : ''}>
              {n.label}
              {n.count !== undefined && <span className={`count${n.hot ? ' hot' : ''}`}>{fmtInt(n.count)}</span>}
            </a>
          ))}
        </nav>
        <div className="foot">local · 127.0.0.1:8787<br />data stays on this Mac</div>
      </aside>

      <main className="main">
        <div className="context-strip">
          <span className={`dot ${staleness === 'ok' ? '' : staleness}`} />
          {meta?.snapshot ? (
            <span>FBA snapshot <b>{meta.snapshot.snapshot_date}</b> ({meta.snapshot.age_days === 0 ? 'today' : `${meta.snapshot.age_days}d old`} · {fmtInt(meta.snapshot.row_count)} SKUs{meta.snapshot.revision > 1 ? ` · rev ${meta.snapshot.revision}` : ''})</span>
          ) : (
            <span>No snapshot imported yet</span>
          )}
          <span>Template: <b>{meta?.active_template?.name ?? '—'}</b></span>
          <span>Warehouse: <b>{meta?.warehouse.last_updated ? meta.warehouse.last_updated.slice(0, 10) : 'no data'}</b></span>
          <span className="spacer" />
          <a href="/api/exports/status.csv">Export full status ↓</a>
          <button className="theme-toggle" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} aria-label="Toggle theme">
            <span className={theme === 'light' ? 'on' : ''}><SunIcon /></span>
            <span className={theme === 'dark' ? 'on' : ''}><MoonIcon /></span>
          </button>
        </div>

        {meta?.snapshot && meta.snapshot.age_days > 7 && (
          <div className="banner">
            The FBA snapshot is {meta.snapshot.age_days} days old — recommendations drift as sales happen. Import a fresh export.
          </div>
        )}

        {!hasData && route.page !== 'imports' ? (
          <div className="page">
            <h1>Welcome</h1>
            <div className="h-sub">Import your first FBA Inventory export to light up the dashboard.</div>
            <div className="card" style={{ padding: 36, textAlign: 'center' }}>
              <p style={{ marginBottom: 16, color: 'var(--muted)' }}>
                Download the FBA Inventory report from Seller Central, then drop it on the Imports page.
              </p>
              <a className="btn primary" href="#/imports">Go to Imports</a>
            </div>
          </div>
        ) : (
          <>
            {route.page === 'dashboard' && skus && <Dashboard data={skus} worklist={meta?.worklist ?? null} refresh={refresh} openSku={openSku} go={go} />}
            {route.page === 'skus' && skus && <AllSkus data={skus} refresh={refresh} openSku={openSku} initialStatus={route.params.get('status')} initialFlag={route.params.get('flag')} />}
            {route.page === 'imports' && <Imports refresh={refresh} />}
            {route.page === 'warehouse' && skus && <WarehousePos data={skus} refresh={refresh} initialTab={route.params.get('tab')} />}
            {route.page === 'templates' && <Templates refresh={refresh} />}
          </>
        )}

        {drawerSku && (
          <Drawer onClose={closeDrawer}>
            <SkuDetail sku={drawerSku} today={meta?.today ?? new Date().toISOString().slice(0, 10)} templates={templates} refresh={refresh} />
          </Drawer>
        )}
      </main>
      <ToastHost />
    </div>
  );
}
