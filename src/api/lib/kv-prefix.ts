// Prod and preview/staging deploys share ONE SESSION_CACHE namespace
// (wrangler.toml binds it at the top level, like Hyperdrive), and cache keys
// carry no environment — `dashboard:overview:hookka:v23:…`, `perm:<role>`,
// `pos:version:<org>` are identical on both. Without a prefix, staging reads
// prod's cached numbers and, worse, writes staging data into prod's cache.
// worker.ts wraps the binding with this for every preview-host request.
export function prefixedKv(kv: KVNamespace, prefix: string): KVNamespace {
  const keyed = new Set(["get", "getWithMetadata", "put", "delete"]);
  return new Proxy(kv, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== "function") return v;
      if (keyed.has(prop as string)) {
        return (key: string, ...rest: unknown[]) => v.call(target, prefix + key, ...rest);
      }
      if (prop === "list") {
        return (opts?: KVNamespaceListOptions) =>
          v.call(target, { ...opts, prefix: prefix + (opts?.prefix ?? "") });
      }
      return v.bind(target);
    },
  });
}
