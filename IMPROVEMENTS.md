# QALO Replenishment Planner — Improvements list

Running list of improvements found while QA-ing the July 2026 China PO (tool vs team).
Newest issues at the top. Status: 🔴 not started · 🟡 in progress · 🟢 done.

---

## 3. 🟡 Rock-solid SKU mapping — coverage warning + validation export + warehouse fix  ·  BUILT LOCALLY, NOT DEPLOYED

Built + verified against a copy of live data (all 108 tests pass):
- **Warehouse import fix** (`warehouse.ts`): NetSuite rows now translate QALO→Amazon via `sku_map`
  before matching; unmatched-with-stock rows are surfaced, not dropped. Verified: NetSuite `MBK09-O`
  646 → lands on `MBK09-O.s`, its China order dropped **500 → 0**; a non-catalog junk row was reported
  as skipped. 1→many maps sum instead of overwrite.
- **Coverage warning** (`sku-map.ts` `GET /api/sku-map` + Imports UI + Action Center "to-do first"
  gate via `dashboard.ts` `unmapped_skus` + Dashboard.tsx): shows "N of M products have no QALO↔Amazon
  mapping" on the Imports page AND "N missing a SKU mapping" in the Action Center to-do strip; warns
  loudly but keeps planning (per Benoit). Verified: 501/501 unmapped (empty) → 1/501 after a mapping;
  Action Center to-do shows 501.
- **Validation export** (`GET /api/sku-map/export.csv` + Imports button): every product with QALO SKU,
  Amazon SKU, ASIN, Mapped?, warehouse qty, classification; flags stale mappings too.

STILL TO DO before this helps in production:
- **Deploy** — prod is a schema version behind and has no `sku_map` at all; none of this is live yet.
- **Upload the REAL mapping** — my local test used a mapping *derived* by stripping ".s"; the true one
  (and oddballs like `FBA18YPL9799.missing1`, `MSC14.`) must come from Benoit's master list.
- **Clean malformed catalog identities** (`.missing1`, trailing `.`) — the export now makes them visible.

---

## 2. 🟢 Fix NetSuite → SKU warehouse mapping (warehouse stock silently orphaned)  ·  FIXED (folded into #3), pending deploy

**What's wrong (VERIFIED in code):** the QALO↔Amazon SKU mapping IS provided and works for the
*display* (assemble.ts `qaloOf`) — but it is **never applied during the NetSuite warehouse import**.
`server/routes/warehouse.ts:37` matches each NetSuite row's SKU against the catalog by **exact string
equality** and silently `continue`s (drops it) on no match:
`if (!known.has(row.sku)) continue;`. So NetSuite `MBK09-O` (646 units) doesn't match the catalog key
`MBK09-O.s` → the 646 is skipped → engine reads warehouse = **0**. Its sibling `MBK08-O` is stored plain
in the catalog, matches, and lands fine — which is why only some sizes break.
The mapping is half-wired: display/engine identity use it; the warehouse importer does not.
(Earlier I wrongly blamed an "empty sku_map" — that was an analysis error on a stale DB copy.)

**Why it matters:** the tool thinks these SKUs have no warehouse stock, so it re-orders them from China —
stock you already own. This is real over-ordering, not a rounding artifact.

**Impact (live data):** 22 SKUs affected, **19 in the current China PO, ~6,850 units** ordered while
warehouse shows 0. Includes real movers: MHD10 (ordering 1,600), MHD11 (950), MHD09 (950), SMB05 (550),
MBK09-O (500 — while ~646 sit in the warehouse). Also several malformed identities to clean up
(`FBA18YPL9799.missing1`, `MSC14.` with a trailing dot).

**Fix:** apply the QALO↔Amazon map inside the warehouse import — translate each NetSuite row's SKU to
the catalog key before the `known.has(...)` check and upsert (`warehouse.ts:37-38`). Also: (a) surface
skipped/unmatched NetSuite rows in the import result instead of dropping them silently, and (b) make
sure the mapping (`sku_map`) is actually populated & persisted in the deployed env (prod DB pulled this
session had no `sku_map` table — schema was a version behind the current code, so the fix isn't deployed).
Then re-run and confirm MBK09-O etc. show their real warehouse stock and their China orders drop.

**Found by:** Benoit spotted MBK09-O showing 646 in NetSuite but 0 in the tool — correct instinct; my
first root-cause was wrong, the verified cause is warehouse.ts:37 not applying the mapping.

---

## 1. 🟢 Smarter order rounding — round to the nearest case of 50, not always up  ·  BUILT + TESTED, pending deploy

DONE in `engine/projection.ts`: added `roundTo` (round half-up) and switched `recommendPo` from
`ceilTo` to `roundTo` (transfers still use `ceilTo`). MOQ-50 floor intact. Verified: ~9% fewer China
units (6,750 on the current dataset) from cases that were barely over a line; 108/108 tests pass
including the plan-invariant stockout guards. Original write-up below.


**What's wrong:** once the tool decides to order a SKU, it floors to the 50 MOQ and then rounds **up**
to the next 50 (`ceilTo`, `server/projection.ts:132`). So a true need of 53 becomes 100, and 101 becomes
150 — a whole extra case for being barely over a line.

**Proposed change:** keep the 50-unit MOQ floor (one case is the real China minimum), but round to the
**nearest** 50 instead of up. 16 → 50, 53 → 50, 74 → 50, 75 → 100, 101 → 100, 126 → 150.

**Impact (live data, estimated):** ~**6,400 units (9%)** off the order across 128 SKUs, all in the
"barely over a case" zone. Does NOT touch trickle SKUs (a need of 16 still becomes 50 — one case is the
true minimum, correct to keep them in stock, e.g. SMB04 which sold out under the team's plan).

**Tradeoff:** rounding down can leave a SKU up to ~24 units under target — weeks of cover for a slow
mover, <1 week for a fast one. Safe. Optional refinement: round-up only for the few highest-velocity SKUs.

**Fix:** one-line change (`ceilTo` → round-to-nearest) in `server/projection.ts`, then run `npm test`
(the plan-invariants suite guards against introducing stockouts).

**Found by:** Benoit — "if we need 53, stay at 50; if we need 75, bump to 100."
