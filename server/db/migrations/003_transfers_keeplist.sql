-- Warehouse→FBA transfer ledger (person-tracked, no auto-advance) and the
-- "keep in stock" catalog scoping list.

CREATE TABLE transfers (
  id            INTEGER PRIMARY KEY,
  sku           TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('draft','submitted','reconciled','cancelled')),
  created_at    TEXT NOT NULL,
  submitted_at  TEXT,          -- when the Amazon team submitted the final request (netting anchor)
  reconciled_at TEXT,          -- when confirmed created + inbound in Amazon
  batch_id      TEXT,          -- groups a session's submitted transfers (one request file)
  snapshot_id   INTEGER,       -- FBA snapshot the transfer was planned against
  notes         TEXT
);
CREATE INDEX idx_transfers_sku ON transfers(sku);
CREATE INDEX idx_transfers_status ON transfers(status);

-- The list of ASINs/SKUs the team actually stocks. Everything else is noise.
CREATE TABLE keep_list (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('asin','sku')),
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);
