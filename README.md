# QALO Replenishment Planner

A local dashboard that keeps QALO from running out of stock on Amazon. It reads the
weekly FBA Inventory export, tracks your US warehouse and China purchase orders, and
tells the team exactly **what to ship to FBA this cycle** and **what to put on the
next China PO** — before anything runs dry.

Everything runs on this Mac. No cloud, no accounts. Data lives in `data/replen.db`
(backed up daily to `data/backups/`).

## Starting the app

Double-click **`start.command`**. The dashboard opens at http://localhost:8787.

First run may take a minute (it sets up its own copy of Node.js inside the project
folder — nothing is installed system-wide). If it fails, read `data/logs/start.log`.

## The operating rhythm

The tool works when the data is fresh. Three habits:

| When | Who | What |
|---|---|---|
| **Every Monday** (~5 min) | Marketplace analyst | Download the FBA Inventory export from Seller Central → drop it on the **Imports** page → classify any new SKUs it finds. |
| **Every FBA shipment day** (~15 min, biweekly) | Ops | Open the **Action Center** → review the *Ship to FBA* queue → adjust quantities if needed → **Export shipment plan** (paste-ready for Send to Amazon) → confirm the warehouse deduction. |
| **Every PO cycle** (~30 min, monthly) | Director | Review the *Next China PO* queue (sorted by place-by date — the top rows are burning) → adjust → **Export PO proposal** → send to the manufacturer → create the draft PO so the pipeline math sees it. When goods arrive, use **Receive** on the PO to add them to warehouse stock. |

Also: whenever warehouse counts change outside the tool, update them under
**Warehouse & POs** (inline edit, or paste `SKU,qty` lines).

## How the math works (so you can trust it)

- **Velocity** = weighted blend of Amazon's own units-shipped over the last
  7/30/60/90 days (weights editable in Settings), × a growth multiplier you control
  (global or per SKU). Blank sales data counts as *unknown*, never zero — those SKUs
  go to the At-risk queue instead of getting a made-up recommendation.
- **Stockout correction** (on by default, the fix for recurring stockouts): when a SKU
  is out of stock, its recent Amazon sales look artificially low — it couldn't sell
  because it was empty. Left alone, that makes it look slow, so it gets under-ordered
  and stocks out again. With correction on, velocity uses the item's best *in-stock*
  sales rate (and, once weekly snapshots accumulate, divides sales by in-stock days
  only). Corrected SKUs carry a `stockout corrected` tag and say so in their audit
  sentence. Toggle under Templates & Settings → Velocity model.
- **Ship to FBA** fires when FBA days-of-cover < (ship+check-in) + (review cadence) +
  (safety days). Order-up-to that level, rounded to case packs, capped by warehouse stock.
- **China PO** fires when *total pipeline* cover (FBA + warehouse + open POs) <
  (China lead) + (PO cadence) + (safety). Applies MOQ and order multiples, and gives a
  **place-by date** — miss it and the SKU goes CRITICAL.
- **CRITICAL** means: even if you act today, stock runs out before help can arrive.
  The tool shows how many stockout days air freight would save.
- Every recommendation carries a one-sentence audit trail ("At 2.3/day, 115 units =
  58 days of cover vs a 114-day reorder point → order 111"). If a number looks wrong,
  open the SKU drawer and check the math.

## Lead-time templates

Templates & Settings holds scenario parameter sets: **Ocean – standard**,
**Air – expedited**, **Chinese New Year buffer**, **Peak season (Q4)**. One is active
globally; any SKU can override. Switching recomputes everything instantly and shows
what changed. Duplicate-and-edit to make your own — the defaults are starting points;
tune them to your actual lanes.

## For maintainers

```
npm test            # engine + import test suites (node --test)
npm start           # run the server (serves the committed web/dist)
npm run build:web   # rebuild the frontend after changing web/src (commit dist/)
```

- `engine/` is pure — no I/O, `today` injected. All replenishment math lives there,
  fixture-tested.
- `server/` is Fastify + better-sqlite3. Recommendations are never persisted; they
  recompute from current state (memoized on a revision every write bumps).
- `data/` is gitignored: the SQLite DB, daily backups, archived import files, exports.
