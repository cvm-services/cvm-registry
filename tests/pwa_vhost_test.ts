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
