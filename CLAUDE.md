# QALO Replenishment Planner

An internal tool for QALO's team that decides **what to ship to Amazon FBA and what to
order from China**, so best-sellers don't stock out. It ingests Amazon + warehouse data,
computes recommendations with a deterministic engine, and manages the transfer/PO workflow.

## Working with the owner
The primary owner (Benoit) is **non-technical**. Explain changes in plain
language, avoid unexplained jargon, and confirm before anything destructive or
outward-facing (deploys, pushing to GitHub, deleting data). Prefer showing results
(screenshots, verified behavior) over describing them.

## ALWAYS work from the real, current data
Standing instruction from Benoit (2026-07-29), with blanket permission granted — don't ask each time.
**Never analyse, demo, or draw conclusions from invented sample data.** The local `data/replen.db` is
usually empty; production is the source of truth. Pull a read-only copy first:
```
npm run qa:prod              # fresh copy from Fly + serve the app on :8788 (never writes to prod)
npm run qa:prod -- --no-pull # re-serve the copy already in data/qa-prod/
```
Invented samples have repeatedly produced wrong conclusions — a 4-SKU mock said nothing useful about a
real catalogue of per-size wearable SKUs. If a sandbox or permission block prevents the pull, **say so
immediately** instead of quietly falling back to made-up numbers. If synthetic data is ever shown,
label it as synthetic.

## Run it locally
Two processes; the web dev server proxies `/api` to the API server.
```
npm start          # API server (Fastify + SQLite) on http://localhost:8787 — also serves built web/dist
npm run dev:web    # Vite dev server on http://localhost:5173 (use this while developing; hot-reloads)
npm test           # engine + import unit tests (node --test)
npm run build:web  # build the frontend into web/dist (the Dockerfile does this on deploy)
```
In dev, open **localhost:5173** (has live edits). localhost:8787 serves the *built* copy.

## Architecture
- **`engine/`** — pure, deterministic business logic (no I/O). The heart of the tool.
  - `velocity.ts` — sales-rate resolution. Waterfall: manual override → **Business Report
    demand (FBM+FBA)** → FBA-only "units shipped" windows (with stockout correction) → none.
  - `projection.ts` — `recommendTransfer` (warehouse→FBA) and `recommendPo` (China→warehouse)
    sizing, plus the day-by-day forward projection used by the plan chart.
  - `replenishment.ts` — reorder points, targets, lead-time math. `status.ts` — per-SKU status
    + human "why" sentence. `index.ts` — orchestrates a full run + the summary.
- **`server/`** — Fastify API + SQLite (`better-sqlite3`).
  - `assemble.ts` — builds the engine input from the DB (joins snapshot, warehouse, transfers,
    open POs, and Business-Report demand by ASIN→SKU). `routes/` — one file per resource.
  - `db/migrations/*.sql` — versioned schema, auto-applied on boot (numbered, by `user_version`).
- **`web/src/`** — React + TypeScript (Vite). `pages/` (Dashboard, AllSkus, SkuDetail, Imports,
  WarehousePos, Templates), `components/charts.tsx` (gauges, rings, plan chart), `styles.css`.

## Key domain concepts & decisions
- **Three imports** (Imports page): Amazon FBA Inventory export, NetSuite warehouse report,
  and the **Amazon Business Report** (Sales & Traffic by Child ASIN) which gives *true FBM+FBA*
  demand — the FBA export alone misses FBM and OOS sales. Joined ASIN→SKU. Assumes a **30-day**
  report window (not encoded in the file — a known limitation).
- **Transfer & PO review flow** (mirror each other): the Amazon team proposes from the Action
  Center ("Create transfer/PO for review") → the team reviews & adjusts quantities → it's
  sent/placed. `requested_qty` preserves the original ask for the audit trail. POs use a
  `review_state` column (`proposed`/`reviewed`/null) alongside `status` to avoid rebuilding the
  status CHECK constraint.
