// ---------------------------------------------------------------------------
// D1-backed Master BOM Templates.
//
// GET    /api/bom-master-templates              -> all templates
// GET    /api/bom-master-templates/:id          -> one
// PUT    /api/bom-master-templates/:id          -> upsert one (body is the
//                                                  whole MasterTemplate)
// DELETE /api/bom-master-templates/:id          -> delete one
// PUT    /api/bom-master-templates              -> bulk replace
//                                                  (body: { templates: [...] })
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { emitAudit } from "../lib/audit";
import { requirePermission } from "../lib/rbac";
import { memoizeSelfApply, runSelfApply } from "../lib/self-apply";

const app = new Hono<Env>();

// ACCESSORY was added to the BOM page later; this route and migration 0006's
// CHECK still only allowed BEDFRAME/SOFA, so every Accessory master template
// save was rejected with a 400.
type Category = "BEDFRAME" | "SOFA" | "ACCESSORY";
const CATEGORIES: readonly string[] = ["BEDFRAME", "SOFA", "ACCESSORY"];
export const isCategory = (v: unknown): v is Category =>
  typeof v === "string" && CATEGORIES.includes(v);

// Widen the category CHECK at runtime (migrations do not replay on deploy;
// migration 0239 is the record). Postgres has no ADD CONSTRAINT IF NOT EXISTS,
// so drop + re-add, same as outbox_emails_status_check in lib/email-outbox.ts.
// The new set is a superset of every category already stored.
let categoryCheckEnsured: Promise<void> | null = null;
function ensureCategoryCheck(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => categoryCheckEnsured,
    (p) => (categoryCheckEnsured = p),
    () =>
      runSelfApply(db, "bom-master-templates", [
        "ALTER TABLE bom_master_templates DROP CONSTRAINT IF EXISTS bom_master_templates_category_check",
        "ALTER TABLE bom_master_templates ADD CONSTRAINT bom_master_templates_category_check CHECK (category IN ('BEDFRAME','SOFA','ACCESSORY'))",
      ]),
  );
}

type Row = {
  id: string;
  category: Category;
  label: string;
  moduleKey: string | null;
  isDefault: number;
  data: string;
  updatedAt: string;
};

type TemplateBody = {
  id?: string;
  category: Category;
  label?: string;
  moduleKey?: string | null;
  isDefault?: boolean;
  l1Processes?: unknown[];
  l1Materials?: unknown[];
  wipItems?: unknown[];
  updatedAt?: string;
};

function rowToTemplate(r: Row) {
  let body: { l1Processes?: unknown[]; l1Materials?: unknown[]; wipItems?: unknown[] } = {};
  try {
    body = JSON.parse(r.data);
  } catch {
    // malformed — return empty body so the UI still renders the template
    body = {};
  }
  return {
    id: r.id,
    category: r.category,
    label: r.label,
    moduleKey: r.moduleKey ?? undefined,
    isDefault: r.isDefault === 1,
    l1Processes: body.l1Processes ?? [],
    l1Materials: body.l1Materials ?? [],
    wipItems: body.wipItems ?? [],
    updatedAt: r.updatedAt,
  };
}

function templateToRow(t: TemplateBody, id: string): Row {
  const {
    l1Processes = [],
    l1Materials = [],
    wipItems = [],
  } = t;
  return {
    id,
    category: t.category,
    label: t.label || "Untitled",
    moduleKey: t.moduleKey && typeof t.moduleKey === "string" ? t.moduleKey : null,
    isDefault: t.isDefault ? 1 : 0,
    data: JSON.stringify({ l1Processes, l1Materials, wipItems }),
    updatedAt: t.updatedAt || new Date().toISOString(),
  };
}

// GET /api/bom-master-templates
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM bom_master_templates ORDER BY category, isDefault DESC, label ASC",
  ).all<Row>();
  const data = (res.results ?? []).map(rowToTemplate);
  return c.json({ success: true, data, total: data.length });
});

// GET /api/bom-master-templates/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM bom_master_templates WHERE id = ?",
  )
    .bind(id)
    .first<Row>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, data: rowToTemplate(row) });
});

