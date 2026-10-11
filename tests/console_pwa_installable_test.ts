// tests/console_pwa_installable_test.ts
//
// The facilitator console at /console/ shares ONE origin with the customer
// ordering app (/order/) and with the /api surface they both drive. It is an
// installable PWA too, and like the order app it is only *installable* if four
// things are true at once — each of which fails silently in a browser:
//
//   1. a web app manifest whose start_url AND scope are exactly "/console/"
//      (a "/" scope would hand the whole origin, /order/ and /api included, to
//      this worker; the two PWAs must not be able to capture each other),
//   2. genuinely raster PNG icons whose declared `sizes` match the real pixels,
//      including a maskable 512 for the Android splash screen,
//   3. a service worker registered from /console/sw.js that caches the console
//      shell for offline but, like the order worker, STRUCTURALLY refuses
//      /api/** — the money surface (queue, invoice bolt11, transitions) must
//      never be served stale, and a worker that merely "does not cache it yet"
//      is one refactor away from doing so,
//   4. the document linking the manifest and registering the worker, guarded so
//      a registration failure cannot break the console UI.
//
// The structural source contracts are the cheap half; the /api refusal and the
// offline shell are also EVALUATED: the shipped site/console/sw.js is run
// against an in-memory CacheStorage / fetch double, so "the worker can never
// intercept the money API" is observed here rather than asserted by grep.
//
// Card custody (ADR-0013) is unaffected: this file only ADDS head links and a
// registration guard; the document still carries no form field at all.
// tests/console_pwa_test.ts keeps asserting that.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const CONSOLE_DIR = "site/console";
const INDEX_PATH = `${CONSOLE_DIR}/index.html`;
const MANIFEST_PATH = `${CONSOLE_DIR}/manifest.webmanifest`;
const SW_PATH = `${CONSOLE_DIR}/sw.js`;
const ORDER_MANIFEST_PATH = "site/order/manifest.webmanifest";
const ORIGIN = "https://cvm-pwa.orangesync.tech";
const SCOPE = "/console/";

