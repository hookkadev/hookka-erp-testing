# RBAC Remediation — current state and the way through

> **Last verified: 2026-09-24** — rebased onto `main` (215 commits of drift, cherry-picked clean) and
> re-measured: scanner against this branch, plus the PRODUCTION grant counts quoted below. Previously against `src/api/lib/rbac.ts` (fail-opens closed) and `src/api/routes/{attendance,leaves,files,working-hour-entries,cash-flow,stock-value,forecasts,sessions}.ts`,
> `src/api/lib/{rbac,nav-permissions}.ts`, `src/dashboard-routes.tsx`. Every claim below was
> read out of the source on that date, not inferred from a plan or a migration.

## The problem in one paragraph

Being logged in is currently enough to read most of the ERP. Role only decides what appears
in the sidebar; it does not decide what the API answers. Type the address and the page loads
and the data arrives. Two calls look almost identical in a diff and do different jobs —
`getOrgId(c)` answers *which company's data*, `requirePermission(c, …)` answers *is this
person allowed*. Handlers that mutate got the second one. Handlers that only read usually
did not.

Audit of 2026-09-11 (`audit-rbac.mjs`, repo root): **1,012 handlers — 817 gated, 60
deliberately public, 135 with no gate (9 write, 126 read).**

## Two fail-open paths — CLOSED 2026-09-15 (commit 138b636d)

`src/api/lib/rbac.ts`. Both defaults used to be `["*:read"]`, which made any unrecognised
role text — and any transient failure of the permission lookup — a read-the-whole-ERP
account, and let every gate elsewhere be walked around. Verified closed by reading the file:

| Site | Now |
|---|---|
| L133 | No rows and no legacy default → warns and returns an **empty** set. Denies everything. |
| L240 | `set = new Set(LEGACY_ROLE_DEFAULTS[role] ?? [])` in the `catch`. Denies everything. |

`/me/permissions` returns `[]` for this case too, so the menu and the gate now agree. The fix
for a role that holds nothing is to seed its grants — never to widen these two lines again.

**One thing this changes that the tests cannot see.** In the sandbox no account rides the old
fallback, so the suite passes either way. On staging or production an account on an
unrecognised role text was silently getting read-everything and now gets nothing. Before this
reaches real users, run against staging:

```sql
select u.role, count(*) as accounts
from users u
where u.role not in (select name from roles)
group by u.role;
```

Any row returned is an account that will lose access the moment this deploys. That is the
correct outcome, but it should be a decision, not a surprise.

## Production blast radius — MEASURED 2026-09-24, before deploying the gates

Closing the fail-opens means a role with **zero** rows in `role_permissions` is refused everything
instead of silently reading everything. Measured on prod before merging, not assumed:

| Role | Users | Grants | After deploy |
|---|---|---|---|
| SUPER_ADMIN | 8 | 284 | unchanged (wildcard short-circuit) |
| SALES | 3 | 65 | unchanged (code policy) |
| OFFICE | 2 | 59 | unchanged (code policy, `allExcept`) |
| QA | 2 | 31 | **loses attendance + leaves** — the intent |
| R_AND_D | 2 | 49 | **loses attendance + leaves** |
| FINANCE | 1 | 53 | **loses attendance + leaves** |
| HR | 1 | 31 | unchanged — holds attendance / leaves / workers read |
| PRODUCTION | 1 | 46 | **loses attendance + leaves** |
| READ_ONLY | 1 | 8 | **loses them** — 8 explicit grants, so the legacy `*:read` never applies |
| PROCUREMENT / WAREHOUSE / WORKER | 0 / 0 / — | 53 / 44 / 12 | WORKER keeps `attendance:read` |

**No role with users has 0 grants**, so the fail-open closure locks nobody out of their own module.
What changes is cross-module reading of staff personal data — clock-in times, punch selfies, sick
leave — which every logged-in account could read by typing the URL until now.

`attendance:read` / `leaves:read` in `role_permissions` today: **HR, SUPER_ADMIN**, and WORKER
(attendance only). FINANCE holds **no** `payroll` / `payslips` / `workers` grant at all, so payroll is
not run from that role and losing attendance is not a functional regression for it.

If a role does need it back, it is one row, and the 403 body names the exact missing permission:

```sql
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE upper(r.name) = 'FINANCE' AND p.resource = 'attendance' AND p.action = 'read';
```


