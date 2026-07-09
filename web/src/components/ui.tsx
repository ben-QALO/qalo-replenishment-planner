import React, { useEffect, useState } from 'react';
import { STATUS_META } from '../api.ts';

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, c: 'var(--neutral)', bg: 'var(--neutral-bg)' };
  return (
    <span className="badge" style={{ ['--b-c' as any]: meta.c, ['--b-bg' as any]: meta.bg }}>
      {meta.label}
    </span>
  );
}

export function Flags({ flags, max = 3 }: { flags: string[]; max?: number }) {
  const interesting = flags.filter(f => f !== 'NEW_UNCLASSIFIED');
  if (interesting.length === 0) return null;
  return (
    <span title={interesting.join(', ')}>
      {interesting.slice(0, max).map(f => (
        <span key={f} className="flag">{f.toLowerCase().replace(/_/g, ' ')}</span>
      ))}
      {interesting.length > max && <span className="flag">+{interesting.length - max}</span>}
    </span>
  );
}

export function Tile(props: {
  n: number | string; label: string; sub?: string; color: string;
  selected?: boolean; onClick?: () => void;
}) {
  return (
    <button className={`tile${props.selected ? ' selected' : ''}`} style={{ ['--tile-c' as any]: props.color }} onClick={props.onClick}>
      <div className="n">{props.n}</div>
      <div className="lbl">{props.label}</div>
      <div className="sub">{props.sub ?? ''}</div>
    </button>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="drawer">{children}</div>
    </>
  );
}

let toastFn: ((msg: string) => void) | null = null;

export function toast(msg: string) { toastFn?.(msg); }

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastFn = (m: string) => {
      setMsg(m);
      window.setTimeout(() => setMsg(null), 3400);
    };
    return () => { toastFn = null; };
  }, []);
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
