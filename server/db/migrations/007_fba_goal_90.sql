-- Default FBA goal drops from 120 to 90 days (3 months) on the built-in templates.
-- Custom user templates are left as the user set them.

UPDATE templates SET params = json_set(params, '$.fba_target_cover_days', 90) WHERE is_builtin = 1;

UPDATE templates SET
  notes = '45-day production + 14-day freight ≈ 60 days from PO to warehouse; then ~5 weeks warehouse→FBA. Holds 3 months at Amazon + 1 month warehouse reserve; POs are sized from the reserve.'
  WHERE name = 'Ocean – standard' AND is_builtin = 1;

-- Recommendations recompute against a fresh state revision.
UPDATE state_revision SET rev = rev + 1 WHERE id = 1;