/** The five artifacts a browser needs before it will offer the install prompt. */
const REQUIRED_ARTIFACTS = [
  "manifest.webmanifest",
  "sw.js",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-192.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

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

/** "/console/icon-192.png" -> "site/console/icon-192.png", refusing anything outside the scope. */
function iconDiskPath(src: string): string {
  assert(
    src.startsWith(SCOPE),
    `icon src ${src} must be an absolute /console/ path (scope is /console/)`,
  );
  assert(
    !src.toLowerCase().endsWith(".svg"),
    `icon src ${src} is an SVG — the Android install prompt requires raster PNG icons`,
  );
  return `${CONSOLE_DIR}/${src.slice(SCOPE.length)}`;
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
 * Evaluate the SHIPPED site/console/sw.js in a fresh scope with an in-memory
 * CacheStorage and a controllable fetch. `files` is the fake origin's content
 * map (pathname -> body).
 */
function bootSw(files: Record<string, string>, seedCaches: string[] = []): SwHarness {
  const stores = new Map<string, Map<string, string>>();
  for (const name of seedCaches) stores.set(name, new Map());
  const fetched: string[] = [];
  let offline = false;

  const absolute = (input: unknown): string => {
    if (typeof input === "string") return new URL(input, `${ORIGIN}/`).href;
    if (input instanceof URL) return input.href;
    return (input as { url: string }).url;
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
    location: new URL(`${ORIGIN}${SCOPE}sw.js`),
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const factory = new Function("self", "caches", "fetch", "console", read(SW_PATH)) as (
    ...args: unknown[]
  ) => void;
  factory(selfMock, cacheApi, fetchImpl, { warn() {}, log() {}, error() {}, info() {} });

  const runLifecycle = async (type: string): Promise<void> => {
    assert(typeof handlers[type] === "function", `site/console/sw.js has no "${type}" listener`);
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
      assert(typeof handlers["fetch"] === "function", `site/console/sw.js has no "fetch" listener`);
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
  if (!m) throw new Error("site/console/sw.js has no `const SHELL = [...]` allow-list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Every string literal in the worker that looks like a URL path. */
function allQuotedPaths(sw: string): string[] {
  return [...sw.matchAll(/"(\/[^"]*)"/g)].map((x) => x[1]);
}

// ============================================================== the artifacts

Deno.test("every console PWA artifact exists on disk, under /console/", () => {
  for (const name of REQUIRED_ARTIFACTS) {
    const stat = Deno.statSync(`${CONSOLE_DIR}/${name}`);
    assert(stat.isFile && stat.size > 0, `site/console/${name} is missing or empty`);
  }
  // Nothing may live at the origin root: a manifest at /manifest.webmanifest
  // would be a THIRD identity claiming the whole origin.
  assert(
    Deno.statSync(`${CONSOLE_DIR}/manifest.webmanifest`).isFile,
    "the console manifest must live at site/console/manifest.webmanifest",
  );
  assert(
    !(() => {
      try {
        return Deno.statSync("site/manifest.webmanifest").isFile;
      } catch {
        return false;
      }
    })(),
    "no manifest may sit at the docroot root — that would claim the whole origin",
  );
});

// ================================================================== manifest

Deno.test("console manifest: valid JSON that scopes the app to /console/ in standalone mode", () => {
  const m = manifest();
  assert(typeof m.name === "string" && (m.name as string).length > 0, "name is required (the install prompt shows it)");
  assert(
    typeof m.short_name === "string" && (m.short_name as string).length > 0 && (m.short_name as string).length <= 12,
    "short_name is required and must fit under a launcher icon",
  );
  assertEquals(m.start_url, SCOPE, "start_url must be the absolute /console/ path");
  assertEquals(
    m.scope,
    SCOPE,
    'scope must be "/console/" — a "/" scope would hand /order/ and /api to this worker',
  );
  assertEquals(m.display, "standalone", "display must be standalone for an installed-app window");
  for (const key of ["background_color", "theme_color"]) {
    assert(
      typeof m[key] === "string" && /^#[0-9a-f]{6}$/i.test(m[key] as string),
      `${key} must be a #rrggbb colour`,
    );
  }
  if (m.id !== undefined) assertEquals(m.id, SCOPE, "id must stay inside the scope");
  assert(Array.isArray(m.icons) && (m.icons as unknown[]).length >= 3, "icons array is required");
  // The two PWAs are separate identities on one origin: the console manifest
  // must not describe the ordering app.
  assert(!JSON.stringify(m).includes("/order/"), "the console manifest must not reference /order/");
});

Deno.test("console manifest: icons are real PNGs on disk whose bytes match their declared sizes", () => {
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

Deno.test("console index.html links the manifest, an apple-touch-icon, and registers the worker — guarded", () => {
  const page = read(INDEX_PATH);
  assert(/rel="manifest"/.test(page), "index.html must link the web app manifest");
  assert(page.includes('href="manifest.webmanifest"'), "the manifest link must point at the console's own manifest.webmanifest");
  assert(!page.includes("/order/manifest.webmanifest"), "the console must never link the ordering app's manifest");
  assert(/rel="apple-touch-icon"/.test(page), "iOS Add-to-Home-Screen needs an apple-touch-icon link");
  assert(/name="theme-color"/.test(page), "theme-color drives the installed window chrome");
  assert(page.includes("navigator.serviceWorker.register"), "index.html must register the service worker");
  assert(page.includes('"sw.js"'), "registration must use the in-scope sw.js path");
  assert(page.includes(`scope: "${SCOPE}"`), `registration must pin scope "${SCOPE}"`);
  assert(/\{ scope: "\/console\/" \}/.test(page), "the scope must be passed as an explicit register() option, not inferred");
  // Guarded: a registration failure must never break the money console.
  assert(/\.catch\(/.test(page), "the registration promise must be caught");
  assert(page.includes('"serviceWorker" in navigator'), "registration must be feature-guarded");
  // No regression on what the console already relies on, and no card custody regression.
  assert(page.includes('href="style.css"'), "the stylesheet link is still there");
  assert(page.includes('src="app.js"'), "the app module is still there");
  assert(page.includes("noindex"), "the money console is still not for search engines");
  assertEquals(page.match(/<(input|select|textarea|form)\b/gi), null, "adding head links must not add a form field");
});

// ============================================================ service worker

Deno.test("console sw.js lives at /console/sw.js, its shell allow-list is /console/-only and lists only shipped files", () => {
  const sw = read(SW_PATH);
  assert(Deno.statSync(SW_PATH).isFile, "the worker must live at site/console/sw.js so its default scope is /console/");
  const shell = shellAllowList(sw);
  assert(shell.length >= 4, "the app shell must list the document, script, stylesheet and icons");
  for (const entry of shell) {
    assert(!entry.includes("/api"), `the shell allow-list must never contain an API path (found ${entry})`);
    assert(entry.startsWith(SCOPE), `${entry} is outside /console/ and could never be served by this worker`);
  }
  for (const entry of shell) {
    const disk = entry === SCOPE ? `${CONSOLE_DIR}/index.html` : `${CONSOLE_DIR}/${entry.slice(SCOPE.length)}`;
    readBytes(disk); // throws "missing file" if the shell lists something we do not ship
  }
  // Nothing that looks like a URL path in the worker may point at /api/ except
  // the one refusal constant.
  const apiish = allQuotedPaths(sw).filter((p) => p.startsWith("/api") && p !== "/api/");
  assertEquals(apiish, [], "the only /api path in the worker must be the bare /api/ prefix");
  // The two workers share one origin and one CacheStorage: the console worker
  // must not be able to claim the ordering app either.
  assert(!sw.includes('"/order/'), "the console worker must never name /order/ in a shell entry");
});

Deno.test("console sw.js: the fetch handler refuses /api/** before it can reach any cache", () => {
  const sw = read(SW_PATH);
  const fetchHandler = sw.slice(sw.search(/addEventListener\(\s*"fetch"/));
  assert(fetchHandler.length > 0, 'site/console/sw.js has no addEventListener("fetch", ...)');
  const guard = fetchHandler.search(/isApiPath\s*\(\s*url\.pathname\s*\)|startsWith\(\s*["']\/api\//);
  assert(guard > -1, "the fetch handler must explicitly test the request path against /api/");
  const respond = fetchHandler.indexOf("respondWith(");
  assert(respond > -1, "the fetch handler must respondWith() the shell strategy");
  assert(guard < respond, "the /api/ refusal must come BEFORE respondWith(), or API responses would be cached");
  assert(
    /if\s*\([^;]*isApiPath[^;]*\)\s*return/.test(fetchHandler),
    "the /api/ guard must be an early return (network-only), not a branch that still caches",
  );
});

Deno.test("console sw.js install: caches the whole shell from the network and nothing from /api/", async () => {
  const shell = shellAllowList(read(SW_PATH));
  const files: Record<string, string> = {};
  for (const entry of shell) files[entry] = `body of ${entry}`;
  const sw = bootSw(files);
  await sw.install();

  const shellCache = [...sw.caches.entries()].find(([name]) => name.includes("shell"));
  assert(shellCache, "install must open a named shell cache");
  const cached = [...(shellCache as [string, Map<string, string>])[1].keys()];
  assertEquals(cached.length, shell.length, `every shell entry must be cached (cached ${cached.length}/${shell.length})`);
  for (const key of cached) assert(!key.includes("/api"), `install cached an API response: ${key}`);
  assert(
    sw.fetched.some((u) => u === `${ORIGIN}${SCOPE}app.js`),
    "the shell is captured from the network (cache: reload), not from a stale HTTP cache",
  );
});

Deno.test("console sw.js: a GET to /api/ is never intercepted and never cached", async () => {
  const sw = bootSw({});
  const response = await sw.fetch(`${ORIGIN}/api/orders/42`);
  assertEquals(response, null, "the worker must NOT respondWith() an /api/ request: the money surface is network-only");
  const touched = [...sw.caches.values()].flatMap((store) => [...store.keys()]);
  assertEquals(touched.filter((u) => u.includes("/api")), [], "no cache may hold an /api/ URL");
  assertEquals(sw.fetched, [], "the worker must not even fetch /api/ itself — the browser owns that request");
});

Deno.test("console sw.js: POST /api/orders and cross-origin requests are left to the network", async () => {
  const sw = bootSw({});
  assertEquals(
    await sw.fetch(`${ORIGIN}/api/orders/42/transition`, { method: "POST" }),
    null,
    "a transition POST (state, and money, changing) must never be intercepted",
  );
  assertEquals(await sw.fetch("https://relay.example/event/abc"), null, "cross-origin requests (relays) are the browser's business");
  assertEquals(
    await sw.fetch(`${ORIGIN}${SCOPE}index.html`, { headers: { authorization: "Nostr abc" } }),
    null,
    "an authenticated response must never be written to the shared cache",
  );
});

Deno.test("console sw.js: offline, /console/ is served from the cache (and a deep link falls back to the console shell)", async () => {
  const files: Record<string, string> = {};
  for (const entry of shellAllowList(read(SW_PATH))) files[entry] = `body of ${entry}`;
  const sw = bootSw(files);
  await sw.install();
  sw.setOffline(true);

  const nav = await sw.fetch(`${ORIGIN}${SCOPE}`, { mode: "navigate" });
  assert(nav, "offline navigation to /console/ must be answered from the shell cache");
  assertEquals(await nav.text(), `body of ${SCOPE}`);

  const asset = await sw.fetch(`${ORIGIN}${SCOPE}app.js`);
  assert(asset, "offline /console/app.js must come from the cache");
  assertEquals(await asset.text(), `body of ${SCOPE}app.js`);

  const deep = await sw.fetch(`${ORIGIN}${SCOPE}some/deep/link`, { mode: "navigate" });
  assert(deep, "an offline deep link must fall back to the cached console document");
  assertEquals(await deep.text(), `body of ${SCOPE}index.html`);
});

Deno.test("console sw.js activate: drops this app's stale caches, keeps the order app's and others'", async () => {
  const files: Record<string, string> = {};
  for (const entry of shellAllowList(read(SW_PATH))) files[entry] = `body of ${entry}`;
  const sw = bootSw(files, ["cvm-console-shell-v0", "cvm-order-shell-v1", "workbox-precache"]);
  await sw.install();
  await sw.activate();

  const names = [...sw.caches.keys()];
  assert(!names.includes("cvm-console-shell-v0"), "the previous console shell version must be purged on activate");
  assert(
    names.some((n) => n.includes("shell") && n !== "cvm-console-shell-v0"),
    "the current shell cache must survive activate",
  );
  assert(names.includes("cvm-order-shell-v1"), "the ordering app's cache shares this origin and must never be deleted");
  assert(names.includes("workbox-precache"), "unrelated caches on the origin must never be deleted");
});

// ============================================================ no collateral

Deno.test("the order app and the money API are unaffected by the console PWA", () => {
  const m = manifest();
  assertEquals(m.scope, SCOPE, "the console manifest must not claim /order/");
  assertEquals(m.start_url, SCOPE);
  // The order app's identity is untouched by this change.
  const order = JSON.parse(read(ORDER_MANIFEST_PATH)) as Record<string, unknown>;
  assertEquals(order.scope, "/order/", "the shipped customer PWA's manifest must be frozen");
  assertEquals(order.start_url, "/order/");
  // The console's worker is the console's own file: it must not be the order worker.
  assert(read(SW_PATH) !== read("site/order/sw.js"), "the console worker must be its own file, not a copy of the order worker's scope");
});
