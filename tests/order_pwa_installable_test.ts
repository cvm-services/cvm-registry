// tests/order_pwa_installable_test.ts
//
// The order client at /order/ is only *installable* if four things are true at
// once, and each of them fails silently in a browser:
//
//   1. a web app manifest with start_url AND scope exactly "/order/" (a "/"
//      scope would hijack /console/ and the rest of the origin),
//   2. genuinely raster PNG icons whose declared `sizes` match the real pixels
//      (an .svg reference, a missing file or a wrong size = no install prompt),
//   3. a service worker that caches the app shell for offline but NEVER touches
//      /api/** — order and payment state (invoice bolt11, order status) must
//      never be served stale,
//   4. the page linking the manifest and registering the worker, guarded so a
//      registration failure cannot break the ordering UI.
//
// The service worker is not asserted by grepping alone: the shipped source is
// evaluated against an in-memory CacheStorage / fetch double, so the /api/**
// refusal and the offline shell are *observed*, not assumed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ORDER_DIR = "site/order";
const INDEX_PATH = `${ORDER_DIR}/index.html`;
const MANIFEST_PATH = `${ORDER_DIR}/manifest.webmanifest`;
const SW_PATH = `${ORDER_DIR}/sw.js`;
const CONSOLE_INDEX_PATH = "site/console/index.html";
const ORIGIN = "https://cvm-pwa.orangesync.tech";

function read(path: string): string {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    throw new Error(`missing file: ${path}`);
  }
}

function readBytes(path: string): Uint8Array {
  try {
    return Deno.readFileSync(path);
  } catch {
    throw new Error(`missing file: ${path}`);
  }
}

