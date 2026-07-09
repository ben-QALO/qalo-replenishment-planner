-- Correct velocity for out-of-stock periods so stocked-out SKUs aren't under-ordered.
-- On by default; the death spiral (OOS → looks slow → under-ordered → OOS again) is
-- the top cause of recurring stockouts.
INSERT OR IGNORE INTO settings (key, value) VALUES ('stockout_correction', '1');
