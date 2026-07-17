# QALO Replenishment Planner

An internal tool for QALO's team that decides **what to ship to Amazon FBA and what to
order from China**, so best-sellers don't stock out. It ingests Amazon + warehouse data,
computes recommendations with a deterministic engine, and manages the transfer/PO workflow.

## Working with the owner
The primary owner (Benoit) is **non-technical**. Explain changes in plain
language, avoid unexplained jargon, and confirm before anything destructive or
outward-facing (deploys, pushing to GitHub, deleting data). Prefer showing results
(screenshots, verified behavior) over describing them.

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
- Automated tests cover the engine well but **not** the API routes or the React UI.
- `main` has no branch protection; no production error monitoring.
- Business-Report window is assumed 30 days (no selector yet).
