# RBAC Remediation — current state and the way through

> **Last verified: 2026-09-14 (second pass)** against `src/api/lib/rbac.ts` and
> `src/api/routes/auth.ts` after closing both fail-open paths, `npm test` (4,558 pass / 0 fail),
> and a sandbox (`cjnewpxxmiucwirlcqpj`) count of `role_permissions` per role. First pass, same
> day, against `src/api/routes/{attendance,leaves,files,working-hour-entries,cash-flow,stock-value,forecasts,sessions}.ts`,
> `src/api/lib/{rbac,nav-permissions}.ts`, `src/dashboard-routes.tsx`. Every claim below was
> read out of the source or measured on that date, not inferred from a plan or a migration.
> Production state is UNMEASURED throughout.

## The problem in one paragraph

Being logged in is currently enough to read most of the ERP. Role only decides what appears
in the sidebar; it does not decide what the API answers. Type the address and the page loads
and the data arrives. Two calls look almost identical in a diff and do different jobs —
`getOrgId(c)` answers *which company's data*, `requirePermission(c, …)` answers *is this
person allowed*. Handlers that mutate got the second one. Handlers that only read usually
did not.

Audit of 2026-09-11 (`audit-rbac.mjs`, repo root): **1,012 handlers — 817 gated, 60
deliberately public, 135 with no gate (9 write, 126 read).**

## Two fail-open paths — CLOSED 2026-09-14 (uncommitted)

`src/api/lib/rbac.ts` used to grant `*:read` in two places:

| Was | Effect | Now |
|---|---|---|
| `if (set.size === 0) { set.add("*:read"); }` in `loadRolePermissions` | An unrecognised role text got read-everything. | Empty set → **deny-all**, with a warn log naming the role. |
| `LEGACY_ROLE_DEFAULTS[role] ?? ["*:read"]` in the `requirePermission` catch | A thrown permission lookup got read-everything. | `?? []` → **deny**, unless the role has an explicit legacy default (only `READ_ONLY` does). |

Two related changes in the same batch:

- **A failed `role_permissions` JOIN now throws instead of returning a set.** Returning one
  let `getRolePermissions` cache it in KV for 300 s, so one transient DB error became five
  minutes of wrong answers. Throwing costs one refused request.
- **`GET /api/auth/me/permissions` error fallback** returned `*:read` for every role, so the
  menu advertised pages the gate now refuses. It now returns `*:read` only for an explicit
  `READ_ONLY` role, and `[]` otherwise. `hasPermission()` already failed closed.

Who this can lock out: a DB-defined role (FINANCE, PROCUREMENT, PRODUCTION, WAREHOUSE,
WORKER) with **zero** rows in `role_permissions`. **Sandbox, measured 2026-09-14:** every role
has a `roles` row and grants (FINANCE 53, PROCUREMENT 53, PRODUCTION 46, WAREHOUSE 44,
WORKER 12, READ_ONLY 73), and the gate's own JOIN returns them. **Production: UNMEASURED** —
run the same count against prod before deploying:

```sql
SELECT upper(r.name) AS role, count(rp.role_id) AS grants
FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
GROUP BY 1 ORDER BY 1;
```

Any role with users and 0 grants will be refused everything after deploy.

Tests: `tests/rbac-fail-closed.test.mjs` (behavioural + source guards). Three existing tests
reached their gates only through the fallback and now pass an env object instead:
`attendance-list-no-photo-blobs`, `leaves-read-permission`, `consignment-tenant-scope`.

## What is already done (2026-09-14, commit `e355cdfe`, not pushed)

| File | State |
|---|---|
| `src/api/routes/attendance.ts` | All 4 handlers gated. `GET /` and `GET /:id/photo` → `attendance:read`. |
| `src/api/routes/leaves.ts` | All 6 handlers gated. `GET /` and `GET /balances` → `leaves:read`. |
| `src/dashboard-routes.tsx` | Central guard at L566 — `DASHBOARD_ROUTE_ELEMENTS` wraps every route whose path resolves through `resourceForNav`. |
| `tests/attendance-list-no-photo-blobs.test.mjs` | `c.set('userRole', 'HR')` added to the `call()` helper so the existing test still reaches the handler. |

Verified live in a local session: QA receives 403 with
`{ missingPermission: 'attendance:read', role: 'QA' }`.

## Still open — read out of the source, not assumed

