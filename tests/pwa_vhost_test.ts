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
  if (!/redir\s+\/api\/\s+30[128]/.test(api.body) && !/respond[^\n]*`\{"/.test(api.body)) {
    throw new Error("handle /api neither redirects to /api/ nor answers JSON");
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
  if (!/redir\s+\/order\/\s+30[128]/.test(root.body)) {
    throw new Error("`/` must alias to /order/");
  }
});