// PUT /api/bom-master-templates/:id — upsert
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "bom-master-templates", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  let body: TemplateBody;
  try {
    body = (await c.req.json()) as TemplateBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!isCategory(body.category)) {
    return c.json(
      { success: false, error: "category must be BEDFRAME, SOFA or ACCESSORY" },
      400,
    );
  }
  await ensureCategoryCheck(c.var.DB);

  // Snapshot the prior state to detect the publish transition (isDefault
  // flipping 0 → 1). The schema has no draft/published flag — `isDefault`
  // is the closest thing to a "this is the active template for the
  // category" switch, so that's what we treat as publish.
  const prior = await c.var.DB.prepare(
    "SELECT * FROM bom_master_templates WHERE id = ?",
  )
    .bind(id)
    .first<Row>();

  const row = templateToRow(body, id);

  // If this one is flagged default, clear any other default in the same cat.
  if (row.isDefault === 1) {
    await c.var.DB.prepare(
      "UPDATE bom_master_templates SET isDefault = 0 WHERE category = ? AND id != ?",
    )
      .bind(row.category, id)
      .run();
  }

  await c.var.DB.prepare(
    `INSERT INTO bom_master_templates (id, category, label, moduleKey, isDefault, data, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category,
       label = excluded.label,
       moduleKey = excluded.moduleKey,
       isDefault = excluded.isDefault,
       data = excluded.data,
       updatedAt = excluded.updatedAt`,
  )
    .bind(
      row.id,
      row.category,
      row.label,
      row.moduleKey,
      row.isDefault,
      row.data,
      row.updatedAt,
    )
    .run();

  // Audit emit (P3.4) — only on the publish transition (isDefault flipping
  // off → on, including first-time create-as-default). Plain edits to a
  // template body don't fire here; they're not a security-relevant action.
  const wasDefault = prior?.isDefault === 1;
  if (row.isDefault === 1 && !wasDefault) {
    await emitAudit(c, {
      resource: "bom-master-templates",
      resourceId: id,
      action: "publish",
      before: prior ? rowToTemplate(prior) : null,
      after: rowToTemplate(row),
    });
  }

  return c.json({ success: true, data: rowToTemplate(row) });
});

// DELETE /api/bom-master-templates/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "bom-master-templates", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  await c.var.DB.prepare("DELETE FROM bom_master_templates WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

// PUT /api/bom-master-templates — bulk replace (used by migrate-from-localStorage)
app.put("/", async (c) => {
  const denied = await requirePermission(c, "bom-master-templates", "update");
  if (denied) return denied;
  let body: { templates?: TemplateBody[]; replaceAll?: boolean };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const templates = Array.isArray(body.templates) ? body.templates : [];
  if (templates.length === 0) {
    return c.json({ success: true, data: [], total: 0 });
  }

  await ensureCategoryCheck(c.var.DB);
  const statements = [];
  if (body.replaceAll) {
    statements.push(c.var.DB.prepare("DELETE FROM bom_master_templates"));
  }
  for (const t of templates) {
    if (!isCategory(t.category)) continue;
    const id = t.id || `tpl-${crypto.randomUUID().slice(0, 8)}`;
    const row = templateToRow(t, id);
    statements.push(
      c.var.DB.prepare(
        `INSERT INTO bom_master_templates (id, category, label, moduleKey, isDefault, data, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category,
           label = excluded.label,
           moduleKey = excluded.moduleKey,
           isDefault = excluded.isDefault,
           data = excluded.data,
           updatedAt = excluded.updatedAt`,
      ).bind(
        row.id,
        row.category,
        row.label,
        row.moduleKey,
        row.isDefault,
        row.data,
        row.updatedAt,
      ),
    );
  }
  await c.var.DB.batch(statements);

  const res = await c.var.DB.prepare(
    "SELECT * FROM bom_master_templates ORDER BY category, isDefault DESC, label ASC",
  ).all<Row>();
  const data = (res.results ?? []).map(rowToTemplate);
  return c.json({ success: true, data, total: data.length });
});

export default app;
