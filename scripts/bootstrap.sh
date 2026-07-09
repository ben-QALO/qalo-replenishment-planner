#!/bin/bash
# Bootstrap for the QALO Replenishment Planner.
# Provisions a private Node runtime if none is usable, installs deps, starts the
# server, and opens the dashboard. Never touches anything outside this folder.
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/start.log"
PORT=8787
URL="http://localhost:$PORT"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

fail() {
  log "ERROR: $1"
  osascript -e "display dialog \"QALO Replenishment Planner could not start.\n\n$1\n\nDetails were saved to data/logs/start.log\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1
  exit 1
}

# ── 0. Already running? Just open the browser. ──────────────────────────────
if curl -sf --max-time 2 "$URL/health" >/dev/null 2>&1; then
  log "Server already running — opening browser."
  open "$URL"
  exit 0
fi

# ── 1. Find or provision Node ────────────────────────────────────────────────
WANT_NODE="$(cat .node-version | tr -d '[:space:]')"
WANT_MAJOR="${WANT_NODE%%.*}"
NODE_BIN=""

# Prefer the project's private runtime, then any system node of the right major.
if [ -x "$ROOT/runtime/node/bin/node" ]; then
  NODE_BIN="$ROOT/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  SYS_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$SYS_MAJOR" -ge "$WANT_MAJOR" ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) NODE_ARCH="darwin-arm64" ;;
    x86_64) NODE_ARCH="darwin-x64" ;;
    *) fail "Unsupported Mac architecture: $ARCH" ;;
  esac
  TARBALL="node-v$WANT_NODE-$NODE_ARCH.tar.gz"
  BASE="https://nodejs.org/dist/v$WANT_NODE"
  log "Downloading Node $WANT_NODE ($NODE_ARCH) — one-time setup, ~50 MB..."
  mkdir -p "$ROOT/runtime"
  curl -fL --progress-bar "$BASE/$TARBALL" -o "$ROOT/runtime/$TARBALL" 2>>"$LOG" \
    || fail "Could not download Node.js. Check your internet connection and try again."
  # Verify checksum against the official SHASUMS file.
  curl -fsL "$BASE/SHASUMS256.txt" -o "$ROOT/runtime/SHASUMS256.txt" 2>>"$LOG" \
    || fail "Could not download the Node.js checksum file."
  EXPECTED="$(grep " $TARBALL\$" "$ROOT/runtime/SHASUMS256.txt" | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$ROOT/runtime/$TARBALL" | awk '{print $1}')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] \
    || fail "The downloaded Node.js file failed its security checksum. Please try again."
  tar -xzf "$ROOT/runtime/$TARBALL" -C "$ROOT/runtime" || fail "Could not unpack Node.js."
  rm -rf "$ROOT/runtime/node"
  mv "$ROOT/runtime/node-v$WANT_NODE-$NODE_ARCH" "$ROOT/runtime/node"
  rm -f "$ROOT/runtime/$TARBALL" "$ROOT/runtime/SHASUMS256.txt"
  NODE_BIN="$ROOT/runtime/node/bin/node"
  log "Node $WANT_NODE installed inside the project folder."
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"
log "Using node: $NODE_BIN ($("$NODE_BIN" -v))"

# ── 2. Install dependencies if missing or lockfile changed ──────────────────
LOCK_HASH_FILE="node_modules/.package-lock.hash"
LOCK_HASH="$(shasum -a 256 package-lock.json 2>/dev/null | awk '{print $1}')"
if [ ! -d node_modules ] || [ "$(cat "$LOCK_HASH_FILE" 2>/dev/null)" != "$LOCK_HASH" ]; then
  log "Installing dependencies (first run can take a minute)..."
  "$NODE_DIR/npm" ci >>"$LOG" 2>&1 || fail "Dependency install failed. See data/logs/start.log."
  echo "$LOCK_HASH" > "$LOCK_HASH_FILE"
fi

# ── 3. Start the server ──────────────────────────────────────────────────────
log "Starting server..."
nohup "$NODE_BIN" server/index.ts >>"$LOG" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 40); do
  if curl -sf --max-time 1 "$URL/health" >/dev/null 2>&1; then
    log "Server is up (pid $SERVER_PID) — opening $URL"
    open "$URL"
    exit 0
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "The server exited during startup. See data/logs/start.log."
  sleep 0.5
done
fail "The server did not respond within 20 seconds. See data/logs/start.log."
