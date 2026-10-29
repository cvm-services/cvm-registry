// The cvm-pwa vhost is the contract between the two PWAs and the host. These
// assertions are deliberately about the *shipped text*: the live defect
// (2026-10-10) was that /api/* fell through to the SPA fallback and answered
// HTTP 200 + index.html, which made the customer PWA's fetch() resolve and then
// fail parsing. Nothing in the JS could see that, so the vhost is gated here.
const VHOST = Deno.readTextFileSync("deploy/caddy-vhost-cvm-pwa.caddy");
const DEPLOY = Deno.readTextFileSync("deploy/deploy-pwa.sh");

Deno.test("/api/* is reverse-proxied to cvm-orders and the prefix is stripped", () => {
  // handle_path (not handle) strips /api before the upstream sees it: cvm-orders
  // serves /auth/challenge, /orders/queue, /health at its root.
  if (!VHOST.includes("handle_path /api/* {")) {
    throw new Error("the vhost no longer strips /api/* onto the order service");
  }
  if (!VHOST.includes("reverse_proxy 127.0.0.1:8788")) {
    throw new Error("the vhost no longer proxies /api/* to 127.0.0.1:8788");
  }
});

Deno.test("a down /api answers a JSON error, never the SPA fallback", () => {
  if (!VHOST.includes("handle_errors")) throw new Error("no handle_errors block");
  if (!/respond @api `\{"error"/.test(VHOST)) {
    throw new Error("the error route does not answer JSON on /api/*");
  }
  // The failure mode we are closing: /api/* resolving to the ordering document.
  if (!/handle_errors[\s\S]*@api path \/api\/\*/.test(VHOST)) {
    throw new Error("the error route is not scoped to /api/*");
  }
});

Deno.test("the in-memory store is stated in the vhost, where a restart is read", () => {
  if (!/IN\s+MEMORY/i.test(VHOST) || !/restart/i.test(VHOST)) {
    throw new Error("the vhost must warn that a restart empties the in-memory queue");
  }
});

Deno.test("each PWA falls back to its OWN document", () => {
  if (!VHOST.includes("try_files {path} /console/index.html")) {
    throw new Error("/console/1 would fall back to the customer document");
  }
  if (!VHOST.includes("try_files {path} /order/index.html")) {
    throw new Error("/order/ lost its SPA fallback");
  }
});

Deno.test("the new customer API is proxied over FIPS on its own prefix", () => {
  if (!VHOST.includes("handle_path /order-next-api/* {")) {
    throw new Error("the vhost lost /order-next-api/*");
  }
  if (!VHOST.includes("reverse_proxy [fd36:3c0f:d6f:8029:ea50:958b:672e:bb0]:8793")) {
    throw new Error("the vhost no longer proxies /order-next-api/* to x280 over FIPS");
  }
  // The old /api proxy must remain, so the demo/console are not repointed.
  if (!VHOST.includes("reverse_proxy 127.0.0.1:8788")) {
    throw new Error("/api/* must stay on cvm-orders");
  }
});

Deno.test("the new customer UI has its own scoped fallback", () => {
  if (!VHOST.includes("handle /order-next/* {")) {
    throw new Error("/order-next/ has no handler");
  }
  if (!VHOST.includes("try_files {path} /order-next/index.html")) {
    throw new Error("/order-next/ lost its SPA fallback");
  }
});

Deno.test("the facilitator LNURLP routes point at the T14 treasury server", () => {
  if (!VHOST.includes("handle /.well-known/lnurlp/* {")) {
    throw new Error("the LNURL discovery route disappeared");
  }
  if (!VHOST.includes("handle /lnurlp/* {")) {
    throw new Error("the LNURL callback/status route disappeared");
  }
  if (!VHOST.includes("handle_path /lnurlp/internal/* {")) {
    throw new Error("the internal LNURLP API is not prefix-stripped");
  }
  if (!VHOST.includes("reverse_proxy [fd79:f451:67b1:8084:2b2a:5b1e:9110:26d0]:8098")) {
    throw new Error("the LNURL route no longer points at the T14 LNURLP server");
  }
  // It must not have replaced the old /api -> cvm-orders route.
  if (!VHOST.includes("reverse_proxy 127.0.0.1:8788")) {
    throw new Error("/api/* must stay on cvm-orders");
  }
});

Deno.test("the x280 API's own error detail is not replaced by Caddy", () => {
  // The service returns structured 502s (invoice_failed) with a detail. A
  // handle_errors override for /order-next-api would replace that body and make
  // the failure undiagnosable. The old /api handler stays.
  if (VHOST.includes("@order_next_api")) {
    throw new Error("a Caddy error override would hide the x280 service's error detail");
  }
  if (!VHOST.includes("handle_path /order-next-api/*")) {
    throw new Error("the x280 API route disappeared");
  }
});

Deno.test("the deploy replaces an existing vhost instead of skipping it", () => {
  if (!DEPLOY.includes("rewrite-caddy-vhost.py")) {
    throw new Error("deploy-pwa.sh must install the vhost via rewrite-caddy-vhost.py");
  }
  // The old behaviour — append once, skip forever — could not ship the /api proxy.
  if (/if ! grep -q "\$DOMAIN" \/etc\/caddy\/Caddyfile/.test(DEPLOY)) {
    throw new Error("deploy-pwa.sh still has the append-once vhost logic");
  }
  if (!DEPLOY.includes("cd /tmp/console-live.html") && !DEPLOY.includes("console-live.html")) {
    throw new Error("deploy-pwa.sh must assert which document /console/ serves");
  }
});

Deno.test("the order service is installed loopback-only with its own env file", () => {
  const orders = Deno.readTextFileSync("deploy/cvm-orders-remote-setup.sh");
  if (!orders.includes("BIND_ADDR:-127.0.0.1")) {
    throw new Error("cvm-orders must bind loopback by default");
  }
  if (!orders.includes("EnvironmentFile=$ENV_DIR/config.env")) {
    throw new Error("the unit must read FACILITATOR_NPUB from its own env file");
  }
  if (!orders.includes("FACILITATOR_NPUB=$FACILITATOR_NPUB")) {
    throw new Error("the env file must carry FACILITATOR_NPUB");
  }
  if (!orders.includes("ENV_DIR=/etc/cvm-orders")) {
    throw new Error("the unit must read FACILITATOR_NPUB from its own env file");
  }
  // The value is supplied at deploy time, never committed: the wrapper refuses
  // to run without it (ADR-0013 keeps no key material in the repo).
  const setup = Deno.readTextFileSync("deploy/orders-setup.sh");
  if (!/FACILITATOR_NPUB is required/.test(setup)) {
    throw new Error("orders-setup.sh must fail closed without FACILITATOR_NPUB");
  }
});

// ---------------------------------------------------------------------------
// 2026-10-10 — the UNSCOPED catch-all.
//
// The vhost ended with `handle { try_files {path} /order/index.html; file_server }`.
// Being unscoped, it answered HTTP 200 + the order document for EVERY path no
// earlier handler matched, and the one that matters is bare `/api`:
// `handle_path /api/*` needs the trailing slash, so `/api` fell through and came
// back as text/html. The document at `/api` loads its assets with RELATIVE urls,
// so the browser fetched `/style.css` and `/app.js`, got text/html for both and
// refused to execute the module script — "Loading venues…" stayed on screen
// forever, with no console error and no failed request to look at.
//
// These assertions describe the shape of the fix in the shipped bytes.
// ---------------------------------------------------------------------------

interface HandleBlock {
  /** `handle` or `handle_path` */
  name: string;
  /** the path matcher, "" for the catch-all */
  matcher: string;
  /** the block body, braces excluded */
  body: string;
}

/** Top-level handle/handle_path blocks of the shipped vhost text. */
function handleBlocks(src: string): HandleBlock[] {
  const lines = src.split("\n");
  const header = /^\s*(handle|handle_path)(?:\s+([^{]*?))?\s*\{\s*$/;
  const out: HandleBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = header.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    let depth = 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const open = (line.match(/\{/g) ?? []).length;
      const close = (line.match(/\}/g) ?? []).length;
      if (depth + open - close <= 0) break;
      depth += open - close;
      body.push(line);
    }
    out.push({ name: m[1], matcher: (m[2] ?? "").trim(), body: body.join("\n") });
  }
  return out;
}

const BLOCKS = handleBlocks(VHOST);
const blockFor = (matcher: string) => BLOCKS.find((b) => b.matcher === matcher);

Deno.test("bare /api has its own handler and never reaches the order fallback", () => {
  const api = blockFor("/api");
  if (!api) {
    throw new Error(
      "no `handle /api` (exact): bare /api still falls through to the SPA fallback " +
        "and answers the order document as text/html",
    );
  }
  if (/try_files|file_server/.test(api.body)) {
    throw new Error("the bare /api handler serves files — /api must answer as an API");
  }
  // Either an exact-match redirect to the proxy's own prefix (preserves the
  // method) or a JSON answer. What may NOT happen is a 200 + HTML.
  //
  // The matcher slot (`*`) is REQUIRED, not stylistic: Caddy reads `redir`'s first
  // argument as an optional inline matcher, and a path-looking token IS a path
  // matcher, so `redir /api/ 308` adapts to `match path /api/ -> 302 Location: 308`
  // and answers 200 + empty body. See the dedicated test below.
  if (!/redir\s+(\*|@[\w.-]+)\s+\/api\/\s+308/.test(api.body) && !/respond[^\n]*`\{"/.test(api.body)) {
    throw new Error("handle /api neither redirects to /api/ with an explicit matcher slot nor answers JSON");
  }
});

Deno.test("the SPA fallback is scoped to /order/*, so an arbitrary path cannot serve the app", () => {
  const order = blockFor("/order/*");
  if (!order) {
    throw new Error(
      "no `handle /order/*`: the order fallback is unscoped, so /style.css, /app.js " +
        "and /nope all answer 200 + the order document",
    );
  }
  if (!order.body.includes("try_files {path} /order/index.html")) {
    throw new Error("/order/ lost its SPA fallback");
  }
  // One carrier only: the document must be reachable from exactly one handler,
  // and that handler must be the app's own subtree.
  const carriers = BLOCKS.filter((b) => /\/order\/index\.html/.test(b.body));
  if (carriers.length !== 1) {
    throw new Error(
      "the order document is reachable from " + carriers.length + " handlers: " +
        carriers.map((c) => c.matcher || "(catch-all)").join(", "),
    );
  }
  // A catch-all may serve files; it may not rewrite a missing path to a document.
  for (const b of BLOCKS) {
    if (b.matcher === "" && /try_files/.test(b.body)) {
      throw new Error("the catch-all still rewrites unknown paths to a document");
    }
  }
});

Deno.test("the catch-all still serves the docroot's real files, and only those", () => {
  // app.js fetches `../menu.json` and `../../vocab/service-inputs.json` — paths
  // OUTSIDE /order/. Deleting the catch-all instead of scoping it would 404 the
  // app's own data and hang the page exactly like the defect above, so the
  // fallback-free file_server is load-bearing, not decoration.
  const catchAll = blockFor("");
  if (!catchAll) {
    throw new Error("no catch-all: /menu.json and /vocab/... would 404 and the app could not price anything");
  }
  if (!catchAll.body.includes("file_server")) {
    throw new Error("the catch-all must serve the docroot's real files");
  }
  if (/try_files/.test(catchAll.body)) {
    throw new Error("the catch-all must not rewrite a missing path to any document");
  }
  if (!DEPLOY.includes("site/menu.json") || !DEPLOY.includes("vocab/service-inputs.json")) {
    throw new Error("the deploy stopped shipping the app's out-of-subtree data");
  }
});

Deno.test("the origin root is an explicit alias, not a second copy of the app", () => {
  const root = blockFor("/");
  if (!root) {
    throw new Error("`/` is unhandled — the bare origin would 404");
  }
  if (/try_files|file_server/.test(root.body)) {
    throw new Error("`/` serves a document directly: the app's relative asset urls would resolve against the wrong base");
  }
  if (!/redir\s+(\*|@[\w.-]+)\s+\/order\/\s+302/.test(root.body)) {
    throw new Error("`/` must alias to /order/ with an explicit matcher slot");
  }
});

// ---------------------------------------------------------------------------
// The failure mode a TEXT assertion cannot see on its own.
//
// Caddy reads `redir`'s first argument as an optional inline matcher, and a token
// beginning with "/" is a path matcher. So the obvious-looking spelling
//     redir /api/ 308
// does NOT mean "redirect to /api/ with 308". `caddy adapt` (2.6.2) turns it into
//     match path /api/   ->   static_response status 302, headers {Location: 308}
// and because the rewritten inner route only matches /api/ — never bare /api —
// GET /api answered 200 with an EMPTY body. The directive silently stopped
// redirecting; only a real request revealed it (see evidence/t_cdc4442b/).
//
// The rule this test enforces is therefore about the whole file, not one line:
// no `redir` may put its TARGET in the matcher slot.
// ---------------------------------------------------------------------------
Deno.test("no redir target can be read as Caddy's inline matcher slot", () => {
  VHOST.split("\n").forEach((line, i) => {
    const m = /^\s*redir\s+(\S+)/.exec(line);
    if (!m) return;
    if (m[1].startsWith("/")) {
      throw new Error(
        `line ${i + 1}: \`redir ${m[1]} …\` — Caddy reads \`${m[1]}\` as an inline path ` +
          "matcher, so the target moves into the code slot: the directive becomes a " +
          "302 to the literal string and stops redirecting. Name the matcher (`redir * …`).",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-10-11 — the console at /console/ is a PWA too.
//
// The console shipped with a document, a module and a stylesheet and NOTHING
// else, so /console/manifest.webmanifest, /console/sw.js and /console/icon-192.png
// all answered 200 + text/html: the SCOPED /console/ fallback firing on paths
// with no file behind them. That is not the unscoped-catch-all defect (the
// scoping landed), and it is worse in one way — a 200 text/html is
// indistinguishable from "the file is there" by probing, so the two states the
// card needed to tell apart (absent vs mis-served) looked identical.
//
// The artifacts now exist (tests/console_pwa_installable_test.ts asserts the
// bytes, the manifest's scope and the worker's /api refusal). What the EDGE has
// to get right is the media type: Chrome refuses the install prompt for a
// manifest that does not arrive as manifest JSON, and Caddy's mime table is a
// default, not a guarantee. The retyping must stay a path LIST — a bare
// wildcard would re-introduce text/html-as-manifest-JSON for arbitrary paths,
// which is the same class of defect this file was written for.
// ---------------------------------------------------------------------------

Deno.test("both PWA manifests are retyped as manifest JSON through a specific path list", () => {
  const line = /@([A-Za-z0-9_]+)\s+path\s+([^\n]+)/g;
  let matcher: RegExpExecArray | null;
  let pwa: { name: string; paths: string[] } | null = null;
  while ((matcher = line.exec(VHOST)) !== null) {
    const paths = matcher[2].trim().split(/\s+/);
    if (paths.some((p) => p.endsWith("/manifest.webmanifest"))) {
      pwa = { name: matcher[1], paths };
      break;
    }
  }
  if (!pwa) {
    throw new Error(
      "the manifest content-type matcher is gone: a manifest served as text/html makes Chrome refuse the install prompt",
    );
  }
  for (const path of ["/order/manifest.webmanifest", "/console/manifest.webmanifest"]) {
    if (!pwa.paths.includes(path)) {
      throw new Error(
        `the manifest content-type matcher does not cover ${path} (paths: ${pwa.paths.join(", ")}) — ` +
          "that manifest arrives as whatever Caddy's mime table defaults to, and the install prompt is refused on a text/html answer",
      );
    }
  }
  // Specific, not a wildcard: a path matcher covering everything would retype
  // arbitrary paths as manifest JSON, i.e. the "absent vs broken is
  // indistinguishable" problem this file exists to prevent.
  for (const path of pwa.paths) {
    if (path.includes("*") || path.includes("?") || !path.endsWith("/manifest.webmanifest")) {
      throw new Error(
        `the manifest content-type matcher must name literal manifest paths: found "${path}"`,
      );
    }
  }
  const header = new RegExp(
    `header\\s+@${pwa.name}\\s+Content-Type\\s+"application/manifest\\+json"`,
  );
  if (!header.test(VHOST)) {
    throw new Error("the content-type is not applied through that path matcher");
  }
  // Not a bare `header Content-Type …`, which would retype EVERY file on the
  // origin — including /api — as manifest JSON.
  if (/^\s*header\s+Content-Type/m.test(VHOST)) {
    throw new Error("the content-type override must sit behind a path matcher, never apply to the whole site");
  }
});

Deno.test("the console falls back to the console document only, and exactly one handler carries it", () => {
  const console = blockFor("/console/*");
  if (!console) {
    throw new Error("no `handle /console/*`: the console would fall through to the catch-all and 404");
  }
  if (!console.body.includes("try_files {path} /console/index.html")) {
    throw new Error("/console/ lost its SPA fallback — a deep link would 404 instead of loading the console");
  }
  // The console document must be reachable from exactly one handler, and that
  // handler must be the console's own subtree.
  const carriers = BLOCKS.filter((b) => /\/console\/index\.html/.test(b.body));
  if (carriers.length !== 1) {
    throw new Error(
      "the console document is reachable from " + carriers.length + " handlers: " +
        carriers.map((c) => c.matcher || "(catch-all)").join(", "),
    );
  }
  // The console PWA artifacts land under /console/, so `try_files {path}` must
  // be able to serve them: the fallback must be the LAST try_files argument,
  // i.e. a real file at /console/manifest.webmanifest wins over the document.
  if (!/try_files\s+\{path\}\s+\/console\/index\.html/.test(console.body)) {
    throw new Error("the console fallback must try the real path first, or the manifest/SW/icons could never be served");
  }
});

Deno.test("no document-producing handler is reachable from an /api path", () => {
  // /api carries order state and the Lightning invoice. A 200 + text/html here
  // is the defect that made the pay step undiagnosable, so the guarantee is
  // structural: the ONLY handler whose matcher starts with /api is the proxy,
  // and no handler that can rewrite a path to a document may be reached by one.
  for (const b of BLOCKS) {
    const isApiScoped = b.matcher.startsWith("/api");
    if (isApiScoped && /try_files/.test(b.body)) {
      throw new Error(
        `the /api handler (\`${b.name} ${b.matcher}\`) can rewrite a path to a document — ` +
          "an API request must never be answered with HTML",
      );
    }
    if (b.matcher === "" && /try_files/.test(b.body)) {
      throw new Error("the catch-all rewrites unknown paths to a document, so /api could reach it again");
    }
  }
  // Bare /api has its own exact handler (asserted above); the prefix form must
  // still be a stripping proxy, not a file_server.
  const prefix = blockFor("/api/*");
  if (!prefix) throw new Error("no `handle_path /api/*`: the API surface is no longer proxied at all");
  if (!prefix.body.includes("reverse_proxy 127.0.0.1:8788")) {
    throw new Error("handle_path /api/* no longer proxies to cvm-orders");
  }
  if (/try_files|file_server/.test(prefix.body)) {
    throw new Error("handle_path /api/* serves files — /api must answer as an API");
  }
});

