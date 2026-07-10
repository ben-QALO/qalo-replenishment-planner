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

Use the sun/moon toggle in the top bar to switch between light and dark; your choice is
remembered.

## First-time setup: scope your catalog

Both source files carry a lot of noise (624 Amazon SKUs, ~8,200 NetSuite items) but you
only stock a few hundred products. On the **Imports** page, paste your list of ASINs (or
SKUs) into **"Products to keep in stock"** and Apply. Everything on the list becomes
replenishable; everything else is set to ignore and drops out of every view. Re-run it
anytime the list changes. New products that appear in a later import and aren't on the
list are surfaced for a keep/ignore decision rather than silently dropped.

## The operating rhythm

Each planning session (~every 2 weeks), on the **Imports** page drop **both** files:
the Amazon FBA Inventory export and your NetSuite warehouse report (Qalo Amazon Inventory
Report). Then work the **Action Center** top-down:

1. **Needs your attention** (the band at the top) — clear it first. It counts, and links
   straight to, every open task: transfers to reconcile, POs to update, new products to
   classify, SKUs missing a sales rate. When it's empty, the numbers below are trustworthy.
2. **Ship to FBA** queue → adjust quantities → **Submit transfer request.** This drops the
   units from usable warehouse stock immediately and downloads the request file to send to
   the inventory team. The units now show as *in transit to FBA* so they're never re-shipped.
3. **Next China PO** queue (sorted by place-by date — top rows are burning) → **Export PO
   proposal** → send to the manufacturer → create the draft PO so the pipeline sees it.

**Next session — reconcile.** The transfers you submitted last time sit under
**Warehouse → Transfers to FBA** (and in the attention band). Once you've confirmed a
shipment was created and is inbound in Amazon, hit **Reconcile** to close it. Nothing moves
status on its own — you own every step; the tool only counts and flags.

Warehouse stock and China POs are the two things Amazon can't see, so the tool relies on
your NetSuite import and your PO status marks to keep the pipeline honest.

### How transfers stay counted (no invisible inventory)

Because NetSuite drops warehouse on-hand when the transfer order is created — well before
the goods reach Amazon — a transfer's units would otherwise vanish during the prep-center
gap. The tool prevents that: from **Submit** until **Reconcile**, the units are held in an
in-transit ledger and counted in your pipeline, and warehouse-side they're netted so they're
never counted twice. Each unit is counted exactly once at every stage.

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
- **Reorder point vs. target — the key distinction.** Each leg has two numbers:
  the **reorder point** (the floor that *triggers* action = lead + one cycle + safety)
  and the **target** (the level it *refills to*). They are different: you top up *to the
  target*, not merely back to the floor.
- **Ship to FBA** fires when FBA days-of-cover drops below the reorder point
  (warehouse→FBA + FBA cadence + safety). It then ships enough to bring FBA up to the
  **FBA target** (default **120 days = 4 months**, editable per template/SKU), rounded to
  case packs and capped by usable warehouse stock.
- **China PO** fires when *total pipeline* cover (FBA + warehouse + in-transit + open POs)
  drops below the PO reorder point (China lead + PO cadence + safety). It orders enough to
  bring the whole pipeline up to the **total target** (default **150 days = 5 months**),
  applies MOQ / order multiples, and gives a **place-by date** — miss it and the SKU goes
  CRITICAL. The total target must exceed the FBA target so the warehouse holds reserve.
- **CRITICAL** means: even if you act today, stock runs out before help can arrive.
  The tool shows how many stockout days air freight would save.
- Every recommendation carries a one-sentence audit trail ("At 21/day, 746 at/heading to
  Amazon = 35 days of cover, below the 63-day reorder point → ship 1,776 to reach your
  120-day FBA target"). If a number looks wrong, open the SKU drawer and check the math.

**Current defaults (Ocean – standard template):** China lead ≈ 60 days (45 production +
14 freight + 1 customs), warehouse→FBA 35 days (~5 weeks), safety 14 days, FBA cadence 14
days, PO cadence 30 days, FBA target 120 days, total target 150 days. Velocity weights
40 / 40 / 10 / 10 across the 7 / 30 / 60 / 90-day windows. All editable under Templates &
Settings, where a plain-English glossary defines every field.

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
