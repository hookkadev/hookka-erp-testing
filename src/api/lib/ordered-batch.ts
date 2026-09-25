// ---------------------------------------------------------------------------
// ordered-batch — run a batch in the order it was given, per group.
//
// The desktop's "complete the earlier step too" sends the upstream card FIRST
// and the blocked card second, and the whole point is that the first finishes
// before the second starts: the upstream produce lands before the downstream
// consume, so no negative WIP row is created. A `Promise.all` over the list
// keeps the order of the LIST and throws away the order of EXECUTION, which
// is how the remedy for a skipped stage could itself skip a stage
// (PRD T-013 R6).
//
// Only items that share a key can depend on each other (the sequence lock is
// per production order), so groups run side by side and each group runs one
// item at a time. A 20-card batch date stamp across 20 orders is as fast as
// before; two cards on one order are now in order.
// ---------------------------------------------------------------------------

export async function runGroupedInOrder<T, R>(
  items: T[],
  keyOf: (item: T) => string,
  runOne: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const k = keyOf(item);
    const list = groups.get(k);
    if (list) list.push(i);
    else groups.set(k, [i]);
  });

  const out: R[] = new Array(items.length);
  await Promise.all(
    [...groups.values()].map(async (indexes) => {
      for (const i of indexes) {
        out[i] = await runOne(items[i], i);
      }
    }),
  );
  return out;
}
