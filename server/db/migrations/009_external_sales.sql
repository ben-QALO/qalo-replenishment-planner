-- True demand from Amazon's Business Report (Sales & Traffic by Child ASIN). Unlike the
-- FBA "units shipped" figure, this counts EVERY channel — FBA plus FBM — so a product that
-- is out of stock on FBA but selling via merchant-fulfilled, or a brand-new item being
-- tested on FBM, still shows its real sales rate. Keyed by child ASIN; joined to SKUs by
-- their ASIN at planning time. One current report (replaced on each import).
CREATE TABLE external_sales (
  asin        TEXT PRIMARY KEY,
  units       INTEGER NOT NULL,     -- units (or order items) sold over the window
  window_days INTEGER NOT NULL,     -- length of the report window, in days
  title       TEXT,
  source_file TEXT,
  imported_at TEXT NOT NULL
);
