-- Silicone (CORE) is manufactured and shipped in cartons of 50, with a China minimum of 50, for every
-- product in the family. The tool had this on only 625 of 3,222 CORE SKUs — the rest were blank,
-- including 129 that are actively replenishable. A blank case pack means transfers and POs are sized
-- to the unit rather than the carton, so the tool asks for quantities the factory and the warehouse
-- cannot actually pick.
--
-- Nothing is overwritten: no CORE SKU had a case pack other than 50, so this only fills the blanks.
-- A deliberate per-product exception set later still stands (a bulk multipack with a different
-- carton, say) — this is the family standard, not a lock.
--
-- New CORE SKUs arriving from an Amazon import get the same 50/50 at insert time (server/import/
-- commit.ts), so the standard does not decay as the catalogue grows.
UPDATE skus
SET case_pack = COALESCE(case_pack, 50),
    moq       = COALESCE(moq, 50),
    updated_at = datetime('now')
WHERE category = 'core'
  AND (case_pack IS NULL OR moq IS NULL);
