// ---------------------------------------------------------------------------
// org-people.test.mjs — the org chart's people model.
//
// Hookka has two tables of people (users: office, workers: factory floor) with
// no link between them, so a node is keyed by (source, id) and reporting lines
// live in their own table. These cases pin the two things that would quietly
// lose people off the chart: a cycle, and a manager who is not on the chart.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const org = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/org-people.ts")).href
);

const p = (key, managerKey = null, name = key) => {
  const parsed = org.parsePersonKey(key);
  return {
    key, source: parsed.source, id: parsed.id, name,
    position: "", departmentCode: "", ref: "", active: true, managerKey,
  };
};

test("keys round-trip, including a worker id that contains a dash", () => {
  assert.equal(org.personKey("worker", "worker-b311d39e"), "worker:worker-b311d39e");
  assert.deepEqual(org.parsePersonKey("worker:worker-b311d39e"), {
    source: "worker", id: "worker-b311d39e",
  });
  assert.deepEqual(org.parsePersonKey("user:42"), { source: "user", id: "42" });
});

test("a malformed key is rejected, not guessed", () => {
  for (const bad of ["", "user", "user:", ":42", "staff:1", "worker"]) {
    assert.equal(org.parsePersonKey(bad), null, bad);
  }
});

test("an edge may cross the two tables — that is the point", () => {
  const tree = org.buildOrgTree([
    p("user:1"),
    p("worker:w1", "user:1"),
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].key, "user:1");
  assert.equal(tree[0].children[0].key, "worker:w1");
});

test("a manager who is NOT on the chart re-roots their reports", () => {
  // Filtered to one department, or the manager has resigned. Their team must
  // still be visible rather than vanishing with them.
  const tree = org.buildOrgTree([p("worker:w1", "user:99")]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].key, "worker:w1");
});

test("nobody is dropped: every person appears exactly once", () => {
  const people = [
    p("user:1"), p("user:2", "user:1"),
    p("worker:a", "user:2"), p("worker:b", "user:2"), p("worker:c"),
  ];
  const seen = [];
  const walk = (n) => { seen.push(n.key); n.children.forEach(walk); };
  org.buildOrgTree(people).forEach(walk);
  assert.equal(seen.length, people.length);
  assert.equal(new Set(seen).size, people.length);
});

test("a cycle already in the data does not hang the render", () => {
  const tree = org.buildOrgTree([p("user:1", "user:2"), p("user:2", "user:1")]);
  const seen = [];
  const walk = (n) => { seen.push(n.key); n.children.forEach(walk); };
  tree.forEach(walk);
  assert.ok(seen.length <= 2, `walked ${seen.length} nodes`);
});

test("wouldCycle blocks self-management and longer loops", () => {
  const m = new Map([["user:1", null], ["user:2", "user:1"], ["user:3", "user:2"]]);
  assert.equal(org.wouldCycle("user:1", "user:1", m), true, "self");
  assert.equal(org.wouldCycle("user:1", "user:3", m), true, "1→3→2→1");
  assert.equal(org.wouldCycle("user:3", "user:1", m), false, "already the case");
  assert.equal(org.wouldCycle("user:1", null, m), false, "clearing is always safe");
});

test("subtree counts drive the collapsed-box number", () => {
  const [root] = org.buildOrgTree([
    p("user:1"), p("user:2", "user:1"), p("worker:a", "user:2"),
  ]);
  assert.equal(org.countSubtree(root), 3);
});

// ---------------------------------------------------------------------------
// Server-side subtree / upline helpers (PRD T-012 R9) — what the Mail Center
// recipient picker asks of the flat list.
// ---------------------------------------------------------------------------
test("subtreeKeys: the root and everyone under it, cycle-safe", () => {
  const people = [
    p("user:ceo"),
    p("user:mgr", "user:ceo"),
    p("user:a", "user:mgr"),
    p("worker:w1", "user:a"),
    p("user:other", "user:ceo"),
  ];
  assert.deepEqual(
    [...org.subtreeKeys(people, "user:mgr")].sort(),
    ["user:a", "user:mgr", "worker:w1"],
  );
  assert.deepEqual([...org.subtreeKeys(people, "user:a")].sort(), ["user:a", "worker:w1"]);
  // A cycle that reached the database must not hang the walk.
  const loop = [p("user:x", "user:y"), p("user:y", "user:x")];
  assert.deepEqual([...org.subtreeKeys(loop, "user:x")].sort(), ["user:x", "user:y"]);
});

test("uplineKeys: the manager chain, nearest first, self excluded", () => {
  const people = [
    p("user:ceo"),
    p("user:mgr", "user:ceo"),
    p("user:a", "user:mgr"),
  ];
  assert.deepEqual(org.uplineKeys(people, "user:a"), ["user:mgr", "user:ceo"]);
  assert.deepEqual(org.uplineKeys(people, "user:ceo"), []);
  const loop = [p("user:x", "user:y"), p("user:y", "user:x")];
  assert.deepEqual(org.uplineKeys(loop, "user:x"), ["user:y"]);
});
