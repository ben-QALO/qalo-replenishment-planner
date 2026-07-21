-- The master identity map for every product, three ways:
--   qalo_sku   — QALO's internal SKU (what the team uses for requests; NetSuite is keyed by it)
--   amazon_sku — the Amazon listing SKU we actually SEND INVENTORY TO (the FBA export is keyed by it)
--   asin       — Amazon's product id
-- Relationship is one-to-one-to-one. Maintained by re-importing the mapping CSV
-- (Amazon SKU, Child ASIN, QALO SKU). This is the spine that lets the tool join the
-- NetSuite warehouse report (QALO SKU) to the FBA listing (Amazon SKU) for the ~33 products
-- whose Amazon listing SKU differs from the QALO SKU (e.g. QALO MHD09 → Amazon MHD09.s).
CREATE TABLE sku_map (
  qalo_sku    TEXT PRIMARY KEY,
  amazon_sku  TEXT,
  asin        TEXT,
  source_file TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_sku_map_amazon ON sku_map(amazon_sku);
CREATE INDEX idx_sku_map_asin ON sku_map(asin);
