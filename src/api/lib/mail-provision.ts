// ---------------------------------------------------------------------------
// Mail Center — personal mailbox provisioning (PRD T-012 R5).
//
// Until now an @hookka.com alias was created BY HAND in the Users settings
// dialog, so a new person had no mailbox until an administrator remembered.
// This module gives every account its address the moment it exists:
//
//   POST /api/users          (create)          → provisionPersonalMailbox
//   POST /api/users/invite   (invite)          → preProvisionInviteMailbox
//   POST /api/auth/accept-invite               → provisionPersonalMailbox
//
// Catch-all routing means mail to the new address arrives immediately; the
// email_addresses row is what maps it to the person in the Mail Center.
//
// Every entry point is best-effort: a provisioning hiccup must never fail
// account creation. Callers wrap the await in try/catch and log.
// ---------------------------------------------------------------------------
import { MAIL_DOMAIN } from "./mail-threading";
import { ensureMailSchema } from "../routes/mail-center";

// A pre-provisioned invite row is tagged this way in created_by so the
// accept step can find and link it even if the person changed their display
// name on the accept form (which would change the DERIVED address).
export function inviteMarker(email: string): string {
  return `invite:${email.trim().toLowerCase()}`;
}

/** Strip accents, keep [a-z0-9], so "Wei Siāng" → "wei.siang". */
function slugPart(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The default personal address for a person: `first.last@hookka.com`.
 *
 * - A login email already on the company domain IS the mailbox.
 * - Otherwise the display name becomes first.last (every word joined with a
 *   dot, so "Lim Wei Siang" → lim.wei.siang); a one-word name is used as-is.
 * - With no usable name, the login email's local part is used.
 * Returns "" when nothing usable is available (the caller then skips).
 */
export function derivePersonalAddress(
  displayName: string | null | undefined,
  email: string | null | undefined,
  domain: string = MAIL_DOMAIN,
): string {
  const login = String(email ?? "").trim().toLowerCase();
  if (login.endsWith(`@${domain}`)) return login;

  const words = String(displayName ?? "")
    .split(/\s+/)
    .map(slugPart)
    .filter(Boolean);
  let local = words.join(".");
  if (!local) local = slugPart(login.split("@")[0] ?? "");
  if (!local) return "";
  return `${local}@${domain}`;
}

/** `first.last2@` for the second person of the same name, etc. */
export function nthAddress(address: string, n: number): string {
  if (n <= 1) return address;
  const at = address.indexOf("@");
  return `${address.slice(0, at)}${n}${address.slice(at)}`;
}

type AddressRow = {
  id: string;
  address: string;
  assignedUserId?: string | null;
  assigned_user_id?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
};

export type ProvisionArgs = {
  orgId: string;
  userId: string;
  email: string;
  displayName?: string | null;
  department?: string | null;
  position?: string | null;
  /** The acting admin's user id (null on self-service accept-invite). */
  createdBy?: string | null;
};

export type ProvisionResult =
  | { address: string; status: "existing" | "linked" | "created" }
  | null;

/**
 * Ensure `userId` owns a personal mailbox. Idempotent:
 *   1. already has an assigned address → returned untouched;
 *   2. an unassigned row exists for the derived address, or one was
 *      pre-provisioned for this invite email → linked to the user;
 *   3. otherwise a fresh row is inserted (first.last2@ … when the name is
 *      already taken by someone else).
 */
export async function provisionPersonalMailbox(
  db: D1Database,
  args: ProvisionArgs,
): Promise<ProvisionResult> {
  const { orgId, userId } = args;
  const name = (args.displayName ?? "").trim();
  const now = new Date().toISOString();
  // A brand-new environment may create its first user before any Mail
  // Center route has run — the tables are runtime-created there.
  await ensureMailSchema(db);

  // 1. Already provisioned (or hand-assigned by an admin) — nothing to do.
  const owned = await db
    .prepare(
      `SELECT id, address FROM email_addresses
        WHERE org_id = ? AND assigned_user_id = ? LIMIT 1`,
    )
    .bind(orgId, userId)
    .first<AddressRow>();
  if (owned?.address) return { address: owned.address, status: "existing" };

  // 2a. A row pre-provisioned at invite time for this login email.
  const marker = inviteMarker(args.email);
  const invited = await db
    .prepare(
      `SELECT id, address FROM email_addresses
        WHERE org_id = ? AND assigned_user_id IS NULL AND created_by = ? LIMIT 1`,
    )
    .bind(orgId, marker)
    .first<AddressRow>();
  if (invited?.id) {
    await linkRow(db, orgId, invited.id, args, now);
    return { address: invited.address, status: "linked" };
  }

  const base = derivePersonalAddress(name, args.email);
  if (!base) return null;

  // 2b / 3. Walk first.last@, first.last2@, … until we find an unassigned row
  // to link or a free address to insert.
  for (let n = 1; n <= 20; n++) {
    const address = nthAddress(base, n);
    const existing = await db
      .prepare(
        `SELECT id, address, assigned_user_id FROM email_addresses
          WHERE org_id = ? AND lower(address) = ? LIMIT 1`,
      )
      .bind(orgId, address)
      .first<AddressRow>();
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO email_addresses
             (id, org_id, address, label, assigned_user_id, assigned_user_name,
              assigned_dept, assigned_position, active, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orgId,
          address,
          name || null,
          userId,
          name || args.email,
          (args.department ?? "").trim() || null,
          (args.position ?? "").trim() || null,
          now,
          args.createdBy ?? "system:provision",
        )
        .run();
      return { address, status: "created" };
    }
    const owner = existing.assignedUserId ?? existing.assigned_user_id ?? null;
    if (!owner) {
      await linkRow(db, orgId, existing.id, args, now);
      return { address: existing.address, status: "linked" };
    }
    // Taken by someone else — try the next suffix.
  }
  return null;
}