## What is already done (cherry-picked onto `main` as `fix/rbac-read-gates`, 2026-09-24)

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

**The route guard only covers what the nav map names.** `DASHBOARD_ROUTE_ELEMENTS` wraps a
route only when `resourceForNav(path)` resolves, and that function walks `NAV_RESOURCE` — 48
prefixes. Measured 2026-09-15: of **118 dashboard routes, 103 are guarded and 15 are not**,
because no prefix matches them:

```
/admin/health          /analytics/forecast    /dashboard-b
/delivery-test         /delivery-test/:id     /production-test
/production-test/:id   /production-test/department/:code
/production-test/fg-scan  /production-test/scan
/reports               /service-orders        /service-orders/:id
/setup-2fa             /suppliers/:id
```

`/reports` and `/service-orders` are real pages with real data. The `*-test` routes and
`/dashboard-b` look like leftovers and may simply want deleting — check before mapping them.
`/setup-2fa` is correctly unguarded: a user must reach it before holding anything.

Note also there is **no `/attendance` route** — the attendance data is fetched by the
`/employees` page, which maps to `workers`. Testing `/attendance` in the address bar renders
the app shell for a path that does not exist and proves nothing; use `/employees`.

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

## Where a role's permissions actually come from — check this before editing any grant

`rbac.ts:86` short-circuits **before** the `role_permissions` query:

```ts
const coded = permissionsForRole(role);
if (coded) return coded;
```

So there are two populations, and they behave differently:

| | Roles | Source of truth |
|---|---|---|
| Code-defined | `SALES`, `OFFICE`, `QA`, `R_AND_D`, `HR` | `role-policy.ts` — `CODE_ROLE_POLICIES` |
| Table-defined | `SUPER_ADMIN`, `ADMIN`, `FINANCE`, `PROCUREMENT`, `PRODUCTION`, `WAREHOUSE`, `WORKER`, `READ_ONLY` | `role_permissions` |

**Rows in `role_permissions` for a code-defined role are dead data — never read.** Measured in
the sandbox 2026-09-15: HR, QA, OFFICE and R_AND_D each carry 8 rows there (`mail-center` ×4,
`settings` ×4) and not one of them affects a request. Granting HR something by inserting a row
will appear to work and will do nothing. Edit `role-policy.ts` instead.

This was checked because HR's table rows contain **no** `attendance:read` and **no**
`leaves:read`, which would have meant yesterday's gates locked HR out of the two screens HR
exists to use. They do not: `role-policy.ts:359-370` gives HR `attendance: OPEN` and
`leaves: OPEN`, and the code path wins. QA has neither, which is why QA correctly receives the
403. The fix is safe. Confirm it against the seeded data rather than taking this paragraph's
word for it.

## Sandbox seed — done 2026-09-15

`scripts/seed-sandbox-rbac.sql`, applied to `cjnewpxxmiucwirlcqpj` (hookka-sandbox):

| Table | Rows |
|---|---|
| `workers` | 8 (7 active, 1 resigned) |
| `attendance_records` | 350 over 2026-07-07 → 2026-09-14 — 302 PRESENT, 33 LATE, 15 ABSENT, 88 carrying a `clockinphoto` path |
| `working_hour_entries` | 240 |
| `leaves` | 12 across ANNUAL / MEDICAL / UNPAID / EMERGENCY and all three statuses |

Every row's id is prefixed `seed-`; the script deletes its own rows before re-inserting, and
refuses to run against a database holding more than 100 attendance rows or 50 users. All
names, IC numbers, phone numbers and coordinates are invented. `clockinphoto` holds a path
only — there is no object behind it, which is enough to exercise the `GET /:id/photo` gate.

Logins were **not** seeded; password hashes belong to the app. The sandbox has SUPER_ADMIN,
FINANCE, SALES, HR and QA accounts, which covers the gates being built. Add OFFICE and
R_AND_D through the app if needed.

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

0. ~~Commit the verified fix~~ done · ~~`.dev.vars` to the sandbox~~ done ·
   ~~seed the sandbox~~ done · ~~close the two fail-opens in `rbac.ts`~~ done (138b636d) ·
   **remaining: the nav-map gaps — `/settings/users`, `/admin/health`, and the 15 dashboard
   routes with no mapping at all (see below).**
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
