-- Top-up-every-cycle planning needs the total-pipeline target to be structurally
-- sufficient: it must fund the FBA target, a warehouse buffer, AND the goods perpetually
-- in transit from China (lead-time demand counts toward the pipeline but can never sit
-- in the buffer), plus half a PO cycle between orders. The old 150-day default silently
-- starved the warehouse and FBA against a 120-day FBA target. Make the buffer explicit
-- and raise any total target below its derived floor (engine floors it too).

-- 1. Every template gains an explicit warehouse buffer (default 30 days = 1 month).
UPDATE templates SET params = json_set(params, '$.warehouse_buffer_days', 30)
  WHERE json_extract(params, '$.warehouse_buffer_days') IS NULL;

-- 2. Raise hand-set totals to the derived floor:
--    max(fba_target, fba_rop) + buffer + China lead + review_po/2   (custom templates too).
UPDATE templates SET params = json_set(params, '$.target_cover_days',
  CAST(ROUND(
    max(json_extract(params, '$.fba_target_cover_days'),
        json_extract(params, '$.fba_ship_checkin_days') + json_extract(params, '$.review_period_fba_days') + json_extract(params, '$.safety_days'))
    + json_extract(params, '$.warehouse_buffer_days')
    + json_extract(params, '$.production_days') + json_extract(params, '$.transit_days') + json_extract(params, '$.customs_receiving_days')
    + json_extract(params, '$.review_period_po_days') / 2.0
  ) AS INTEGER))
  WHERE json_extract(params, '$.target_cover_days') <
    max(json_extract(params, '$.fba_target_cover_days'),
        json_extract(params, '$.fba_ship_checkin_days') + json_extract(params, '$.review_period_fba_days') + json_extract(params, '$.safety_days'))
    + json_extract(params, '$.warehouse_buffer_days')
    + json_extract(params, '$.production_days') + json_extract(params, '$.transit_days') + json_extract(params, '$.customs_receiving_days')
    + json_extract(params, '$.review_period_po_days') / 2.0;

UPDATE templates SET
  notes = '45-day production + 14-day freight ≈ 60 days from PO to warehouse; then ~5 weeks warehouse→FBA. Holds 4 months at FBA + 1 month warehouse buffer; the total target also funds goods in transit (225 = 120 + 30 + 60 + ½×30).'
  WHERE name = 'Ocean – standard' AND is_builtin = 1;

-- Recommendations recompute against a fresh state revision.
UPDATE state_revision SET rev = rev + 1 WHERE id = 1;
