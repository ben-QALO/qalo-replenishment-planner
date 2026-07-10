-- QALO Replenishment Planner — initial schema.

CREATE TABLE skus (
  sku                  TEXT PRIMARY KEY,
  asin                 TEXT,
  fnsku                TEXT,
  title                TEXT,
  classification       TEXT NOT NULL DEFAULT 'unclassified'
                       CHECK (classification IN ('unclassified','replenishable','watch','discontinued','ignore')),
  case_pack            INTEGER,
  moq                  INTEGER,
  order_multiple       INTEGER,
  velocity_override    REAL,
  growth_multiplier    REAL,
  template_override_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  param_overrides      TEXT,
  notes                TEXT,
  first_seen_at        TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE snapshots (
  id              INTEGER PRIMARY KEY,
  snapshot_date   TEXT NOT NULL UNIQUE,
  source_filename TEXT,
  file_hash       TEXT,
  imported_at     TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  row_count       INTEGER NOT NULL
);

CREATE TABLE snapshot_lines (
  snapshot_id       INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  sku               TEXT NOT NULL,
  fnsku             TEXT,
  asin              TEXT,
  condition         TEXT,
  available         INTEGER NOT NULL DEFAULT 0,
  inbound_working   INTEGER NOT NULL DEFAULT 0,
  inbound_shipped   INTEGER NOT NULL DEFAULT 0,
  inbound_received  INTEGER NOT NULL DEFAULT 0,
  reserved          INTEGER NOT NULL DEFAULT 0,
  unfulfillable     INTEGER NOT NULL DEFAULT 0,
  -- NULL means "no data in the export" — distinct from an explicit 0 (true zero-seller).
  units_shipped_t7  INTEGER,
  units_shipped_t30 INTEGER,
  units_shipped_t60 INTEGER,
  units_shipped_t90 INTEGER,
  amazon_days_of_supply REAL,
  amazon_min_inventory_level INTEGER,
  your_price        REAL,
  raw               TEXT,
  flags             TEXT,
  PRIMARY KEY (snapshot_id, sku)
);
CREATE INDEX idx_snapshot_lines_sku ON snapshot_lines(sku);

CREATE TABLE warehouse_inventory (
  sku         TEXT PRIMARY KEY,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  updated_via TEXT NOT NULL CHECK (updated_via IN ('manual','csv','po_receipt','shipment'))
);

CREATE TABLE purchase_orders (
  id               INTEGER PRIMARY KEY,
  po_number        TEXT UNIQUE,
  supplier         TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','ordered','in_transit','received','cancelled')),
  ordered_date     TEXT,
  expected_arrival TEXT,
  received_date    TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE po_lines (
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku          TEXT NOT NULL,
  qty_ordered  INTEGER NOT NULL,
  qty_received INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (po_id, sku)
);
CREATE INDEX idx_po_lines_sku ON po_lines(sku);

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  notes      TEXT,
  params     TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE import_mappings (
  id               INTEGER PRIMARY KEY,
  import_kind      TEXT NOT NULL CHECK (import_kind IN ('fba_inventory','warehouse')),
  header_signature TEXT NOT NULL,
  mapping          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT,
  UNIQUE (import_kind, header_signature)
);

CREATE TABLE import_log (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  filename     TEXT,
  file_hash    TEXT,
  imported_at  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('committed','replaced_previous','failed','cancelled')),
  rows_total   INTEGER,
  rows_ok      INTEGER,
  rows_skipped INTEGER,
  new_skus     INTEGER,
  warnings     TEXT,
  snapshot_id  INTEGER,
  error        TEXT
);

CREATE TABLE plans (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('fba_shipment','china_po')),
  created_at      TEXT NOT NULL,
  template_params TEXT,
  snapshot_id     INTEGER,
  exported_at     TEXT,
  export_filename TEXT
);

CREATE TABLE plan_lines (
  plan_id         INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  sku             TEXT NOT NULL,
  qty_recommended INTEGER NOT NULL,
  qty_final       INTEGER NOT NULL,
  PRIMARY KEY (plan_id, sku)
);

-- Monotonic state revision: every write bumps it; engine results memoize on it.
CREATE TABLE state_revision (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO state_revision (id, rev) VALUES (1, 0);

-- ── Built-in scenario templates ────────────────────────────────────────────
INSERT INTO templates (name, notes, params, is_builtin, created_at, updated_at) VALUES
  ('Ocean – standard',
   '45-day production + 14-day freight ≈ 60 days from PO to warehouse; then ~5 weeks warehouse→FBA. Keeps 4 months at FBA, 5 months total.',
   '{"production_days":45,"transit_days":14,"customs_receiving_days":1,"fba_ship_checkin_days":35,"safety_days":14,"fba_target_cover_days":120,"target_cover_days":150,"review_period_fba_days":14,"review_period_po_days":30}',
   1, datetime('now'), datetime('now')),
  ('Air – expedited',
   'Air freight for urgent replenishment. Shorter China leg, lower safety.',
   '{"production_days":30,"transit_days":8,"customs_receiving_days":3,"fba_ship_checkin_days":35,"safety_days":7,"fba_target_cover_days":120,"target_cover_days":150,"review_period_fba_days":14,"review_period_po_days":30}',
   1, datetime('now'), datetime('now')),
  ('Chinese New Year buffer',
   'Factory shutdown around CNY: production doubled, extra safety. Use for POs that land Dec–Mar.',
   '{"production_days":60,"transit_days":14,"customs_receiving_days":1,"fba_ship_checkin_days":35,"safety_days":21,"fba_target_cover_days":120,"target_cover_days":180,"review_period_fba_days":14,"review_period_po_days":30}',
   1, datetime('now'), datetime('now')),
  ('Peak season (Q4)',
   'Port congestion pads transit; tighter review cadence, higher safety.',
   '{"production_days":45,"transit_days":21,"customs_receiving_days":3,"fba_ship_checkin_days":35,"safety_days":28,"fba_target_cover_days":120,"target_cover_days":170,"review_period_fba_days":7,"review_period_po_days":21}',
   1, datetime('now'), datetime('now'));

-- ── Default settings ───────────────────────────────────────────────────────
INSERT INTO settings (key, value) VALUES
  ('active_template_id', (SELECT CAST(id AS TEXT) FROM templates WHERE name = 'Ocean – standard')),
  ('velocity_weights', '{"w7":0.40,"w30":0.40,"w60":0.10,"w90":0.10}'),
  ('global_growth_multiplier', '1.0'),
  ('order_soon_days', '7'),
  ('overstock_factor', '1.5');
