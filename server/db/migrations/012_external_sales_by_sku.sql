-- Business-Report demand can now be stored PER SKU (from the "by SKU" report), not only per
-- ASIN. This lets an ASIN sold through several SKUs (an FBA SKU + an FBM `_MFN` sibling, or two
-- FBA listings) be attributed correctly instead of double-counted. The `sku` column is NULL for
-- the legacy by-ASIN report. Rebuild the table (SQLite can't drop the old asin PRIMARY KEY in
-- place); existing rows carry over as by-ASIN (sku = NULL).
CREATE TABLE external_sales_new (
  asin        TEXT NOT NULL,
  sku         TEXT,                 -- per-SKU demand (by-SKU report); NULL for by-ASIN
  units       INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  title       TEXT,
  source_file TEXT,
  imported_at TEXT NOT NULL
);
INSERT INTO external_sales_new (asin, sku, units, window_days, title, source_file, imported_at)
  SELECT asin, NULL, units, window_days, title, source_file, imported_at FROM external_sales;
DROP TABLE external_sales;
ALTER TABLE external_sales_new RENAME TO external_sales;
CREATE INDEX idx_external_sales_asin ON external_sales(asin);
CREATE INDEX idx_external_sales_sku ON external_sales(sku);
