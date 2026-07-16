// The only file that touches better-sqlite3 directly.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// In the cloud the DB lives on a mounted persistent volume (DATA_DIR=/data); locally it
// defaults to ./data next to the repo.
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'replen.db');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const BACKUP_KEEP = 30;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** One backup per calendar day, keep the newest BACKUP_KEEP. */
export async function backupDaily(): Promise<void> {
  const d = getDb();
  mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const target = join(BACKUP_DIR, `replen-${today}.db`);
  if (existsSync(target)) return;
  await d.backup(target);
  const backups = readdirSync(BACKUP_DIR).filter(f => /^replen-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    unlinkSync(join(BACKUP_DIR, f));
  }
}

/** Every mutation bumps this; cached engine output is keyed on it. */
export function bumpRevision(): number {
  const d = getDb();
  d.prepare('UPDATE state_revision SET rev = rev + 1 WHERE id = 1').run();
  return getRevision();
}

export function getRevision(): number {
  const d = getDb();
  return (d.prepare('SELECT rev FROM state_revision WHERE id = 1').get() as { rev: number }).rev;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
