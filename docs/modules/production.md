# Production & BOM — Module Guide

> **Last verified: 2026-09-18** (branch `feat/t013-sequence-lock`, PRD T-013 R1–R15) against
> `src/api/lib/sequence-lock.ts`, `src/api/lib/sequence-unlock-reasons.ts`, `src/api/lib/ordered-batch.ts`,
> `src/api/routes/production-orders/_helpers.ts:4379-4710` (applyPoUpdate) and `:6025-6307` (the gate),
> `src/api/routes/production-orders.ts:444` (report), `:2002`, `:2629`, `:3738` (bulk-patch),
> `src/api/routes/sheets-sync.ts:238`, `src/api/lib/rbac.ts:341` (`requireAdmin`), the four
> `import-completion/*` files, `src/lib/sequence-unlock.ts`, `src/components/sequence-unlock-dialog.tsx`,
> `src/pages/worker/scan.tsx`, `src/pages/production/sequence-unlocks.tsx`, and the four tests named
> in flow 7 — only the **Upstream sequence lock** flow, its gotcha and its key-function rows were
> added or re-verified; every other claim keeps its earlier stamp.

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/routes/production-orders.ts`, `src/api/routes/production-orders/_helpers.ts`, `src/api/routes/{bom,bom-master-templates,job-cards,production-folders,cnc-templates,wip-times,production-leadtimes}.ts`, `src/api/lib/{bom-wip-breakdown,po-cost-cascade,packing-rack-write,packing-piece-identity,fg-completion}.ts`, `src/lib/repair-scope.ts`, `src/pages/production/*`, `src/pages/bom.tsx`, `src/dashboard-routes.tsx`, and `tests/`.
> Corrected 2026-08-13: **`production-orders.ts` was split** — 3,903 lines of handlers plus `src/api/routes/production-orders/_helpers.ts` (5,799) holding every shared function; the 8,595-line figure and ~15 anchors were stale by 2,000–5,000 lines. `src/pages/bom.tsx` is 6,613 lines, so the old `BOMManagementPage` anchor (:6773) pointed **past end of file** — it is at :6136. **`ProductionTimesDialog` does not exist anywhere in `src/pages/` — that row is deleted, not re-pointed.** The `/production/tracker` redirect and the deletion of `production/tracker.tsx` are both confirmed true.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the shop floor: a **dept-tabbed WIP board** (one production_order per confirmed SO item), the **job cards** each PO explodes into, and the **BOM** that drives the explosion. A confirmed SO's production_orders (created upstream in `sales-orders.ts`) are broken into per-department job cards via the BOM's `wipComponents` (`breakBomIntoWips`); workers **scan** each dept complete on the phone, which advances the card, recomputes PO status/progress, cascades completion back to the SO/CO, and fires the **cost cascade** (RM consumption, labour posting, FG batch cost). The board is one 9,643-line page driven entirely by `activeTab` (dept code). **BOM Management** (`bom.tsx`, 6,613 lines) edits `bom_templates` + `bom_versions`, master templates (Bedframe/Sofa/Accessory), per-dept production-time minute rates, and CNC drilldown templates.

## Entry points
- Pages
  - `/production` → `src/pages/production/index.tsx:548` (`ProductionPage` — dept-tabbed WIP board; `activeTab` ∈ ALL/UPHOLSTERY/PACKING/FOAM/FAB_CUT/FAB_SEW)
  - `/production/folders` → `src/pages/production/folders.tsx:39` (`ProductionFoldersPage`) · `/folder-detail` → `src/pages/production/folder-detail.tsx`
  - `/production/tracker` → redirect to `/planning?tab=tracker` (`src/dashboard-routes.tsx`). The Master Tracker lives as a TAB of the Planning page; the standalone `production/tracker.tsx` was deleted 2026-08-13 — unreachable since the route became a redirect, imported nowhere. **`PlanningPage` does not read `?tab=` yet** (`activeTab` is local state), so this redirect and the Production page's own "Master Tracker" button both land on Capacity Overview.
  - `/production/scan` → `src/pages/production/scan.tsx` (shop-floor dept scan) · `/production/fg-scan` → `src/pages/production/fg-scan.tsx`
  - `/production/wip-times` → `src/pages/production/wip-times.tsx` (per-dept minute rates)
  - `/bom` → `src/pages/bom.tsx:6245` (`BOMManagementPage`) · `/cnc-templates` → `src/pages/cnc-templates.tsx`
- API routes
  - PO / job-card / WIP / scan **handlers** → `src/api/routes/production-orders.ts` (3903 lines); every shared
    function lives in `src/api/routes/production-orders/_helpers.ts` (5799). Mounted `worker.ts:1233`.
  - BOM templates + versions → `src/api/routes/bom.ts` (1454) · master variants → `bom-master-templates.ts` (243)
  - Job-card reads + event timeline → `job-cards.ts` (804) · folders group/ungroup → `production-folders.ts` (461)
  - CNC Model→Size/Seat derive → `cnc-templates.ts` (1322) · minute counts → `wip-times.ts` (588) · due-date buffer → `production-leadtimes.ts` (625)
  - BOM explosion engine → `src/api/lib/bom-wip-breakdown.ts` · cost cascade → `src/api/lib/po-cost-cascade.ts`

## Data model
- `production_orders` — one row per confirmed SO item (status, progress, dueDate, `repairscope`). `production_orders_archive` (soft-delete) / `production_orders_list_snapshot` (denormalized fast-read cache).
- `job_cards` — per-department cards a PO explodes into (wipKey, dept, completion PIC/time). `job_cards_archive` / `job_card_events` (event timeline) / `folder_job_cards`.
- `bom_templates` — active BOM (L1 materials + `wipComponents` array holding per-dept minute rates). `bom_versions` — versioned history. `bom_master_templates` — Bedframe/Sofa/Accessory master variants.
- `wip_items` / `wip_cascade_log` (idempotency claim log) · `piece_pics` (per-piece completion + `racking_number`, mig 0192).
- `cnc_templates` — Model→Size/Seat→Files (no category column; `total_height` doubles as sofa seat size; hierarchy DERIVED on FE).
- `cost_ledger` (append-only; written by the cost cascade) · `fg_units` / `fg_batches` (produced on PO completion) · `rack_items` / `rack_locations` (packing occupancy mirror).
- Relationships: SO confirm → production_orders (upstream) → job_cards (via `breakBomIntoWips`); dept scan → recompute PO → cascade to SO/CO + cost cascade → FG units.

## Core flows
1. **BOM explosion → job cards** — `breakBomIntoWips` (`bom-wip-breakdown.ts:350`) reads `bom_templates.wipComponents`, resolves tokens (`resolveWipTokens:151`) and stamps each card's `wipKey` via `deriveTopLevelWipKey` (`:125`) — THE single shared wipKey formula (FAB_SEW splits on `'::'`[2], etc.). Shared with `po-cost-cascade` and `repair-scope`; never re-implement.
2. **Dept scan-complete** — three sibling handlers by dept/sticker: `app.post("/:id/scan-complete")` (`production-orders.ts:1862`, PACKING per-piece), `/scan-complete-dept` (`:2460`, FAB_CUT/FAB_SEW), `/scan-complete-shared` (`:2787`, Sew/Uph). Each has dual auth (dashboard RBAC OR X-Worker-Token), advances the card, then calls `recomputePoStatusAndProgress` (`_helpers.ts:4133`).
3. **PO status recompute + completion cascade** — `recomputePoStatusAndProgress` (`_helpers.ts:4133`) is the single source of truth for PO `status` + progress. On full completion it fans out to `postProductionOrderCompletion` (`fg-completion.ts`, FG units/batches), `postJobCardLabor` (`po-cost-cascade.ts:953`), and the SO/CO cascades (`cascadePoCompletionToSO` `_helpers.ts:3900` / `cascadeUpholsteryToSO` `:3536` / `cascadeCNCompletionToCO` `:3994`).
4. **Cost cascade** — on scan/completion: `consumeRawMaterialsForPO` (`po-cost-cascade.ts:803`, RM_ISSUE), `postJobCardLabor` (`:953`, LABOR_POSTED — idempotent via a `cost_ledger` check in the scan handler), `backfillFGBatchCost` (`:1153`), `postWIPCompletionMarker` (`:1276`). All append-only to `cost_ledger`.
5. **Stock PO create** — `app.post("/stock")` (`production-orders.ts:1187`) builds make-to-stock POs (no SO). Board list read is `app.get("/")` (`:726`) via `fetchFilteredPOs` (`_helpers.ts:1444`); board summary `app.get("/board")` (`:3301`).
6. **BOM edit** — `bom.tsx` `EditBOMDialog` (`:2963`) → `PUT /templates/:id` (`bom.ts:484`); master templates via `MasterTemplatesDialog` (`bom.tsx:3893`). Per-dept minute rates are edited on `src/pages/production/wip-times.tsx` (backed by `wip-times.ts`) and land in `bom_templates.wipComponents`.
7. **Upstream sequence lock** (owner 2026-09-06; switched on and its side doors closed 2026-09-17/18 by PRD T-013, BUG-2026-09-17-182) — a job card may not move to `IN_PROGRESS` / `COMPLETED` / `TRANSFERRED` while the step it depends on is still open. **The rule** is `sequenceBlockers(card, allCards)` in `src/api/lib/sequence-lock.ts:112`, **derived from the BOM at run time**: a card waits for every lower-`sequence` card in its own `(wipKey, branchKey)`, and a card with an EMPTY `branchKey` (the BOM's mark for a convergence step such as UPHOLSTERY / PACKING) also waits for the highest-`sequence` card of every other branch in that `wipKey`. Same-`sequence` cards never block each other; `CANCELLED` upstream never blocks; `TRANSFERRED` counts as done. It reads `job_cards` only — no department list, no settings table, and **never `job_cards.prerequisiteMet`** (stale on 2,611+ of 4,680 rows, measured 2026-09-06). **The gate** is ONE function, `gateJobCardSequence` (`production-orders/_helpers.ts:6100`), called from every everyday completion path: `applyPoUpdate` (`_helpers.ts:4379`, only when `transitionConsumesUpstream(body.status)` so a pure date edit is never blocked; this also covers `/bulk-patch`, which loops back into it), `POST /:id/scan-complete` (`production-orders.ts:2002`), both fan-out scans via `gateFanOutSequence` (`:2629`), and the Google Sheets webhook (`sheets-sync.ts:238`, which releases automatically and records it as `SHEETS_SYNC` — nobody is at that keyboard). Cards already COMPLETED/TRANSFERRED are skipped by the gate, so a co-sign or a re-scan of a finished department is "already done", never "not your turn". Refusal is `409 { code: "UPSTREAM_INCOMPLETE", error, blockedBy: [{id, departmentCode, status}], blockedCards, canSelfUnlock }`. **Unlock:** `canSequenceUnlock` (`:6064`) is the one place that decides — policy constant `ANYONE` today (shadow mode), `SUPERVISORS` later, and no client infers it; the same request re-sent with `unlock: { reason }` is validated by `validateUnlockReason` (`src/api/lib/sequence-unlock-reasons.ts`: required, 3–300 chars, bare "Other" refused → `400 UNLOCK_REASON_REQUIRED`) and then `recordSequenceUnlock` (`:6263`) writes a `scan_override_audit` row with the REAL actor from `resolveSequenceActor` (`:6025` — USER with `displayName`, WORKER from the scan token, SYSTEM only when passed), `overrideCode = 'UPSTREAM_LOCKED'` (the only code mig 0022's CHECK accepts, BUG-2026-09-07-179), and `reason_code` / `department_code` / `blocked_by` / `actor_kind` (self-applied in `ensurePendingMigrations`; migrations-postgres/0237). **Write guard (R13):** `applyPoUpdate`'s job-card UPDATE and the Sheets UPDATE carry `sequenceGuardSql` (`:6213`) — `AND NOT EXISTS (… b.status NOT IN (done, cancelled))` over the structurally-upstream ids — so an upstream card reopened between check and write leaves 0 rows changed and a 409, not a card that passed a lock that no longer held. The three scan endpoints write `piece_pics` rows before their UPDATE, so the guard is NOT applied there; that window is unchanged and known. **Bulk-patch order (R6):** `runGroupedInOrder` (`src/api/lib/ordered-batch.ts`) runs patches sequentially per production order and orders concurrently, so "complete the earlier step too" completes upstream before the blocked card. **Repair endpoints (R4):** the nine `import-completion/*` handlers that write status in bulk are `requireAdmin` (`rbac.ts:341`), not the grid's `production-orders:update`. **Report (R12):** `GET /api/production-orders/sequence-unlocks?days=7` (`production-orders.ts:444`) → `/production/sequence-unlocks` ("Unlock report" button on the production header), grouped by person / step / reason code, real skip vs recording gap. Client side: `asSequenceLockRefusal` + `UNLOCK_REASONS` (re-exported from the shared reasons module) in `src/lib/sequence-unlock.ts`, the three-action `SequenceUnlockDialog` (cancel / unlock and complete / complete the earlier step too; "Other" needs text) on the grid and folder detail, and the worker phone's reason picker in `src/pages/worker/scan.tsx`. Tests: `tests/sequence-lock.test.mjs` (the rule + the grid), `tests/sequence-lock-side-doors.test.mjs` (walks `src/api` for every `job_cards` status writer and fails an unlisted one), `tests/ordered-batch.test.mjs` (observes execution order), `tests/sequence-unlock-reasons.test.mjs` (validation, one-place permission, real actor, same picker on the phone).

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ProductionPage` | `src/pages/production/index.tsx:548` | WIP board; every column/row branches on `activeTab` |
| `filteredOrders` (memo) | `src/pages/production/index.tsx:2881` | Dept-narrow + overdue-set grid filter |
| `loadFgStickers` / `packingStickerUrl` | `src/pages/production/index.tsx:5648 / 5607` | FG sticker set (immediate paint → /p/ token upgrade) |
| `BOMManagementPage` | `src/pages/bom.tsx:6245` | BOM page shell (tabs, list) |
| `EditBOMDialog` / `MasterTemplatesDialog` | `src/pages/bom.tsx:3070 / 4001` | L1+WIP editor / master variants |
| `rowToPO` | `production-orders/_helpers.ts:905` | PO row → API shape (dual-keyed reads) |
| `applyWipInventoryChange` | `production-orders/_helpers.ts:2574` | WIP inventory change; idempotent ONLY when `orgId` passed |
| `recomputePoStatusAndProgress` | `production-orders/_helpers.ts:4133` | Single source of truth for PO status/progress |
| `applyPoUpdate` | `production-orders/_helpers.ts:4274` | Shared PO mutation body (PATCH/PUT) |
| `sequenceBlockers` / `transitionConsumesUpstream` | `src/api/lib/sequence-lock.ts:112 / 172` | THE upstream-order rule (BOM-derived, pure) / which status transitions it gates |
| `gateJobCardSequence` / `canSequenceUnlock` / `resolveSequenceActor` | `production-orders/_helpers.ts:6100 / 6064 / 6025` | THE one sequence gate every completion path calls / the one unlock-policy decision / who is acting (USER, WORKER, SYSTEM) |
| `recordSequenceUnlock` / `sequenceGuardSql` | `production-orders/_helpers.ts:6263 / 6213` | Unlock audit row (reason_code, actor_kind…) / the R13 re-check clause appended to the job-card UPDATE |
| `gateFanOutSequence` / `GET /sequence-unlocks` | `production-orders.ts:2629 / 444` | Fan-out scan gate (thin wrapper, passes the worker) / weekly unlock report |
| `runGroupedInOrder` | `src/api/lib/ordered-batch.ts` | bulk-patch: sequential per PO, POs concurrent (the remedy completes upstream first) |
| `validateUnlockReason` / `UNLOCK_REASON_OPTIONS` | `src/api/lib/sequence-unlock-reasons.ts` | Server validation + the shared reason vocabulary (desktop + phone) |
| `requireAdmin` | `src/api/lib/rbac.ts:341` | SUPER_ADMIN / ADMIN only — the nine bulk status writers in `import-completion/*` |
| `fetchFilteredPOs` | `production-orders/_helpers.ts:1444` | Board list query |
| `ensurePendingMigrations` | `production-orders/_helpers.ts:98` | Runtime column self-apply |
| `app.post("/:id/scan-complete[-dept/-shared]")` | `production-orders.ts:1862 / 2460 / 2787` | Dept scan complete (3 dept/auth variants) |
| `app.patch("/:id")` / `app.post("/stock")` | `production-orders.ts:3772 / 1187` | PO edit (rack-assign) / make-to-stock create |
| `app.post("/packing-rack-tokens")` | `production-orders.ts:1642` | Authed /p/ piece-token mint (batched) |
| `GET /overdue-counts` | `production-orders.ts:393` | Server overdue set behind the grid chips |
| `deriveTopLevelWipKey` / `breakBomIntoWips` | `src/api/lib/bom-wip-breakdown.ts:125 / 350` | THE wipKey formula / BOM → job-card WIPs |
| `consumeRawMaterialsForPO` / `postJobCardLabor` | `src/api/lib/po-cost-cascade.ts:813 / 1116` | RM consumption / labour GL posting |
| `applyPackingRack` | `src/api/lib/packing-rack-write.ts:71` | Rack set/clear + rack_items occupancy mirror |
| `PUT /templates/:id` / `POST /templates/bulk-process-edit` | `src/api/routes/bom.ts:484 / 631` | BOM template update / batch process edit |
| `GET /:id/events` | `src/api/routes/job-cards.ts:430` | Job-card event timeline |

## Gotchas
- **index.tsx is 9,643 lines, driven entirely by `activeTab`.** Almost every column set, row derivation, and render block branches on the dept code — never assume one code path. Don't read end-to-end.
- **WIP idempotency is caller-gated.** `applyWipInventoryChange` (`_helpers.ts:2574`) claims work via `wip_cascade_log` INSERT-ON-CONFLICT **only when `options.orgId` is passed** — callers without orgId stay unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage.
- **wipKey has one owner.** `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:125`) is shared by `breakBomIntoWips`, `po-cost-cascade`, and `repair-scope`. Never re-derive inline — a stale pick throws at confirm.
- **Repair scope drops lines.** `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines via `filterWipsByRepairScope` (`src/lib/repair-scope.ts:410`) — not cosmetic.
- **Production locks are inviolate.** COMPLETED job_cards / non-PENDING fg_units must not be overridden for cosmetic edits; suggest a UI fix instead.
- **The sequence lock is on, and it has ONE rule and ONE gate.** Every completion / start must go through `gateJobCardSequence` — a new write path that sets a card `IN_PROGRESS` / `COMPLETED` without calling it is a side door, and `tests/sequence-lock-side-doors.test.mjs` fails the build for a `job_cards` status writer it does not recognise (list it there with a reason, or gate it). Never re-derive the order from `DEPT_ORDER` / `PRODUCTION_ORDER_BY_WIP_TYPE` (build-time only; a test forbids the import), never read `prerequisiteMet`, and never put `canSelfUnlock: true` anywhere — `canSequenceUnlock` decides. A repair endpoint that writes status in bulk is `requireAdmin`, not `production-orders:update`. Reads of `scan_override_audit` come back camelCase (`reasonCode`), so read dual-keyed like everything else.
- **Snapshot must stay in sync.** `production_orders_list_snapshot` is a denormalized fast-read cache (serve-stale + background refresh) — every write to `production_orders` must keep it current, else the list serves the pre-write row for the rebuild window.
- **Migrations are inert** unless runtime self-applied — new columns reach prod only via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `ensurePendingMigrations` (`production-orders/_helpers.ts:98`), awaited before the first write.
- **Minute rates land in `bom_templates.wipComponents`** via `wip-times.tsx` + `wip-times.ts`; they feed `productionCostRatePerMinuteSen` in the cost cascade. (An earlier version of this doc named a `ProductionTimesDialog` in `bom.tsx` — no such component exists in the tree as of 2026-08-13.)
- **camelCase DB columns** are dual-keyed (`r.camelCase ?? r.snake_case`); db-pg `toCamel` can't recover folded-lowercase camelCase. New columns snake_case; a camelCase write column needs a `column-rename-map.json` entry or it 400s.
- **CNC hierarchy is FE-derived.** `cnc_templates` has no category column (from `products.category`) and `total_height` doubles as sofa seat size — no migration for the Model→Size/Seat→Files hierarchy.
- **Packing rack → warehouse occupancy.** Office PATCH `/:id` (`production-orders.ts:3813` — this said `:8419`, the PRE-SPLIT line, which is past the end of the 3,944-line file), the public /p/ scan, and worker scan ALL funnel through `applyPackingRack` (`packing-rack-write.ts:71`), which also mirrors ONE `rack_items` row per piece + recomputes `rack_locations.status`. Piece identity comes from the shared `packingPieceIdentity` (`packing-piece-identity.ts:48`) — don't re-inline the formula (BUG-2026-06-25-007).
- **Overdue chips filter the main grid** (owner 2026-06-23) — clicking "Bedframe ⚠ N" / "Sofa ⚠ N" narrows the grid (`overduePanelMode` state, `filteredOrders`) to the server overdue set from `/overdue-counts` (`production-orders.ts:393`); it does NOT pop a separate panel. Don't reintroduce the drill-down panel.
- **Combo pricing is upstream.** Sofa-combo pricing is backend-unified in `sales-orders.ts`; production reads the already-priced SO — never re-price in the production layer.

## Common tasks (mini-playbook)
- **Add a field to a PO** → column self-apply in `ensurePendingMigrations` (`production-orders/_helpers.ts:98`); persist in `applyPoUpdate` (`_helpers.ts:4274`); surface in `rowToPO` (`_helpers.ts:905`); render in `index.tsx:548`. New column snake_case (+ rename-map if camelCase). Keep the list snapshot in sync.
- **Change the scan/completion cascade** → edit `recomputePoStatusAndProgress` (`_helpers.ts:4133`) and the relevant `scan-complete*` handler (`production-orders.ts:1862`/`:2460`/`:2787`); keep the SO/CO cascade (`cascadePoCompletionToSO` `_helpers.ts:3900`) and cost cascade (`po-cost-cascade.ts`) in sync.
- **Adjust the cost cascade** → `consumeRawMaterialsForPO` / `postJobCardLabor` / `backfillFGBatchCost` in `po-cost-cascade.ts:803/953/1153`; all append-only to `cost_ledger`, guard idempotency (labour checks `cost_ledger` before posting).
- **Change BOM explosion** → `breakBomIntoWips` / `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:350/125`); verify with `tests/bom-explosion.test.mjs` + `tests/production-order-builder.test.mjs`. Never re-implement the wipKey formula.
- **Touch a BOM template** → `bom.tsx` dialogs → `bom.ts` (`GET /templates:231`, `PUT /templates:377`, `PUT /templates/:id:484`, `bulk-process-edit:631`); master variants via `bom-master-templates.ts`.

## Related modules
[[sales]] [[inventory]] [[procurement]] [[delivery]] [[accounting]] [[planning]]
