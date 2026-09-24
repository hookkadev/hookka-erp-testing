#!/usr/bin/env node
// Copy Supabase Storage objects from one project to another, same bucket and
// same path, for an explicit list of keys. Never overwrites: a key that already
// exists in the destination is skipped.
//
// Written for the 2026-09-18 → 2026-09-24 window when production's
// SUPABASE_PROJECT_REF pointed at another project, so uploads landed there
// while their file_assets rows landed in prod. The rows' r2_key is the path;
// copying the bytes to the same path in prod makes them open again.
//
//   SRC_REF=<other ref>  SRC_KEY=<its service key> \
//   DST_REF=vpwdqtsxexpiqxzweivd  DST_KEY=<prod service key> \
//   node scripts/copy-storage-objects.mjs keys.txt            # dry run
//   node scripts/copy-storage-objects.mjs keys.txt --apply    # copy
//
// keys.txt: one r2_key per line (a CSV export of a single r2_key column works;
// the header line and surrounding quotes are ignored).

import { readFileSync } from "node:fs";

const BUCKET = "hookka-files";
const [file, flag] = process.argv.slice(2);
const apply = flag === "--apply";
const { SRC_REF, SRC_KEY, DST_REF, DST_KEY } = process.env;
if (!file || !SRC_REF || !SRC_KEY || !DST_REF || !DST_KEY) {
  console.error("usage: SRC_REF SRC_KEY DST_REF DST_KEY env vars + node copy-storage-objects.mjs <keys.txt> [--apply]");
  process.exit(1);
}
if (SRC_REF === DST_REF) {
  console.error("SRC_REF and DST_REF are the same project — nothing to copy.");
  process.exit(1);
}

const keys = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim().replace(/^"|"$/g, ""))
  .filter((l) => l && l !== "r2_key" && l !== "r2Key");

// Legacy eyJ… JWT keys go in Authorization; new sb_secret_… keys only in apikey.
const auth = (key) => ({ apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) });
// mode "authenticated/" reads, "" uploads.
const objUrl = (ref, mode, key) =>
  `https://${ref}.supabase.co/storage/v1/object/${mode}${BUCKET}/` +
  key.split("/").map(encodeURIComponent).join("/");

// Supabase answers a missing object with 400 + "not_found" in the body, not 404.
async function fetchObject(ref, secret, key) {
  const res = await fetch(objUrl(ref, "authenticated/", key), { headers: auth(secret) });
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  if (res.status === 404 || /not_found|not found/i.test(text)) return null;
  throw new Error(`${ref} GET ${res.status} ${text.slice(0, 200)}`);
}

const tally = { copied: 0, wouldCopy: 0, alreadyInDst: 0, missingInSrc: 0, failed: 0 };
console.log(`${apply ? "APPLY" : "DRY RUN"} — ${keys.length} keys, ${SRC_REF} → ${DST_REF}, bucket ${BUCKET}`);

for (const key of keys) {
  try {
    const dst = await fetchObject(DST_REF, DST_KEY, key);
    if (dst) {
      await dst.body?.cancel();
      tally.alreadyInDst++;
      continue;
    }
    const src = await fetchObject(SRC_REF, SRC_KEY, key);
    if (!src) {
      console.log(`MISSING in source: ${key}`);
      tally.missingInSrc++;
      continue;
    }
    if (!apply) {
      await src.body?.cancel();
      console.log(`would copy: ${key}`);
      tally.wouldCopy++;
      continue;
    }
    const up = await fetch(objUrl(DST_REF, "", key), {
      method: "POST",
      headers: {
        ...auth(DST_KEY),
        "Content-Type": src.headers.get("Content-Type") ?? "application/octet-stream",
        "x-upsert": "false",
      },
      body: await src.arrayBuffer(),
    });
    if (!up.ok) throw new Error(`upload ${up.status} ${(await up.text()).slice(0, 200)}`);
    console.log(`copied: ${key}`);
    tally.copied++;
  } catch (e) {
    console.log(`FAILED: ${key} — ${e.message}`);
    tally.failed++;
  }
}
console.log(tally);
process.exit(tally.failed ? 1 : 0);