function manifest(): Record<string, unknown> {
  const raw = read(MANIFEST_PATH);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- PNG plumbing

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Proves the bytes are a real PNG and returns the IHDR dimensions. */
function pngSize(bytes: Uint8Array, label: string): { width: number; height: number } {
  assertEquals(
    Array.from(bytes.slice(0, 8)),
    PNG_MAGIC,
    `${label} is not a PNG (bad magic bytes) — the Android install prompt needs real raster PNGs`,
  );
  assertEquals(
    String.fromCharCode(...bytes.slice(12, 16)),
    "IHDR",
    `${label}: first PNG chunk is not IHDR`,
  );
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** "/order/icon-192.png" -> "site/order/icon-192.png", refusing anything outside the scope. */
function iconDiskPath(src: string): string {
  assert(
    src.startsWith("/order/"),
    `icon src ${src} must be an absolute /order/ path (scope is /order/)`,
  );
  assert(
    !src.toLowerCase().endsWith(".svg"),
    `icon src ${src} is an SVG — the Android install prompt requires raster PNG icons`,
  );
  return `${ORDER_DIR}/${src.slice("/order/".length)}`;
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

// ------------------------------------------------------- service worker double

type Handler = (event: unknown) => void;

interface FakeRequestLike {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
  clone(): FakeRequestLike;
}

function fakeRequest(
  url: string,
  init: { mode?: string; method?: string; headers?: Record<string, string> } = {},
): FakeRequestLike {
  const opts = { mode: init.mode ?? "cors", method: init.method ?? "GET", headers: init.headers ?? {} };
  return {
    url,
    method: opts.method,
    mode: opts.mode,
    headers: new Headers(opts.headers),
    clone() {
      return fakeRequest(url, opts);
    },
  };
}

interface SwHarness {
  /** every URL the worker asked the network for, in order */
  fetched: string[];
  /** cache-name -> (request-url -> body text) */
  caches: Map<string, Map<string, string>>;
  setOffline(offline: boolean): void;
  install(): Promise<void>;
  activate(): Promise<void>;
  fetch(url: string, init?: { mode?: string; method?: string; headers?: Record<string, string> }): Promise<Response | null>;
}

/**
 * Evaluate the SHIPPED site/order/sw.js in a fresh scope with an in-memory
 * CacheStorage and a controllable fetch. Returns handles to drive it.
 *
 * `files` is the fake origin's content map (pathname -> body).
 */
function bootSw(files: Record<string, string>, seedCaches: string[] = []): SwHarness {
  const stores = new Map<string, Map<string, string>>();
  for (const name of seedCaches) stores.set(name, new Map());
  const fetched: string[] = [];
  let offline = false;

  const absolute = (input: unknown): string => {
    if (typeof input === "string") return new URL(input, `${ORIGIN}/`).href;
    if (input instanceof URL) return input.href;
    const url = (input as { url: string }).url;
    return url;
  };

  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = absolute(input);
    fetched.push(url);
    if (offline) throw new TypeError("Failed to fetch (offline)");
    const path = new URL(url).pathname;
    const body = files[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    const type = path.endsWith(".png")
      ? "image/png"
      : path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".webmanifest")
      ? "application/manifest+json"
      : "text/html";
    return new Response(body, { status: 200, headers: { "content-type": type } });
  };

  const keyOf = (input: unknown): string => {
    if (typeof input === "string") return new URL(input, `${ORIGIN}/`).href;
    if (input instanceof URL) return input.href;
    return (input as { url: string }).url;
  };

  const cacheApi = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name) as Map<string, string>;
      return {
        add: async (req: unknown) => {
          const res = await fetchImpl(req);
          store.set(keyOf(req), await res.text());
        },
        put: async (req: unknown, res: Response) => {
          store.set(keyOf(req), await res.text());
        },
        match: async (req: unknown) => {
          const hit = store.get(keyOf(req));
          return hit === undefined ? undefined : new Response(hit, { status: 200 });
        },
        keys: async () => [...store.keys()],
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    has: async (name: string) => stores.has(name),
    match: async (req: unknown) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(req));
        if (hit !== undefined) return new Response(hit, { status: 200 });
      }
      return undefined;
    },
  };

  const handlers: Record<string, Handler> = {};
  const selfMock = {
    location: new URL(`${ORIGIN}/order/sw.js`),
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const factory = new Function(
    "self",
    "caches",
    "fetch",
    "console",
    read(SW_PATH),
  ) as (...args: unknown[]) => void;
  factory(selfMock, cacheApi, fetchImpl, { warn() {}, log() {}, error() {}, info() {} });

  const runLifecycle = async (type: string): Promise<void> => {
    assert(typeof handlers[type] === "function", `sw.js has no "${type}" listener`);
    const pending: Promise<unknown>[] = [];
    handlers[type]({ waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    await Promise.all(pending);
  };

  return {
    fetched,
    caches: stores,
    setOffline(v: boolean) {
      offline = v;
    },
    install: () => runLifecycle("install"),
    activate: () => runLifecycle("activate"),
    async fetch(url, init) {
      assert(typeof handlers["fetch"] === "function", `sw.js has no "fetch" listener`);
      const request = fakeRequest(url, init);
      const pending: Promise<unknown>[] = [];
      let responded: Promise<Response> | undefined;
      handlers["fetch"]({
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
      });
      await Promise.all(pending);
      return responded ? await responded : null;
    },
  };
}

/** The `const SHELL = [...]` allow-list, as written in the shipped worker. */
function shellAllowList(sw: string): string[] {
  const m = sw.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("sw.js has no `const SHELL = [...]` allow-list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Every string literal in the worker that looks like a URL path. */
function allQuotedPaths(sw: string): string[] {
  return [...sw.matchAll(/"(\/[^"]*)"/g)].map((x) => x[1]);
}

// ================================================================== manifest

Deno.test("manifest: valid JSON that scopes the app to /order/ in standalone mode", () => {
  const m = manifest();
  assert(typeof m.name === "string" && (m.name as string).length > 0, "name is required (the install prompt shows it)");
  assert(
    typeof m.short_name === "string" && (m.short_name as string).length > 0 && (m.short_name as string).length <= 12,
    "short_name is required and must fit under a launcher icon",
  );
  assertEquals(m.start_url, "/order/", "start_url must be the absolute /order/ path");
  assertEquals(m.scope, "/order/", 'scope must be "/order/" — a "/" scope would take over /console/ and the whole origin');
  assertEquals(m.display, "standalone", "display must be standalone for an installed-app window");
  for (const key of ["background_color", "theme_color"]) {
    assert(
      typeof m[key] === "string" && /^#[0-9a-f]{6}$/i.test(m[key] as string),
      `${key} must be a #rrggbb colour`,
    );
  }
  if (m.id !== undefined) assertEquals(m.id, "/order/", "id must stay inside the scope");
  assert(Array.isArray(m.icons) && (m.icons as unknown[]).length >= 3, "icons array is required");
});

Deno.test("manifest: icons are real PNGs on disk whose bytes match their declared sizes", () => {
  const icons = manifest().icons as ManifestIcon[];
  const seen = new Set<string>();
  for (const icon of icons) {
    assert(typeof icon.src === "string", "icon.src is required");
    assertEquals(icon.type, "image/png", `${icon.src}: type must be image/png`);
    assert(/^\d+x\d+$/.test(icon.sizes ?? ""), `${icon.src}: sizes must be "WxH"`);
    const bytes = readBytes(iconDiskPath(icon.src));
    const [w, h] = icon.sizes.split("x").map(Number);
    const real = pngSize(bytes, icon.src);
    assertEquals(
      { w: real.width, h: real.height, d: bytes.length > 1000 },
      { w, h, d: true },
      `${icon.src}: the declared size must match the real PNG pixels (and be a non-trivial image)`,
    );
    seen.add(icon.sizes);
    const purpose = icon.purpose ?? "any";
    assert(
      purpose === "any" || purpose === "maskable" || purpose === "monochrome",
      `${icon.src}: unknown purpose "${purpose}"`,
    );
  }
  for (const size of ["192x192", "512x512"]) {
    assert(seen.has(size), `manifest must ship a ${size} icon (Android install prompt minimum)`);
  }
  assert(
    icons.some((i) => (i.purpose ?? "any").split(/\s+/).includes("maskable")),
    "manifest must ship a maskable icon for Android adaptive launchers",
  );
  assert(
    icons.some((i) => i.sizes === "512x512" && (i.purpose ?? "any").split(/\s+/).includes("maskable")),
    "the maskable icon set must include 512x512 (Chrome uses it for the splash screen)",
  );
});

// ==================================================================== page

Deno.test("index.html links the manifest, an apple-touch-icon, and registers the worker — guarded", () => {
  const page = read(INDEX_PATH);
  assert(/rel="manifest"/.test(page), "index.html must link the web app manifest");
  assert(page.includes('href="manifest.webmanifest"'), "the manifest link must point at manifest.webmanifest");
  assert(/rel="apple-touch-icon"/.test(page), "iOS Add-to-Home-Screen needs an apple-touch-icon link");
  assert(/name="theme-color"/.test(page), "theme-color drives the installed window chrome");
  assert(page.includes("navigator.serviceWorker.register"), "index.html must register the service worker");
  assert(page.includes('"sw.js"'), "registration must use the in-scope sw.js path");
  assert(page.includes('scope: "/order/"'), 'registration must pin scope "/order/"');
  // Guarded: a registration failure must never break the ordering UI.
  assert(/\.catch\(/.test(page), "the registration promise must be caught");
  assert(page.includes('"serviceWorker" in navigator'), "registration must be feature-guarded");
  // No regression on what the client already relies on.
  assert(page.includes('href="style.css"'), "the stylesheet link is still there");
  assert(page.includes('src="app.js"'), "the app module is still there");
});

// ============================================================ service worker

Deno.test("sw.js: the shell allow-list contains no /api/ path, and every entry is a real shipped file", () => {
  const sw = read(SW_PATH);
  const shell = shellAllowList(sw);
  assert(shell.length >= 4, "the app shell must list the document, script, stylesheet and icons");
  for (const entry of shell) {
    assert(!entry.includes("/api"), `the shell allow-list must never contain an API path (found ${entry})`);
    assert(entry.startsWith("/order/"), `${entry} is outside /order/ and could never be served by this worker`);
  }
  for (const entry of shell) {
    const disk = entry === "/order/" ? `${ORDER_DIR}/index.html` : `${ORDER_DIR}/${entry.slice("/order/".length)}`;
    readBytes(disk); // throws "missing file" if the shell lists something we do not ship
  }
  // Nothing that looks like a URL path in the worker may point at /api/ except
  // the one refusal constant.
  const apiish = allQuotedPaths(sw).filter((p) => p.startsWith("/api") && p !== "/api/");
  assertEquals(apiish, [], "the only /api path in the worker must be the bare /api/ prefix");
});

Deno.test("sw.js: the fetch handler refuses /api/** before it can reach any cache", () => {
  const sw = read(SW_PATH);
  const fetchHandler = sw.slice(sw.search(/addEventListener\(\s*"fetch"/));
  assert(fetchHandler.length > 0, 'sw.js has no addEventListener("fetch", ...)');
  const guard = fetchHandler.search(/isApiPath\s*\(\s*url\.pathname\s*\)|startsWith\(\s*["']\/api\//);
  assert(guard > -1, "the fetch handler must explicitly test the request path against /api/");
  const respond = fetchHandler.indexOf("respondWith(");
  assert(respond > -1, "the fetch handler must respondWith() the shell strategy");
  assert(guard < respond, "the /api/ refusal must come BEFORE respondWith(), or API responses would be cached");
  assert(
    /if\s*\([^)]*isApiPath[^)]*\)\s*return/.test(fetchHandler),
    "the /api/ guard must be an early return (network-only), not a branch that still caches",
  );
});

Deno.test("sw.js install: caches the whole shell from the network and nothing from /api/", async () => {
  const shell = shellAllowList(read(SW_PATH));
  const files: Record<string, string> = {};
  for (const entry of shell) {
    files[entry] = `body of ${entry}`;
  }
  const sw = bootSw(files);
  await sw.install();

  const shellCache = [...sw.caches.entries()].find(([name]) => name.includes("shell"));
  assert(shellCache, "install must open a named shell cache");
  const cached = [...(shellCache as [string, Map<string, string>])[1].keys()];
  assertEquals(cached.length, shell.length, `every shell entry must be cached (cached ${cached.length}/${shell.length})`);
  for (const key of cached) assert(!key.includes("/api"), `install cached an API response: ${key}`);
  assert(
    sw.fetched.some((u) => u === `${ORIGIN}/order/app.js`),
    "the shell is captured from the network (cache: reload), not from a stale HTTP cache",
  );
});

Deno.test("sw.js: a GET to /api/ is never intercepted and never cached", async () => {
  const sw = bootSw({});
  const response = await sw.fetch(`${ORIGIN}/api/orders/42`);
  assertEquals(
    response,
    null,
    "the worker must NOT respondWith() an /api/ request: order data is network-only",
  );
  const touched = [...sw.caches.values()].flatMap((store) => [...store.keys()]);
  assertEquals(touched.filter((u) => u.includes("/api")), [], "no cache may hold an /api/ URL");
  assertEquals(sw.fetched, [], "the worker must not even fetch /api/ itself — the browser owns that request");
});

Deno.test("sw.js: POST /api/orders and cross-origin requests are left to the network", async () => {
  const sw = bootSw({});
  assertEquals(
    await sw.fetch(`${ORIGIN}/api/orders`, { method: "POST" }),
    null,
    "a POST (order creation) must never be intercepted",
  );
  assertEquals(
    await sw.fetch("https://relay.example/event/abc"),
    null,
    "cross-origin requests (relays, invoices) are the browser's business",
  );
  assertEquals(
    await sw.fetch(`${ORIGIN}/order/index.html`, { headers: { authorization: "Nostr abc" } }),
    null,
    "an authenticated response must never be written to the shared cache",
  );
});

Deno.test("sw.js: offline, /order/ is served from the cache (and a deep link falls back to the shell)", async () => {
  const files: Record<string, string> = {};
  for (const entry of shellAllowList(read(SW_PATH))) files[entry] = `body of ${entry}`;
  const sw = bootSw(files);
  await sw.install();
  sw.setOffline(true);

  const nav = await sw.fetch(`${ORIGIN}/order/`, { mode: "navigate" });
  assert(nav, "offline navigation to /order/ must be answered from the shell cache");
  assertEquals(nav.status, 200);
  assertEquals(await nav.text(), "body of /order/");

  const asset = await sw.fetch(`${ORIGIN}/order/app.js`);
  assert(asset, "offline /order/app.js must come from the cache");
  assertEquals(await asset.text(), "body of /order/app.js");

  const deep = await sw.fetch(`${ORIGIN}/order/some/deep/link`, { mode: "navigate" });
  assert(deep, "an offline deep link must fall back to the cached ordering document");
  assertEquals(await deep.text(), "body of /order/index.html");
});

Deno.test("sw.js activate: drops this app's stale caches, keeps the console's and others'", async () => {
  const files: Record<string, string> = {};
  for (const entry of shellAllowList(read(SW_PATH))) files[entry] = `body of ${entry}`;
  const sw = bootSw(files, ["cvm-order-shell-v0", "console-app-shell-v3", "workbox-precache"]);
  await sw.install();
  await sw.activate();

  const names = [...sw.caches.keys()];
  assert(!names.includes("cvm-order-shell-v0"), "the previous shell version must be purged on activate");
  assert(
    names.some((n) => n.includes("shell") && n !== "cvm-order-shell-v0"),
    "the current shell cache must survive activate",
  );
  assert(names.includes("console-app-shell-v3"), "the console's cache shares this origin and must never be deleted");
  assert(names.includes("workbox-precache"), "unrelated caches on the origin must never be deleted");
});

// ============================================================ no collateral

Deno.test("the console client at /console/ is unaffected by the order PWA", () => {
  const m = manifest();
  // The whole risk: a scope of "/" would hand /console/ to the order worker.
  assertEquals(m.scope, "/order/");
  assertEquals(m.start_url, "/order/");
  // Scope comes from the script's own path, so the worker must live under /order/.
  const swStat = Deno.statSync(SW_PATH);
  assert(swStat.isFile, "the worker must live at site/order/sw.js so its default scope is /order/");
  assertEquals(
    Deno.statSync(`${ORDER_DIR}/manifest.webmanifest`).isFile,
    true,
    "the manifest must live under /order/, not at the origin root",
  );
  // And the console document must not have grown a manifest/worker of its own.
  const consolePage = read(CONSOLE_INDEX_PATH);
  assert(!consolePage.includes("manifest.webmanifest"), "the console must not link the order manifest");
  assert(!consolePage.includes("serviceWorker"), "the console must not register the order worker");
  assert(consolePage.includes('src="app.js"'), "the console document is otherwise untouched");
});

// ================================================================ deploy

Deno.test("deploy ships the PWA artifacts and asserts them on the live origin", () => {
  const deploy = read("deploy/deploy-pwa.sh");
  for (const artifact of ["manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
    assert(deploy.includes(artifact), `deploy-pwa.sh must ship/verify ${artifact}`);
  }
  // Verification, not just shipping: a file present but 404 at the edge is the
  // failure mode this guards.
  const verify = deploy.slice(deploy.indexOf("== verify"));
  assert(verify.includes("manifest.webmanifest"), "the post-deploy verify must request the manifest");
  assert(verify.includes("sw.js"), "the post-deploy verify must request the service worker");
});

Deno.test("the vhost serves the manifest as application/manifest+json", () => {
  const vhost = read("deploy/caddy-vhost-cvm-pwa.caddy");
  assert(
    vhost.includes("application/manifest+json"),
    "a manifest served as text/html makes Chrome refuse the install prompt",
  );
  assert(/webmanifest/.test(vhost), "the vhost must name the .webmanifest extension it retypes");
});