**Nav map gaps** — `src/api/lib/nav-permissions.ts` holds `/settings/organisations` and
`/settings`. It has **no `/settings/users`** (so user management inherits the `settings`
permission) and **no `/admin/health`** (which needs a SUPER_ADMIN-only resource, and that
resource must then be added to OFFICE's `allExcept` exclusion list or OFFICE gets it free).

**Ungated handlers, by file**

| File | Open |
|---|---|
| `files.ts` | `GET /`, `GET /:id`, `GET /:id/download`, `GET /:id/stream`, `PATCH /:id/cover` |
| `working-hour-entries.ts` | `GET /summary`, `GET /dept-category-summary`, `GET /daily-breakdown`, `GET /` |
| `cash-flow.ts` | `GET /` |
| `stock-value.ts` | `GET /`, `GET /:id` |
| `forecasts.ts` | `GET /` |
| ~110 others | see `audit-rbac.mjs` output |

## Three findings that change the obvious plan

**1. `files.ts` is not a one-line fix.** Upload is gated on `files:create`, delete on
`files:delete`, and reads are open. Adding `requirePermission(c, "files", "read")` would
change nothing, because every code-defined role already holds `files: create+read` from the
`EVERYONE` base in `role-policy.ts`. A file has to inherit the gate of the thing it is
attached to — a customer PO checks `customers:read`, a QC photo checks `qc:read` — which
means mapping `resourceType` to a resource and choosing a default for anything unmapped.
Recommend deny. Note also that `GET /:id/download` issues a **presigned Supabase URL valid
for 300 seconds**, so once the link exists the object is outside the permission system
entirely.

**2. `sessions.ts` is not a hole — do not "fix" it.** `audit-rbac.mjs` flags `GET /` and
`DELETE /:id` as ungated. Reading them: both bind every query to `ctxUserId(c)`
(`WHERE id = ? AND userId = ?`) and the delete emits an audit row with `scope: "self"`.
Self-scoped is the correct model for session management; a permission gate would be wrong
here. Scanner limitation, confirmed by hand.

**3. `working-hour-entries.ts` has already chosen its resource.** Every write in that file
gates on `attendance:create` / `update` / `delete`, and `GET /nonprod-requests` on
`attendance:read`. The four open GETs are an omission, not an undecided design.
`GET /production-revenue` is the one exception and uses `revenue-figures:read`.

**4. A tenth ungated write, missing from the 09-11 audit.** `PATCH /api/files/:id/cover`
has no permission check and runs `ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS
sort_order INTEGER` **on every request** — any logged-in account of any role can trigger
DDL on a request path. Gate it with the rest of `files.ts` and move the ALTER into a
migration.

## The loop — run once per batch, never skip step 3 or 6

1. Pick a batch — one resource group, not one endpoint.
2. Add `requirePermission(c, resource, "read")` as the handler's **first** line, above `getOrgId`.
3. Write the denial test — a role without the grant gets **403** and a `missingPermission`
   body. **Asserting "no rows came back" is not a test.** This system has four separate
   confirmed cases of a failure reporting success, the most recent being `/api/attendance`
   answering `{success: true, data: [], total: 0}` with the database unreachable. An
   emptiness assertion passes against a working gate, a broken gate and a dead connection
   alike.
4. `npm test` locally, against the seeded sandbox.
5. `node audit-rbac.mjs` — the ungated count must drop by exactly the number gated.
6. Log in as each affected role and type the URL directly. Confirm the refusal in the
   browser, not only in test output.
7. Commit — one commit per batch, resource named in the message.
8. Optional staging check (real data, read-only, confirmation only), then push to
   `zaim-dev-branch`.

## Order of work

0. ~~Commit what is already verified~~ (`e355cdfe`) → ~~`.dev.vars` to the sandbox~~ (owner
   confirmed 2026-09-14) → seed the sandbox → ~~close the two fail-opens in `rbac.ts`~~
   (2026-09-14; **run the prod grant count above before deploying**) → fill the two nav-map gaps.
1. `files.ts` — needs the `resourceType` design first.
2. `working-hour-entries.ts` ×4, `rd-projects/:id/labour-hours`.
3. `cash-flow`, `stock-value` ×2, `forecasts`, `purchase-invoices` ×2.
4. Pricing, `customers`, `suppliers`, `supplier-materials`.
5. `dashboard-overview`, `organisations`, `departments`, `kv-config/:key`.
6. Operational bulk (BOM, production orders, QC, scheduling, warehouse, 3PL) + the
   remaining ungated writes.
7. Wire `audit-rbac.mjs` into CI the way `.github/workflows/secret-hygiene.yml` is wired,
   so a new ungated read endpoint surfaces the day it lands.

## Structural problems that survive every gate above

- **OFFICE is defined by exclusion.** `allExcept([...])` in `role-policy.ts` grants
  everything not on a list, so every resource added to the system from now on is granted to
  OFFICE by default on the day it is created. An allow-list inverts that. Needs sign-off —
  flipping it will refuse things OFFICE staff can do today.
- **Three places define permissions.** Five roles in `role-policy.ts`, six in the
  `role_permissions` table, and `SUPER_ADMIN` / `ADMIN` short-circuit to `*:*` at
  `rbac.ts:210` before either runs.

## Unaudited, and the largest unknown in the system

`POST /api/assistant/chat` has no entry gate. It is role-aware — it reads `userRole` and
computes `isSuperAdminRole` — but whether its tools enforce per-resource permissions is
unknown. With tool access plus a mail-inbound worker reading real customer email, it is a
prompt-injection surface as well as an RBAC one. It needs its own audit; it is not a row in
the queue above. Also unread: session and token handling, `public-do-qr.ts`, and the
`assistant-history` write paths.

## Environment rules — these are not negotiable

- **Sandbox for development.** Supabase `cjnewpxxmiucwirlcqpj`. Staging
  (`zaxygxwadidiqcphibma`) is a production clone and is for read-only confirmation only,
  never the surface a fix is developed against. Production (`vpwdqtsxexpiqxzweivd`) is never
  written to from this work.
- **Say which environment** any command or query touches, every time, before running it.
- **Fixes are finished and verified locally first.** Pushing is never a way to get something
  testable.
- **Never print a credential** — not into the terminal, not into a commit, not into a chat.
  `.dev.vars` is read by the runtime and by nothing else.
