-- Per-transfer snapshot of the SKU's Amazon-side units (available + inbound) at submit.
-- Lets the engine tell how much of a transfer Amazon has since taken in, so each unit is
-- counted exactly once regardless of file/reconcile timing.
ALTER TABLE transfers ADD COLUMN baseline_fba INTEGER;
