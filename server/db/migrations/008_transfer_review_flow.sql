-- Transfer requests gain a review workflow before they go to the warehouse:
--   proposed  → Amazon team's initial request (does NOT touch warehouse stock yet)
--   reviewed  → inventory team has reviewed / adjusted it (original qty preserved)
--   submitted → Amazon team finalized & sent to the warehouse (netting anchor — this is
--               the state the whole pipeline already treats as "in transit to FBA")
--   reconciled / cancelled → unchanged
--
-- SQLite can't alter a CHECK constraint in place, so the table is rebuilt. Existing rows
-- keep their status; requested_qty is backfilled to the current qty.

ALTER TABLE transfers RENAME TO transfers_old;

CREATE TABLE transfers (
  id            INTEGER PRIMARY KEY,
  sku           TEXT NOT NULL,
  qty           INTEGER NOT NULL,      -- current (possibly adjusted) quantity
  requested_qty INTEGER,               -- Amazon team's original ask, for the audit trail
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','reviewed','submitted','reconciled','cancelled','draft')),
  created_at    TEXT NOT NULL,
  reviewed_at   TEXT,                  -- when the inventory team finished its review
  submitted_at  TEXT,                  -- when sent to the warehouse (netting anchor)
  reconciled_at TEXT,                  -- when confirmed created + inbound in Amazon
  batch_id      TEXT,                  -- groups a session's sent transfers (one warehouse file)
  snapshot_id   INTEGER,
  baseline_fba  INTEGER,               -- Amazon avail+inbound captured at send time
  review_note   TEXT,                  -- inventory team's note on the adjustment
  notes         TEXT
);

INSERT INTO transfers (id, sku, qty, requested_qty, status, created_at, reviewed_at,
                       submitted_at, reconciled_at, batch_id, snapshot_id, baseline_fba, review_note, notes)
  SELECT id, sku, qty, qty, status, created_at, NULL,
         submitted_at, reconciled_at, batch_id, snapshot_id, baseline_fba, NULL, notes
  FROM transfers_old;

DROP TABLE transfers_old;
CREATE INDEX idx_transfers_sku ON transfers(sku);
CREATE INDEX idx_transfers_status ON transfers(status);

UPDATE state_revision SET rev = rev + 1 WHERE id = 1;
