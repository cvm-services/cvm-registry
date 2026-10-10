// site-server.mjs - the static site under test, plus the `/api` reverse proxy.
//
// It is a path map, not a copy: the same mapping deploy/deploy-pwa.sh publishes
// into /opt/tollgate/cvm-pwa, which deploy/caddy-vhost-cvm-pwa.caddy then serves
// from a single root. Mirrored here so the browser talks to one origin and the
// PWA's relative fetches (../menu.json, ../../vocab/service-inputs.json) resolve
// exactly as they do in production.
//
//   /api/*       -> cvm-orders, with the /api prefix stripped (handle_path)
//   /menu.json   -> site/menu.json
//   /order/*     -> site/order/*      (falls back to /order/index.html)
//   /console/*   -> site/console/*    (falls back to /console/index.html)
//   /vocab/*     -> vocab/*
//   /fixtures/*  -> site/fixtures/*
//
// Cache-Control: no-store, like the vhost: the browser must never cache a spec
// run's HTML or worker and then serve it to the next run.
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
};

const contentType = (file) => TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/** Try a URL path inside a directory, refusing anything that escapes it. */
function fileIn(dir, rest) {
  const rel = normalize(decodeURIComponent(rest)).replace(/^([/\\])+/, "");
  const candidate = resolve(dir, rel);
  if (candidate !== resolve(dir) && !candidate.startsWith(resolve(dir) + sep)) return null;
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function startSiteServer({ repoRoot, ordersUrl, port = 0 }) {
  const SITE = join(repoRoot, "site");
  const roots = [
    { prefix: "/order/", dir: join(SITE, "order"), fallback: "index.html" },
    { prefix: "/console/", dir: join(SITE, "console"), fallback: "index.html" },
    { prefix: "/vocab/", dir: join(repoRoot, "vocab") },
    { prefix: "/fixtures/", dir: join(SITE, "fixtures") },
  ];
  const aliases = { "/menu.json": join(SITE, "menu.json") };
  const spaFallback = join(SITE, "order", "index.html");

  function staticFile(pathname) {
    const alias = aliases[pathname];
    if (alias) {
      try {
        if (statSync(alias).isFile()) return alias;
      } catch {
        return null;
      }
    }
    const root = roots.find((r) => pathname.startsWith(r.prefix));
    if (root) {
      const hit = fileIn(root.dir, pathname.slice(root.prefix.length)) ?? fileIn(root.dir, pathname);
      if (hit) return hit;
      if (root.fallback) {
        const fallback = fileIn(root.dir, root.fallback);
        if (fallback) return fallback;
      }
    }
    // Caddy's `try_files {path} /order/index.html`.
    return fileIn(SITE, join("order", "index.html")) ?? spaFallback;
  }

  function serveFile(req, res, file) {
    const headers = {
      "content-type": contentType(file),
      "cache-control": "no-store",
      "content-length": String(statSync(file).size),
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  function proxy(req, res, url) {
    const target = new URL(ordersUrl);
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: url.pathname.slice("/api".length) + url.search,
        method: req.method,
        headers: { ...req.headers, host: req.headers.host ?? target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, "cache-control": "no-store" });
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      // Mirrors the vhost's handle_errors: a down service is a real JSON error,
      // never an HTML 200 the client would choke on.
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "order service unavailable", detail: String(error.message) }));
    });
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return proxy(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "method not allowed" }));
    }
    const file = staticFile(url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "not found", path: url.pathname }));
    }
    return serveFile(req, res, file);
  });

  return new Promise((resolveListen, rejectListen) => {
    server.on("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolveListen({
        url: `http://127.0.0.1:${bound}`,
        port: bound,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
