-- Smart rings take ~90 days to reach the US warehouse from China — far longer than the silicone
-- ocean lead (60 days). Migration 015 shipped the WEARABLE planning feature but never created a
-- template carrying that lead, so smart rings silently inherited the 60-day global template and the
-- ordering report told the team to order ~2 months ahead instead of 3.
--
-- Create the smart-ring template as a COPY of whichever template is currently active, with ONLY the
-- China-lead components changed (60 production + 25 transit + 5 customs = 90). Copying means FBA
-- goals, review cycles and buffers stay exactly as the team already tuned them — the lead time is
-- the only difference. `assemble.ts` then applies this template to every WEARABLE SKU that has no
-- explicit per-SKU override, so tagging a product WEARABLE is enough to get the right lead time.
INSERT INTO templates (name, notes, params, is_builtin, created_at, updated_at)
SELECT
  'China – smart ring (90-day)',
  'Smart-ring supply chain: ~90-day China lead (60 production + 25 transit + 5 customs). Applied automatically to WEARABLE SKUs unless a per-SKU template override is set.',
  json_set(t.params,
    '$.production_days', 60,
    '$.transit_days', 25,
    '$.customs_receiving_days', 5),
  0,
  datetime('now'),
  datetime('now')
FROM templates t
WHERE t.id = COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'active_template_id'), 1)
  AND NOT EXISTS (SELECT 1 FROM templates WHERE name = 'China – smart ring (90-day)');

-- Remember which template is the WEARABLE default (read by assemble.ts).
INSERT INTO settings (key, value)
SELECT 'wearable_template_id', CAST(id AS TEXT) FROM templates WHERE name = 'China – smart ring (90-day)'
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
