// ---------------------------------------------------------------------------
// /api/user-permissions — the Permissions tab (Settings → User Management).
//
// Owner 2026-09-30: a Super Admin sees every account's access and edits it
// PER ACCOUNT (view / create / edit / delete per module). Saving writes the
// account's own list (lib/user-permissions.ts), which the gate and the menu
// then use instead of the role's. Reset deletes it, so the account follows
// its role again.
//
// Super Admin only, every route — the same fence as account management in
// users.ts. SUPER_ADMIN / ADMIN accounts are never editable here: the gate
// short-circuits them before any list is read, so an edit would do nothing
// while looking like it did something.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin, getRolePermissions } from "../lib/rbac";
import { ALL_RESOURCES } from "../lib/role-policy";
import {
  ensureUserPermissionsTable,
  loadUserOverride,
  invalidateUserOverride,
} from "../lib/user-permissions";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

export const STANDARD_ACTIONS = ["read", "create", "update", "delete"] as const;

/**
 * Actions beyond the four, per resource — every one a real gate checks
 * (`requirePermission(c, resource, action)` in src/api). The test
 * `user-permissions-catalog.test.mjs` scans the gates and fails when a new
 * one is missing here, so the tab can never lack a right the API enforces.
 */
export const SPECIAL_ACTIONS: Record<string, string[]> = {
  "delivery-orders": ["credit-override"],
  invoices: ["post", "void"],
  "purchase-orders": ["approve", "receive"],
  "sales-orders": ["confirm", "edit"],
  "service-cases": ["approve"],
  users: ["role-change"],
};

export function catalog(): { resource: string; actions: string[] }[] {
  return [...ALL_RESOURCES].sort().map((resource) => ({
    resource,
    actions: [...STANDARD_ACTIONS, ...(SPECIAL_ACTIONS[resource] ?? [])],
  }));
}

const LOCKED_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

type UserRow = { id: string; email: string | null; displayName: string | null; role: string | null };

async function loadUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, email, displayName, role FROM users WHERE id = ?")
    .bind(id)
    .first<UserRow>();
}

app.get("/catalog", (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  return c.json({ success: true, data: catalog() });
});

// Which accounts have their own list — for the "Custom" badge in the list.
app.get("/", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  try {
    const res = await c.var.DB
      .prepare("SELECT user_id, updated_at FROM user_permissions")
      .all<{ user_id?: string; userId?: string; updated_at?: string; updatedAt?: string }>();
    const data = (res.results ?? []).map((r) => ({
      userId: r.userId ?? r.user_id ?? "",
      updatedAt: r.updatedAt ?? r.updated_at ?? null,
    }));
    return c.json({ success: true, data });
  } catch (err) {
    // No table yet = no account edited yet.
    if (/user_permissions/.test(String(err)) && /(does not exist|no such table|42P01)/i.test(String(err))) {
      return c.json({ success: true, data: [] });
    }
    throw err;
  }
});

// Effective access, as the gate would compute it. Wildcards are returned as
// stored ("sales-orders:*", "*:read"); the tab expands them against the catalog.
app.get("/:userId", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const user = await loadUser(c.var.DB, c.req.param("userId"));
  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  const role = (user.role ?? "").toUpperCase();
  if (LOCKED_ROLES.has(role)) {
    return c.json({ success: true, data: { userId: user.id, role, locked: true, customized: false, permissions: ["*:*"] } });
  }
  const own = await loadUserOverride(c.var.DB, user.id);
  const permissions = own ?? (await getRolePermissions(c, role));
  return c.json({
    success: true,
    data: { userId: user.id, role, locked: false, customized: !!own, permissions: [...permissions].sort() },
  });
});

app.put("/:userId", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  let body: { permissions?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  if (!Array.isArray(body.permissions)) {
    return c.json({ success: false, error: "permissions must be a list" }, 400);
  }
  // Explicit grants only: a wildcard saved here would silently grant rights
  // added to the code later, which is not what ticking boxes means.
  const allowed = new Map(catalog().map((e) => [e.resource, new Set(e.actions)]));
  const perms = new Set<string>();
  for (const p of body.permissions) {
    const [resource, action, extra] = String(p).split(":");
    if (extra !== undefined || !allowed.get(resource)?.has(action)) {
      return c.json({ success: false, error: `Unknown permission: ${String(p)}` }, 400);
    }
    perms.add(`${resource}:${action}`);
  }

  const userId = c.req.param("userId");
  const user = await loadUser(c.var.DB, userId);
  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  const role = (user.role ?? "").toUpperCase();
  if (LOCKED_ROLES.has(role)) {
    return c.json({ success: false, error: "Super Admin and Admin accounts always have full access and cannot be edited." }, 400);
  }

  await ensureUserPermissionsTable(c.var.DB);
  const before = await loadUserOverride(c.var.DB, userId);
  const list = [...perms].sort();
  const actor = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  await c.var.DB
    .prepare(
      `INSERT INTO user_permissions (user_id, permissions, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         permissions = excluded.permissions,
         updated_at  = excluded.updated_at,
         updated_by  = excluded.updated_by`,
    )
    .bind(userId, JSON.stringify(list), new Date().toISOString(), actor)
    .run();
  await invalidateUserOverride(c.env?.SESSION_CACHE, userId);
  await emitAudit(c, {
    resource: "user-permissions",
    resourceId: userId,
    action: "update",
    before: before ? [...before].sort() : { followsRole: role },
    after: list,
  });
  return c.json({ success: true, data: { userId, role, locked: false, customized: true, permissions: list } });
});

// Reset: the account follows its role again.
app.delete("/:userId", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const userId = c.req.param("userId");
  const user = await loadUser(c.var.DB, userId);
  if (!user) return c.json({ success: false, error: "User not found" }, 404);
  const before = await loadUserOverride(c.var.DB, userId);
  if (before) {
    await c.var.DB.prepare("DELETE FROM user_permissions WHERE user_id = ?").bind(userId).run();
    await invalidateUserOverride(c.env?.SESSION_CACHE, userId);
    await emitAudit(c, {
      resource: "user-permissions",
      resourceId: userId,
      action: "delete",
      before: [...before].sort(),
      after: { followsRole: (user.role ?? "").toUpperCase() },
    });
  }
  return c.json({ success: true });
});

export default app;
