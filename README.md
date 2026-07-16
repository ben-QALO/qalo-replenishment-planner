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
   straight to, every open task: requests to review, requests to send, transfers to
   reconcile, POs to update, new products to classify, SKUs missing a sales rate. When it's
   empty, the numbers below are trustworthy.
2. **Ship to FBA** queue → adjust quantities → **Create request for review.** This starts a
   transfer request; nothing leaves the warehouse yet.
3. **Next China PO** queue (sorted by place-by date — top rows are burning) → **Export PO
   proposal** → send to the manufacturer → create the draft PO so the pipeline sees it.

### The transfer request flow (Warehouse → Transfers to FBA)

A request moves through three stages, each a hand-off between two teams:

1. **Proposed — inventory team to review.** The Amazon team's request lands here. The
   inventory team checks and adjusts each quantity (the original ask is kept for the record),
   can leave a note, then **Mark reviewed.**
2. **Reviewed — Amazon team to finalize & send.** The Amazon team applies any last changes
   and **Send to warehouse.** *This* is the moment units leave usable warehouse stock, start
   counting as *in transit to FBA*, and the warehouse file downloads. (Or **Send back** to
   return it to the inventory team.)
3. **In transit to FBA — awaiting reconciliation.** Once you confirm the shipment was
   created and is inbound in Amazon, hit **Reconcile** to close it.

Units are only deducted from the warehouse when a request is **sent** — reviewing and
adjusting never churns your numbers. Every stage has per-row and bulk actions, and Cancel
works at any point (sent units return to the warehouse). Nothing moves status on its own —
you own every hand-off; the tool only counts and flags.

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
- **The decision model is a day-by-day projection.** Instead of comparing today's totals
  against abstract thresholds, the tool plays each product's sales and your real lead times
  forward and asks the only question that matters: *will Amazon or the warehouse drop too
  low before the next shipment or order can arrive?* Every recommended number is the amount
  that prevents the first shortfall — and it traces to a date you can see on the runway
  chart. This was validated by simulating years of the QALO scenario across cold-start,
  at-target, and overstocked starts: zero stockouts, the warehouse reserve never breached.
- **Ship to FBA** brings Amazon back up to your **FBA goal as the shipment lands** (default
  **90 days**): it counts what's already on the way and subtracts the ~5 weeks of sales
  during the transfer, so a shipment that takes 5 weeks still arrives on-goal. The
  **warehouse reserve** (default **30 days**) throttles *routine* top-ups only — it is a
  **soft floor**: if Amazon would otherwise run dry (cover below the ship leg + one cycle),
  the tool ships the reserve too. Being in stock at Amazon always outranks holding the
  buffer. If even the whole warehouse can't cover the need, the tool shows all three
  numbers — **required / can give / short by** — and never hides the gap. It also **won't
  ship a product already at/above its goal**, or **into an overstocked pipeline**.
- **Case packs + the ¾ rule.** Shipments round to whole case packs, and a partial case is
  only shipped if the need fills **at least ¾ of a case** — otherwise it's skipped this
  cycle. This keeps slow sellers from getting a whole case for a handful of units of demand:
  a product that can't use ¾ of a case doesn't get one. (Exception: if Amazon would run dry
  before a shipment could land, it rounds up to guarantee cover.)
- **China PO** is sized against the **whole system's need**, from one conservation identity:
  the total inventory that must exist at once to keep the FBA goal on the shelf =
  **FBA goal + warehouse→FBA transit leg + warehouse reserve + China lead + ½ PO cycle**
  (every term is "units that must be *somewhere* to keep Amazon full"). It orders up to that,
  minus everything you already have or have on order. One formula, two behaviors: **a deficit
  is closed in a single order, placed today** (not dribbled out over months while Amazon runs
  thin), and in steady state it settles to about **one month of sales per monthly PO**.
- **The plan is validated, not trusted.** A forward simulation replays these exact rules for
  every SKU, and an invariant check (`engine/__tests__/plan-invariants`) fails the build if
  any archetype's Amazon stock can't *sustain* its goal in steady state or goes dark once the
  chain could respond. This is what killed the old "patch a term, hope it's complete" cycle:
  a missing term now shows up as a failing test, not as lost sales.
- **CRITICAL** means the projection shows Amazon running out before *any* new stock can
  physically arrive, even if you act today. The tool shows how many days air freight saves.
- Every recommendation carries a plain-English sentence ("Selling about 21/day, Amazon has
  about 5 weeks of stock. A shipment takes about 5 weeks to arrive, so act this cycle. Ship
  1,300 now so it's back to your 90-day goal when it lands."). If a number looks off, open
  the product to see the projection behind it.

**Current defaults (Ocean – standard template):** China lead ≈ 60 days (45 production +
14 freight + 1 customs), warehouse→FBA 35 days (~5 weeks), safety 14 days, transfers every
14 days, POs every 30 days, FBA goal 90 days, warehouse reserve 30 days. Velocity weights
40 / 40 / 10 / 10 across the 7 / 30 / 60 / 90-day windows. All editable under Templates &
Settings, where a
plain-English glossary defines every field.

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
