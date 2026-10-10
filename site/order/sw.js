/*
 * site/order/sw.js — the customer ordering client's service worker.
 *
 * Two jobs and one refusal:
 *
 *   1. OFFLINE SHELL. The document, module, stylesheet, manifest and icons are
 *      precached at install, so an installed app opens without a network. Every
 *      same-origin, non-API GET is served NETWORK-FIRST and a successful
 *      response refreshes the offline copy — an online customer keeps seeing
 *      exactly what the deploy shipped, never a stale-first read.
 *
 *   2. THE REFUSAL. Nothing under API_PREFIX is ever intercepted, cached, or
 *      served from cache. That surface carries order state and the Lightning
 *      invoice (bolt11), where a stale answer is a money bug rather than a UX
 *      bug. Those requests fall straight through to the browser — this worker
 *      does not even fetch them itself, so it cannot log or rewrite them.
 *
 * SCOPE. The worker is served from /order/sw.js and is registered with
 * scope "/order/" — deliberately NOT "/". The facilitator console at /console/
 * shares this origin, and a wider scope would let this worker intercept it.
 * Scope also bounds what can ever be served offline: /menu.json and
 * /vocab/service-inputs.json live OUTSIDE /order/, so they stay network-only and
 * the client keeps its existing "catalog unavailable" state when offline.
 *
 * Bump SW_VERSION to ship a new shell. activate() deletes the other caches this
 * app owns and nothing else — other apps on this origin share the CacheStorage.
 */

const SW_VERSION = "1";
const CACHE_PREFIX = "cvm-order-";
const SHELL_CACHE = CACHE_PREFIX + "shell-v" + SW_VERSION;

/*
 * The API surface, stated once. Nothing under this prefix may appear in the
 * shell allow-list below, and the fetch handler refuses it before it can reach
 * any cache.
 */
const API_PREFIX = "/api/";

/*
 * The app shell: everything needed to render the client with no network. Every
 * entry here is a file the deploy actually ships (tests/order_pwa_installable_test.ts
 * checks each one against disk), and none of them is under API_PREFIX.
 *
 * /order/ and /order/index.html are both listed: a navigation and a direct
 * document request are different cache keys.
 */
const SHELL = [
  "/order/",
  "/order/index.html",
  "/order/app.js",
  "/order/style.css",
  "/order/manifest.webmanifest",
  "/order/icon-192.png",
  "/order/icon-512.png",
  "/order/icon-maskable-192.png",
  "/order/icon-maskable-512.png",
  "/order/apple-touch-icon.png",
];

const isApiPath = (pathname) => pathname.indexOf(API_PREFIX) === 0;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Per-asset, not addAll(): one 404 must not leave the worker permanently
      // uninstalled (which would silently drop offline support for everyone).
      // cache: "reload" captures the shell from the network rather than from a
      // stale HTTP cache entry. The test asserts the allow-list is complete, so
      // a typo here fails the build instead of failing quietly in the field.
      await Promise.allSettled(
        SHELL.map((url) =>
          cache.add(new Request(new URL(url, self.location.href), { cache: "reload" }))
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((name) => name.indexOf(CACHE_PREFIX) === 0 && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GET is ever served from cache. Creating an order and fetching its
  // invoice must always reach the order service untouched.
  if (request.method !== "GET") return;

  // A response to an authenticated request is never written to a cache shared
  // with the rest of the app.
  if (request.headers.get("authorization")) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin (relays, invoice images, fonts): the browser's business.
  if (url.origin !== self.location.origin) return;

  // THE REFUSAL: network-only, never cached, never served stale.
  if (isApiPath(url.pathname)) return;

  event.respondWith(respondFromNetworkFirst(request));
});

/*
 * Network-first with a cache fallback. Used for every same-origin non-API GET,
 * including navigations. Never called for API_PREFIX: the guard above returns
 * before respondWith(), so this function is unreachable for API requests.
 */
async function respondFromNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type !== "opaque") {
      try {
        await cache.put(request, response.clone());
      } catch {
        // Quota or an unserialisable response: the offline copy is additive,
        // so a failed write must not fail the request.
      }
    }
    return response;
  } catch (err) {
    const url = new URL(request.url);
    const cached =
      (await cache.match(request)) ||
      (await cache.match(url.pathname)) ||
      (request.mode === "navigate" ? (await cache.match("/order/index.html")) || (await cache.match("/order/")) : undefined);
    if (cached) return cached;
    throw err;
  }
}
