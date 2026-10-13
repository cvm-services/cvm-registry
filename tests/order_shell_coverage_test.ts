/**
 * The service worker must be able to serve every module the order app imports.
 *
 * Two ways this breaks silently, both hit during ADR-0017:
 *   1. a module is imported but missing from the worker's SHELL allow-list, so
 *      it is never cached and the app is dead offline;
 *   2. a module lives OUTSIDE the worker's scope (/order/), so no worker at all
 *      can serve it — a vendor bundle at /vendor/ looked fine online and could
 *      never work offline.
 *
 * A browser is where this fails, so assert it from the source here instead.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SITE = new URL("../site/", import.meta.url).pathname;
const ORDER_APP = SITE + "order/app.js";
const SW = SITE + "order/sw.js";

/** `const SHELL = [...]` as written in the shipped worker. */
function shellAllowList(sw: string): string[] {
  const m = sw.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("site/order/sw.js has no `const SHELL = [...]` allow-list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Relative ES module specifiers in a file. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
}

/** Resolve `spec` relative to the importing file's served URL path. */
function resolve(baseUrlPath: string, spec: string): string {
  const parts = baseUrlPath.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

Deno.test("every module the order app imports is inside the service worker's scope", async () => {
  // Scope is what the worker was REGISTERED with; /order/ is the registered
  // scope, so anything above it is unreachable by this worker, cache or not.
  const SCOPE = "/order/";
  const app = await Deno.readTextFile(ORDER_APP);

  const seen = new Set<string>();
  const queue: Array<[string, string]> = [[
    ORDER_APP.replace(SITE, "/"),
    app,
  ]];
  const modules: string[] = [];

  while (queue.length) {
    const [urlPath, src] = queue.shift()!;
    for (const spec of importsOf(src)) {
      const resolved = resolve(urlPath, spec);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      modules.push(resolved);
      // Follow the graph: a module's own imports must be in scope too.
      const disk = SITE + resolved.replace("/", "");
      try {
        queue.push([resolved, await Deno.readTextFile(disk)]);
      } catch {
        assert(false, `${urlPath} imports ${spec}, but ${disk} does not exist`);
      }
    }
  }

  assert(modules.length > 0, "expected the order app to import at least one module");
  for (const m of modules) {
    assert(
      m.startsWith(SCOPE),
      `${m} is outside the worker scope ${SCOPE} — no worker can serve it offline. ` +
        `Move it under ${SCOPE} or abandon the offline claim for it.`,
    );
  }
});

Deno.test("every module the order app imports is cached by the worker shell", async () => {
  const sw = await Deno.readTextFile(SW);
  const listed = new Set(shellAllowList(sw));
  const app = await Deno.readTextFile(ORDER_APP);

  const modules = new Set<string>();
  for (const spec of importsOf(app)) {
    modules.add(resolve("/order/app.js", spec));
  }
  // One level deeper, so a module's own imports are covered too.
  for (const m of [...modules]) {
    try {
      const src = await Deno.readTextFile(SITE + m.replace("/", ""));
      for (const spec of importsOf(src)) modules.add(resolve(m, spec));
    } catch { /* existence is the other test's job */ }
  }

  const missing = [...modules].filter((m) => !listed.has(m));
  assertEquals(
    missing,
    [],
    `these modules load over the network only and are NOT in the worker shell: ${missing.join(", ")}`,
  );
});
