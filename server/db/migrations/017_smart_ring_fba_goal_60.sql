-- Smart rings were holding a 90-day shelf goal at Amazon, inherited from the silicone ocean template
-- when migration 016 copied it. That is a poor fit for a product whose December is ~6.5x its July:
-- a 90-day goal buys the whole Christmas peak back in July, parks roughly a quarter of annual volume
-- at Amazon, smears the ordering signal so the transfer schedule reads as flat, and commits to peak
-- volume four months before anyone knows the peak is real.
--
-- 60 days keeps a solid cushion (still builds ahead of the ramp) while letting transfers track the
-- season, so the big shipments land near the peak instead of a quarter early. Verified against the
-- real forecast: zero out-of-stock days at 60 days, with materially less stock idle at Amazon.
-- Only the FBA goal changes; lead time, cadences and buffers are untouched.
UPDATE templates
SET params = json_set(params, '$.fba_target_cover_days', 60),
    notes = 'Smart-ring supply chain: ~90-day China lead (60 production + 25 transit + 5 customs) and a 60-day FBA shelf goal, so transfers track the season instead of buying the peak a quarter early. Applied automatically to WEARABLE SKUs unless a per-SKU template override is set.',
    updated_at = datetime('now')
WHERE name = 'China – smart ring (90-day)';
