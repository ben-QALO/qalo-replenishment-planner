-- Separate the FBA "refill target" from the reorder point, apply real QALO lead times,
-- and update the velocity weights. Existing installs are brought to the new defaults.

-- 1. Every template gains an explicit FBA target (default 120 days = 4 months).
UPDATE templates
  SET params = json_set(params, '$.fba_target_cover_days', 120)
  WHERE json_extract(params, '$.fba_target_cover_days') IS NULL;

-- 2. Warehouse→FBA is a physical ~5 weeks regardless of the China leg — set on all built-ins.
UPDATE templates SET params = json_set(params, '$.fba_ship_checkin_days', 35) WHERE is_builtin = 1;

-- 3. Corrected built-in values.
UPDATE templates SET
  params = json_set(params,
    '$.production_days', 45, '$.transit_days', 14, '$.customs_receiving_days', 1,
    '$.safety_days', 14, '$.fba_target_cover_days', 120, '$.target_cover_days', 150,
    '$.review_period_fba_days', 14, '$.review_period_po_days', 30),
  notes = '45-day production + 14-day freight ≈ 60 days from PO to warehouse; then ~5 weeks warehouse→FBA. Keeps 4 months at FBA, 5 months total.'
  WHERE name = 'Ocean – standard';

UPDATE templates SET params = json_set(params, '$.target_cover_days', 150, '$.fba_target_cover_days', 120)
  WHERE name = 'Air – expedited';

UPDATE templates SET params = json_set(params, '$.transit_days', 14, '$.customs_receiving_days', 1, '$.target_cover_days', 180, '$.fba_target_cover_days', 120)
  WHERE name = 'Chinese New Year buffer';

UPDATE templates SET params = json_set(params, '$.production_days', 45, '$.transit_days', 21, '$.customs_receiving_days', 3, '$.target_cover_days', 170, '$.fba_target_cover_days', 120)
  WHERE name = 'Peak season (Q4)';

-- 4. Velocity weights → 0.40 / 0.40 / 0.10 / 0.10.
UPDATE settings SET value = '{"w7":0.40,"w30":0.40,"w60":0.10,"w90":0.10}' WHERE key = 'velocity_weights';

-- Recommendations recompute against a fresh state revision.
UPDATE state_revision SET rev = rev + 1 WHERE id = 1;
