-- China PO review flow (mirrors transfers) + human-readable, editable names for both.
--
-- POs gain a `review_state` alongside the existing status so we don't have to rebuild the
-- status CHECK constraint: a PO being reviewed is status='draft' with review_state
-- 'proposed' → 'reviewed'; placing the order clears review_state and sets status='ordered'.
-- po_lines.requested_qty records the engine's original ask so the team's adjustments are
-- auditable (same idea as transfers.requested_qty).
--
-- Both transfers (per batch) and POs get an editable `name`/`batch_name` with a readable
-- default, so "T-20260714120000" / "PO #7" become e.g. "Transfer · Jul 14 · 12 SKUs".

ALTER TABLE transfers ADD COLUMN batch_name TEXT;

ALTER TABLE purchase_orders ADD COLUMN name TEXT;
ALTER TABLE purchase_orders ADD COLUMN review_state TEXT;   -- 'proposed' | 'reviewed' | NULL
ALTER TABLE po_lines ADD COLUMN requested_qty INTEGER;      -- original ask, for the audit trail
