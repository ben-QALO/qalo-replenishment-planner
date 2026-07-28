#!/usr/bin/env bash
# QA against REAL production data, without touching production and without any password.
#
# Why this exists: the live site is behind a shared password, so screens can't be read directly, and
# guessing at what production holds led to advice that turned out to be wrong. This pulls a READ-ONLY
# COPY of the production database to this machine and serves the app from that copy, so the UI shows
# exactly what the team sees — while production itself is never written to.
#
#   npm run qa:prod          pull a fresh copy and serve it on :8788
#   npm run qa:prod -- --no-pull   re-serve the copy already downloaded (offline / faster)
#
# The copy lands in data/qa-prod/ (gitignored). Nothing here ever writes back to Fly.
set -euo pipefail

APP="${FLY_APP:-qalo-replen}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/data/qa-prod"
PORT="${QA_PORT:-8788}"

mkdir -p "$DEST/backups"

if [[ "${1:-}" != "--no-pull" ]]; then
  echo "→ pulling production database from $APP:/data (read-only copy)"
  cd "$DEST"
  # SQLite in WAL mode keeps recent commits in -wal. Pulling replen.db alone shows STALE data — a
  # trap that has already cost a debugging session — so all three files come across together.
  for f in replen.db replen.db-wal replen.db-shm; do
    if fly ssh sftp get "/data/$f" --app "$APP" >/dev/null 2>&1; then
      echo "   ✓ $f"
    else
      # -wal/-shm are absent after a clean checkpoint; only the main file is mandatory.
      [[ "$f" == "replen.db" ]] && { echo "   ✗ $f could not be pulled — aborting"; exit 1; }
      rm -f "$f"; echo "   · $f not present (checkpointed) — fine"
    fi
  done
  cd "$ROOT"
fi

[[ -f "$DEST/replen.db" ]] || { echo "no copy at $DEST/replen.db — run without --no-pull first"; exit 1; }

echo "→ snapshot of what production actually holds:"
node -e '
const D=require("better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
const n=t=>{try{return db.prepare("SELECT COUNT(*) c FROM "+t).get().c;}catch{return "n/a";}};
const s=db.prepare("SELECT snapshot_date,row_count FROM snapshots ORDER BY snapshot_date DESC LIMIT 1").get();
console.log("   latest FBA snapshot:", s?`${s.snapshot_date} (${s.row_count} rows)`:"NONE");
console.log("   skus:",n("skus")," warehouse rows:",n("warehouse_inventory")," open POs:",n("purchase_orders"));
console.log("   wearable-tagged:",db.prepare("SELECT COUNT(*) c FROM skus WHERE category=?").get("wearable").c,
            " forecast months:",n("wearable_forecast"));
db.close();
' "$DEST/replen.db"

echo "→ serving production data locally at http://127.0.0.1:$PORT  (production is untouched)"
DATA_DIR="$DEST" PORT="$PORT" exec node "$ROOT/server/index.ts"