async function linkRow(
  db: D1Database,
  orgId: string,
  rowId: string,
  args: ProvisionArgs,
  now: string,
): Promise<void> {
  const name = (args.displayName ?? "").trim();
  await db
    .prepare(
      `UPDATE email_addresses
          SET assigned_user_id = ?,
              assigned_user_name = ?,
              assigned_dept = COALESCE(assigned_dept, ?),
              assigned_position = COALESCE(assigned_position, ?),
              label = COALESCE(label, ?),
              active = 1,
              created_at = COALESCE(created_at, ?)
        WHERE org_id = ? AND id = ?`,
    )
    .bind(
      args.userId,
      name || args.email,
      (args.department ?? "").trim() || null,
      (args.position ?? "").trim() || null,
      name || null,
      now,
      orgId,
      rowId,
    )
    .run();
}

/**
 * Reserve the personal address when an invite is SENT, so mail addressed to
 * the newcomer is captured under their name before they accept. The row is
 * unassigned and tagged with the invite marker; accept-invite links it.
 * Skipped when the derived address already exists (someone else's, or a
 * previous invite to the same person).
 */
export async function preProvisionInviteMailbox(
  db: D1Database,
  args: {
    orgId: string;
    email: string;
    displayName?: string | null;
    createdBy?: string | null;
  },
): Promise<string | null> {
  const address = derivePersonalAddress(args.displayName, args.email);
  if (!address) return null;
  await ensureMailSchema(db);
  const existing = await db
    .prepare(
      `SELECT id FROM email_addresses WHERE org_id = ? AND lower(address) = ? LIMIT 1`,
    )
    .bind(args.orgId, address)
    .first<{ id: string }>();
  if (existing) return null;
  const name = (args.displayName ?? "").trim();
  await db
    .prepare(
      `INSERT INTO email_addresses
         (id, org_id, address, label, assigned_user_id, assigned_user_name,
          active, created_at, created_by)
       VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.orgId,
      address,
      name || null,
      name || args.email,
      new Date().toISOString(),
      inviteMarker(args.email),
    )
    .run();
  return address;
}
