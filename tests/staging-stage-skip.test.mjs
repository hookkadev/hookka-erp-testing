// Staging-only "skip production stages" tool: the pure planner, plus pins that
// the card stays staging-host-only and writes through the normal bulk-patch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planCompleteUpTo, planReset } from "../src/lib/staging-stage-skip.ts";

const jc = (id, departmentCode, sequence, status = "WAITING") => ({ id, departmentCode, sequence, status });
const PO = {
  id: "po-1",
  jobCards: [
    jc("fc", "FAB_CUT", 1),
    jc("fs", "FAB_SEW", 2),
    jc("wc", "WOOD_CUT", 1),
    jc("fr", "FRAMING", 2),
    jc("up", "UPHOLSTERY", 3),
    jc("pk", "PACKING", 4),
  ],
};
const ids = (batches) => batches.map((b) => b.map((p) => p.jobCardId));

test("complete up to PACKING sends one wave per sequence, lowest first", () => {
  const b = planCompleteUpTo([PO], "PACKING", "2026-09-30");
  assert.deepEqual(ids(b), [["fc", "wc"], ["fs", "fr"], ["up"], ["pk"]]);
  assert.ok(b.flat().every((p) => p.status === "COMPLETED" && p.completedDate === "2026-09-30" && p.poId === "po-1"));
});

test("stops at the chosen stage and skips cards already settled", () => {
  const po = { id: "po-1", jobCards: [...PO.jobCards.slice(0, 5), jc("pk", "PACKING", 4)] };
  po.jobCards[0] = jc("fc", "FAB_CUT", 1, "COMPLETED");
  assert.deepEqual(ids(planCompleteUpTo([po], "FRAMING", "d")), [["wc"], ["fs", "fr"]]);
});

test("unknown stage plans nothing", () => {
  assert.deepEqual(planCompleteUpTo([PO], "NOPE", "d"), []);
});

test("waves are cut to bulk-patch's 50-patch limit", () => {
  const pos = Array.from({ length: 60 }, (_, i) => ({ id: `po-${i}`, jobCards: [jc(`c${i}`, "FAB_CUT", 1)] }));
  assert.deepEqual(planCompleteUpTo(pos, "FAB_CUT", "d").map((b) => b.length), [50, 10]);
});

test("reset clears only completed cards back to WAITING", () => {
  const po = { id: "po-1", jobCards: [jc("a", "FAB_CUT", 1, "COMPLETED"), jc("b", "FAB_SEW", 2)] };
  assert.deepEqual(planReset([po]), [[{ poId: "po-1", jobCardId: "a", completedDate: "", status: "WAITING" }]]);
});

test("card renders only on the staging host and writes through bulk-patch", () => {
  const src = readFileSync(new URL("../src/components/staging-stage-skip.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!window\.location\.hostname\.startsWith\("staging\."\)\) return null;/);
  assert.match(src, /sendWave\(patches\)/);
  assert.match(readFileSync(new URL("../src/lib/staging-stage-skip.ts", import.meta.url), "utf8"), /\/api\/production-orders\/bulk-patch/);
});

test("a PO whose only DO was cancelled can still be moved", () => {
  const src = readFileSync(new URL("../src/components/staging-stage-skip.tsx", import.meta.url), "utf8");
  assert.match(src, /!po\.deliveryDoNo \|\| po\.deliveryStatus === "CANCELLED"/);
  // ...but the server decides what a live DO holds, before any write.
  assert.ok(src.indexOf("/api/delivery-orders/linked-po-ids") < src.indexOf("sendWave(patches)"));
});

test("a card that fails in the parallel wave is retried on its own", async () => {
  const { sendWave } = await import("../src/lib/staging-stage-skip.ts");
  const patches = ["a", "b", "c"].map((id) => ({ poId: `po-${id}`, jobCardId: id, completedDate: "d", status: "COMPLETED" }));
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const f = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith("/bulk-patch")) return json(200, { results: [{ success: true }, { success: false, error: "x" }, { success: false, error: "x" }] });
    // b goes through on its own; c is a real failure and carries a ref.
    return url.endsWith("po-b") ? json(200, { success: true }) : json(500, { error: "Something went wrong", ref: "abc12345" });
  };
  assert.deepEqual(await sendWave(patches, f), { done: 2, errors: ["Something went wrong (ref abc12345)"] });
  assert.deepEqual(calls, ["POST /api/production-orders/bulk-patch", "PATCH /api/production-orders/po-b", "PATCH /api/production-orders/po-c"]);
});
