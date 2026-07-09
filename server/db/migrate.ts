import type Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply numbered .sql migrations above the current PRAGMA user_version, each in a transaction. */
export function migrate(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (version <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });
    apply();
    console.log(`migration applied: ${file}`);
  }
}
