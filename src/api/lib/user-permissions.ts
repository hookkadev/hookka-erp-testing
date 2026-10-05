// ---------------------------------------------------------------------------
// user-permissions.ts — an account's OWN permission list, when a Super Admin
// has set one (owner 2026-09-30: access is edited per account, not per role).
//
// One row per edited account in `user_permissions`. An account with no row is
// not edited and keeps exactly its role's set, so shipping this changes no
// one's access; only a save from the Permissions tab does.
//
// Consulted in ONE place each by the gate (rbac.ts) and the menu
// (/me/permissions), before the role lookup, so the two cannot disagree.
// SUPER_ADMIN / ADMIN short-circuit before either and are never overridden.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

type PermSet = Set<string>;

const CACHE_TTL_S = 300;
const MEMO_TTL_MS = 5000;
const _memo = new Map<string, { set: PermSet | null; expMs: number }>();

function cacheKey(userId: string): string {
  return `rbac:uperms:${userId}`;
}

let _tableReady: Promise<void> | null = null;

/** Self-apply; awaited by the WRITE paths only. The read path tolerates absence. */
export function ensureUserPermissionsTable(db: D1Database): Promise<void> {
  if (_tableReady) return _tableReady;
  _tableReady = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS user_permissions (
           user_id     TEXT PRIMARY KEY,
           permissions TEXT NOT NULL,
           updated_at  TEXT,
           updated_by  TEXT
         )`,
      )
      .run();
  })().catch((err) => {
    _tableReady = null;
    throw err;
  });
  return _tableReady;
}

export function _resetUserPermissionsForTests(): void {
  _tableReady = null;
  _memo.clear();
}

// The table does not exist until the first save. That is "no account edited
// yet", not a failure — every account then keeps its role, which is exactly
// today's behaviour. Any OTHER error is rethrown so the caller fails closed.
function isMissingTable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /user_permissions/.test(m) && /(does not exist|no such table|42P01)/i.test(m);
}

/** The account's own list, or null when the account was never edited. Throws on a DB error. */
export async function loadUserOverride(db: D1Database, userId: string): Promise<PermSet | null> {
  let row: { permissions?: string | null } | null;
  try {
    row = await db
      .prepare("SELECT permissions FROM user_permissions WHERE user_id = ?")
      .bind(userId)
      .first<{ permissions: string | null }>();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
  if (!row || row.permissions == null) return null;
  const parsed: unknown = JSON.parse(row.permissions);
  if (!Array.isArray(parsed)) throw new Error(`user_permissions row for ${userId} is not a list`);
  return new Set(parsed.map(String));
}

/** loadUserOverride behind the same 5s memo + 5 min KV cache the role sets use. */
export async function getUserOverride(c: Context<Env>, userId: string): Promise<PermSet | null> {
  const now = Date.now();
  const hit = _memo.get(userId);
  if (hit && hit.expMs > now) return hit.set ? new Set(hit.set) : null;

  const kv = c.env?.SESSION_CACHE;
  if (kv) {
    const cached = await kv.get(cacheKey(userId), { type: "json" });
    if (cached && typeof cached === "object" && "p" in (cached as object)) {
      const p = (cached as { p: string[] | null }).p;
      const set = p ? new Set(p) : null;
      _memo.set(userId, { set, expMs: now + MEMO_TTL_MS });
      return set ? new Set(set) : null;
    }
  }

  const set = await loadUserOverride(c.var.DB, userId);
  if (kv) {
    c.executionCtx.waitUntil(
      kv.put(cacheKey(userId), JSON.stringify({ p: set ? [...set] : null }), {
        expirationTtl: CACHE_TTL_S,
      }),
    );
  }
  _memo.set(userId, { set: set ? new Set(set) : null, expMs: now + MEMO_TTL_MS });
  return set;
}

/** Call after a save or reset. Other isolates see the change within MEMO_TTL_MS. */
export async function invalidateUserOverride(
  kv: KVNamespace | undefined,
  userId: string,
): Promise<void> {
  _memo.delete(userId);
  if (kv) await kv.delete(cacheKey(userId));
}
