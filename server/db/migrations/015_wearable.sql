-- WEARABLE product family (smart rings + the ring sizing kit) planned differently from CORE
-- (silicone). CORE keeps every existing behavior. For WEARABLE the warehouse number is shared
-- across retail/Shopify/Amazon and is NOT trusted for planning, and the China PO becomes an
-- informative monthly report driven by a board-approved yearly forecast.
--
--   category      'core' (default; behaves exactly as today) | 'wearable'
--   wearable_role 'smart_ring' (the SLIM/OG variants the aggregate forecast splits across)
--                 | 'sizing_kit' (R-RNGSZ-03, planned as an attach product) | NULL
--   attach_rate_override  pin the sizing kit's attach rate instead of learning it from sales (NULL = learn)
ALTER TABLE skus ADD COLUMN category TEXT NOT NULL DEFAULT 'core';
ALTER TABLE skus ADD COLUMN wearable_role TEXT;
ALTER TABLE skus ADD COLUMN attach_rate_override REAL;

-- The board-approved yearly forecast for smart rings, in AGGREGATE (SLIM Gold + SLIM Silver +
-- OG Silver combined), as 12 monthly Amazon-basis unit numbers. One row per (year, month).
-- The engine splits each month across the smart-ring SKUs by their trailing sales-velocity share.
CREATE TABLE wearable_forecast (
  year       INTEGER NOT NULL,
  month      INTEGER NOT NULL,   -- 1..12
  units      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (year, month)
);
