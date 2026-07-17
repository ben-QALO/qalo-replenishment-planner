-- Retire the tool-side "send/deduct/reconcile" step for transfers. The tool no longer tracks
-- transfers on its own: NetSuite (warehouse on-hand) and Amazon (inbound) are the source of
-- truth, and the assemble layer no longer nets 'submitted' transfers against them. The transfer
-- worksheet is now Propose -> Review -> Export (which closes the batch as status='reconciled').
--
-- Any transfer left in the old 'submitted' ("in transit to FBA, awaiting reconcile") state is
-- closed here so nothing is stuck in a state the UI no longer shows. This is a status-only
-- cleanup; it changes no quantities and no warehouse numbers.
UPDATE transfers
   SET status = 'reconciled',
       reconciled_at = COALESCE(reconciled_at, submitted_at, created_at)
 WHERE status = 'submitted';
