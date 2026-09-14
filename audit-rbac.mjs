// ---------------------------------------------------------------------------
// audit-rbac.mjs — does every API endpoint actually check permissions?
//
// The role definitions, the sidebar filtering and the route guards all only
// matter if the API refuses the request. This walks every route file, finds
// every handler, and reports the ones with no permission gate in the body.
//
// It reads the real PUBLIC_PREFIXES list from lib/auth-middleware.ts, so a
// route that is deliberately public (QR scan pages, the worker portal login)
// is reported as PUBLIC rather than as a hole.
//
// Report only — reads files, writes nothing, touches no database.
//
// USAGE
//   node audit-rbac.mjs            # summary + the ungated list
//   node audit-rbac.mjs --all      # also list every gated route
//
// LIMITS, stated plainly: this is a text scan, not a type-checker. A guard
// applied through a shared helper, a router-level app.use(), or a wrapper this
// script does not recognise will be reported as ungated. Treat the output as a
// REVIEW LIST, not a verdict — every line needs a human look before it counts
// as a finding. Under-reporting is the dangerous direction, so the matcher is
// deliberately generous about what counts as a guard.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const ROOT = "src/api/routes";
const MW = "src/api/lib/auth-middleware.ts";
const ALL = process.argv.includes("--all");

// Anything that counts as "this handler checks something".
const GUARDS = [
  // secret-gated machine endpoints (cron beats, signed webhooks)
  /CRON_SECRET/, /SHEETS_SYNC_SECRET/, /constantTimeEqual\s*\(/,
  /x-cron-secret/i, /verifySignature\s*\(/, /hmac/i,
  /requirePermission\s*\(/,
  /requireSuperAdmin\s*\(/,
  /requireFinance\w*\s*\(/,
  /requireRole\s*\(/,
  /requireAuth\s*\(/,
  /assertPermission\s*\(/,
  /canAccess\s*\(/,
  /requireOrg\w*\s*\(/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// --- the deliberately-public prefixes ---------------------------------------
let publicPrefixes = [];
try {
  const mw = readFileSync(MW, "utf8");
  const block = mw.match(/PUBLIC_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/);
  if (block) publicPrefixes = [...block[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
} catch {
  console.warn("!! could not read PUBLIC_PREFIXES — public routes will show as ungated\n");
}

// --- find the end of a handler body by brace matching ------------------------
function bodyAfter(src, from) {
  let depth = 0, started = false;
  for (let i = from; i < src.length && i < from + 20000; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(from, i); }
  }
  return src.slice(from, from + 4000);
}

const files = walk(ROOT).sort();
const rows = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(".", file).replace(/\\/g, "/");
  // router-level middleware counts for every route in the file
  // Router-level middleware counts for every route in the file. Match the
  // WHOLE app.use body, not just its first line: admin-health.ts gates all 23
  // of its handlers with an inline `role !== "SUPER_ADMIN"` check, which the
  // first version of this script missed entirely.
  let fileWide = false;
  const useRe = /app\.use\s*\(/g;
  let um;
  while ((um = useRe.exec(src)) !== null) {
    const b = bodyAfter(src, um.index);
    if (/userRole|SUPER_ADMIN|require[A-Z]|forbidden|401|403/.test(b)) { fileWide = true; break; }
  }

  const re = /\bapp\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*)["'`]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, method, path] = m;
    const line = src.slice(0, m.index).split("\n").length;
    const body = bodyAfter(src, m.index);
    // A deprecated stub that answers 410 is not an endpoint.
    const deprecated = /\b410\b/.test(body) && /deprecat/i.test(src);
    const gated = fileWide || deprecated || GUARDS.some((g) => g.test(body));
    const mount = rel.replace(/^src\/api\/routes\//, "").replace(/\.ts$/, "");
    const full = ("/api/" + mount + path).replace(/\/+$/, "").replace(/\/\//g, "/");
    // Endpoints that MUST run before a session exists, by definition.
    const preAuth = /^(auth|auth-totp|auth-oauth)$/.test(mount) ||
                    /^\/(login|logout|forgot-password|reset-password|accept-invite|verify-invite)/.test(path);
    const isPublic = preAuth || publicPrefixes.some((p) => full.startsWith(p)) || /public/i.test(mount);
    rows.push({ file: rel, line, method: method.toUpperCase(), path, full, gated, isPublic,
                mutating: method !== "get" });
  }
}

const pub = rows.filter((r) => r.isPublic);
const gated = rows.filter((r) => !r.isPublic && r.gated);
const open = rows.filter((r) => !r.isPublic && !r.gated);
const openWrite = open.filter((r) => r.mutating);
const openRead = open.filter((r) => !r.mutating);

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

say("");
say("=".repeat(74));
say("RBAC ENFORCEMENT AUDIT — does the API refuse the request?");
say("=".repeat(74));
say(`  files scanned     ${files.length}`);
say(`  handlers found    ${rows.length}`);
say(`  with a guard      ${gated.length}`);
say(`  deliberately open ${pub.length}   (PUBLIC_PREFIXES, public-* files, pre-auth endpoints)`);
say(`  NO GUARD FOUND    ${open.length}   -> ${openWrite.length} write, ${openRead.length} read`);
say("");

if (openWrite.length) {
  say("-".repeat(74));
  say(`WRITE endpoints with no guard  (${openWrite.length}) — check these first`);
  say("-".repeat(74));
  for (const r of openWrite) say(`  ${r.method.padEnd(6)} ${r.full.padEnd(52)} ${r.file}:${r.line}`);
  say("");
}
if (openRead.length) {
  say("-".repeat(74));
  say(`READ endpoints with no guard  (${openRead.length})`);
  say("-".repeat(74));
  for (const r of openRead) say(`  ${r.method.padEnd(6)} ${r.full.padEnd(52)} ${r.file}:${r.line}`);
  say("");
}

// worst files first — where the gaps cluster
const byFile = {};
for (const r of open) byFile[r.file] = (byFile[r.file] || 0) + 1;
const worst = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (worst.length) {
  say("-".repeat(74));
  say("Files with the most ungated handlers");
  say("-".repeat(74));
  for (const [f, n] of worst) say(`  ${String(n).padStart(3)}  ${f}`);
  say("");
}

if (ALL) {
  say("-".repeat(74));
  say("Gated (for reference)");
  say("-".repeat(74));
  for (const r of gated) say(`  ${r.method.padEnd(6)} ${r.full}`);
  say("");
}

say("  Every line above is a REVIEW ITEM, not a confirmed hole — open the file");
say("  at the line given before calling it a finding.");
say("");
say("  NOTE: many of these are org-scoped via getOrgId() but NOT permission-");
say("  scoped. getOrgId answers \"which company\", not \"is this person allowed\".");
say("  A handler with only getOrgId is readable by every logged-in account.");
say("");

const dest = join(tmpdir(), "hookka-rbac-audit.txt");
writeFileSync(dest, out.join("\n"), "utf8");
say(`  Full report: ${dest}`);
say("");