- **WEARABLE forecast is entered BY MONTH, not by year** (`server/routes/forecast.ts`, the editor in
  `WearableReport.tsx`). The plan window is a rolling 12 months, so it straddles two calendar years.
  The old year-at-a-time editor made that the user's problem and lost data doing it: `GET` answered
  with whichever year was *highest* on file (so it always opened on next year, never the year just
  edited — saves looked like they had failed), and changing the year field did not reload that year's
  figures, so saving wrote the previous year's numbers over the year typed, silently. The API now
  addresses real `YYYY-MM` months over `plan + china-lead + 1` of them, and a save only touches the
  months it sends. There is no year field left to get wrong.
- **WEARABLE inventory-team export** (`server/export/wearable-xlsx.ts`, route
  `/api/exports/wearable-plan.xlsx`): the Excel workbook the China-PO team plans from. Tabs: Read me
  (how each number is derived) · Allocate now (the headline — `warehouse_prefill_needed`, the units of
  stock already held that must be earmarked for Amazon) · China orders 12mo · Monthly demand 12mo ·
  FBA transfers every 2 weeks (SKU rows × fortnight columns) · one detail tab per SKU showing the full
  chain. It **replaces** the old input, which was "what the Amazon team expects to request over the
  next 4 months" — that described the shelf, not the customer, and lagged a ramp by the whole China
  lead. All inputs come from `server/wearable-inputs.ts`, shared with the SKU-detail chart, so the
  export, the chart and the Ship-to-FBA queue cannot disagree.
- **Case-pack rule** (`recommendTransfer`): prefer whole cases, but ship a **partial** rather
  than nothing when the warehouse can't fill a full case (e.g. 43 of a 50-case → ship 43); for
  slow movers, ship up to a **6-month cover cap** instead of skipping.
- **Dashboard "In-Stock Score"**: velocity-weighted % of selling SKUs that are in stock;
  case-pack-blocked stockouts are excluded so they don't count against you. All dashboard
  figures are scoped to **replenishable ("keep in stock")** SKUs only.
- **Names**: transfers (per batch) and POs have editable, human-readable names with defaults
  like "Transfer · Jul 14" / "China PO · Jul 14".

## Conventions
- **Dark theme only** (light mode was removed). Brand colors live as CSS vars in `styles.css`:
  QRNT gradient `--grad` (purple `#7B78F9` → teal `#17BEBB` → lime `#E9FB4A`); domain colors
  `--c-health` (teal), `--c-ship` (lime), `--c-order` (purple). Fonts: Termina (display),
  Moderat (body), Geist Mono (numbers/data).
- **React inline editors**: use the module-scope `InlineEdit` component (WarehousePos.tsx).
  Never define a component *inside* another component's body and render it as `<X/>` — it
  remounts every render and loses input focus.
- After changing engine math, run `npm test` — the `plan-invariants` suite guards steady-state.

## Data & safety
- SQLite DB at `data/replen.db` (gitignored). Daily backups in `data/backups/`.
- **Never commit business data.** `.gitignore` excludes `data/`, `BusinessReport*.csv`, `/*.csv`.
- To reset to a clean slate: clear the data tables (snapshots, snapshot_lines, skus,
  warehouse_inventory, transfers, purchase_orders, po_lines, plans, plan_lines, keep_list,
  import_log, external_sales) but KEEP `templates`, `settings`, `import_mappings`, `state_revision`.

## Deployment
Docker (`Dockerfile`) builds the frontend and runs the server; `fly.toml` for Fly.io. Optional
shared-password auth via `AUTH_USER`/`AUTH_PASS` env vars (open when unset). DB lives on a
mounted volume (`DATA_DIR`). See `DEPLOY.md`.

## Known gaps (not yet done — a pro team would add these)
- No CI (tests don't run automatically on push) and no type-check step (Vite/esbuild skips it).
- Automated tests cover the engine well; API routes are only starting to be covered
  (`server/routes/__tests__/forecast.test.ts` uses Fastify `inject` + a temp `DATA_DIR` — copy that
  pattern for others). The React UI has no tests.
- `main` has no branch protection; no production error monitoring.
- Business-Report window is assumed 30 days (no selector yet).
