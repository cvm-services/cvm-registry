// stack.mjs — start the whole local stack the happy path runs against.
//
//   stub mint   (deno)          a NUT-04 quote server, with /__test/* controls
//   cvm-orders  (deno)          the REAL service, from its own repo
//   site        (this process)  the static /order/ app + the /api reverse proxy
//
// The mint is stubbed — the one thing the test may not do is pay real sats.
// Everything else is real: cvm-orders is the actual main.ts from
// cvm-services/cvm-orders, and the site is the actual site/ tree of this repo.
// Nothing is mocked at the HTTP boundary the browser talks to.
//
// cvm-orders is resolved in this order, so a fresh clone of this repo runs the
// suite with no setup:
//   1. CVM_ORDERS_DIR           an explicit checkout (the dev loop)
//   2. .cache/cvm-orders        a shallow clone of main, cached between runs
// (gitignored). CVM_ORDERS_REF / CVM_ORDERS_URL override what is cloned.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { startSiteServer } from "./site-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** e2e/order-pwa/harness -> the repo root. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

const ORDERS_URL = process.env.CVM_ORDERS_URL ?? "https://github.com/cvm-services/cvm-orders.git";
const ORDERS_REF = process.env.CVM_ORDERS_REF ?? "main";
/** 0.0.0.0 is not an option: the service itself refuses to bind wide by default. */
const LOOPBACK = "127.0.0.1";
const DENO = process.env.DENO_BIN ?? "deno";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Run a command to completion. Used for git and for the npm warm-up. */
function run(cmd, args, { cwd, env } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (error) => done({ code: -1, out: String(error) }));
    child.on("close", (code) => done({ code, out }));
  });
}

async function freePort() {
  return await new Promise((done, fail) => {
    const probe = net.createServer();
    probe.on("error", fail);
    probe.listen(0, LOOPBACK, () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
}

/**
 * Resolve the cvm-orders checkout to run, and which commit it is on. The commit
 * is reported in the test output: the suite asserts exact sats, so a repo that
 * drifts from the committed catalog must be visible, not guessed at.
 */
async function resolveOrders(explicitDir) {
  const wanted = explicitDir ?? process.env.CVM_ORDERS_DIR;
  if (wanted) {
    const dir = resolve(wanted);
    if (!existsSync(join(dir, "main.ts"))) {
      throw new Error(`CVM_ORDERS_DIR=${dir} has no main.ts`);
    }
    const rev = await run("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
    return { dir, commit: rev.code === 0 ? rev.out.trim() : "unknown", source: "CVM_ORDERS_DIR" };
  }

  const cache = join(REPO_ROOT, ".cache", "cvm-orders");
  if (!existsSync(join(cache, ".git"))) {
    mkdirSync(dirname(cache), { recursive: true });
    const cloned = await run("git", [
      "clone", "--quiet", "--depth", "1", "--branch", ORDERS_REF, ORDERS_URL, cache,
    ]);
    if (cloned.code !== 0) {
      throw new Error(
        `could not clone ${ORDERS_URL} (ref ${ORDERS_REF}) into ${cache}:\n${cloned.out}\n` +
          `Set CVM_ORDERS_DIR=<cvm-orders checkout> to run without network.`,
      );
    }
  } else {
    const fetched = await run("git", ["-C", cache, "fetch", "--quiet", "--depth", "1", "origin", ORDERS_REF]);
    if (fetched.code === 0) await run("git", ["-C", cache, "reset", "--quiet", "--hard", "FETCH_HEAD"]);
  }
  const rev = await run("git", ["-C", cache, "rev-parse", "--short", "HEAD"]);
  return { dir: cache, commit: rev.code === 0 ? rev.out.trim() : "unknown", source: `clone of ${ORDERS_REF}` };
}

/** Spawn a long-lived child and wait until `ready` answers 2xx. */
async function startChild(label, cmd, args, { cwd, env, ready, timeoutMs = 45_000 } = {}) {
  const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  const record = (chunk) => {
    const text = String(chunk);
    log.push(text);
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${label}] ${text}`);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));

  const stop = () =>
    new Promise((done) => {
      if (exited) return done();
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 3000).unref?.();
    });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `${label} exited (code ${exited.code}${exited.signal ? `, ${exited.signal}` : ""}) before it was ready:\n${log.join("")}`,
      );
    }
    try {
      const res = await fetch(ready);
      if (res.ok) return { child, log, stop };
      await res.body?.cancel?.();
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  await stop();
  throw new Error(`${label} never became ready at ${ready} (${timeoutMs}ms):\n${log.join("")}`);
}

/**
 * Start the stack. Returns handles the spec (and a human, at a REPL) drives it
 * with: urls, the facilitator key, and the two control surfaces the test needs —
 * settle/expire on the mint, and signed transitions on the service.
 */
export async function startStack({ repoRoot = REPO_ROOT, ordersDir } = {}) {
  const orders = await resolveOrders(ordersDir);
  const facilitatorSecret = generateSecretKey();
  const facilitatorPubkey = getPublicKey(facilitatorSecret);

  const mintPort = await freePort();
  const ordersPort = await freePort();
  const mintUrl = `http://${LOOPBACK}:${mintPort}`;
  const ordersUrl = `http://${LOOPBACK}:${ordersPort}`;

  const children = [];
  let site;
  try {
    children.push(
      await startChild(
        "stub-mint",
        DENO,
        ["run", "--allow-net", "--allow-env", "--allow-read", join(HERE, "stub_mint.ts")],
        { env: { ...process.env, STUB_MINT_PORT: String(mintPort) }, ready: `${mintUrl}/__test/health` },
      ),
    );

    // Warm the npm:qrcode module the service imports lazily on the first
    // invoice, so a cold npm download is not mistaken for a slow rail.
    await run(DENO, ["eval", "--config", "deno.json", 'await import("npm:qrcode@1.5.4");'], {
      cwd: orders.dir,
    });

    children.push(
      await startChild(
        "cvm-orders",
        DENO,
        ["run", "--allow-net", "--allow-env", "--allow-read", join(orders.dir, "main.ts")],
        {
          cwd: orders.dir,
          env: {
            ...process.env,
            PORT: String(ordersPort),
            BIND_ADDR: LOOPBACK,
            // The one substitution: the mint is local. Nothing else about the
            // service changes, so every fail-closed rule of its own still applies.
            CASHU_MINT_URL: mintUrl,
            FACILITATOR_NPUB: facilitatorPubkey,
          },
          ready: `${ordersUrl}/health`,
        },
      ),
    );

    site = await startSiteServer({ repoRoot, ordersUrl });
  } catch (error) {
    await site?.close();
    for (const child of [...children].reverse()) await child.stop();
    throw error;
  }

  /** A fresh challenge-bound NIP-98 credential. Single-use: one per request. */
  async function authHeader() {
    const url = `${site.url}/api/auth/challenge`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`challenge endpoint answered ${res.status}`);
    const { nonce } = await res.json();
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["u", url],
          ["method", "GET"],
          ["payload", createHash("sha256").update(String(nonce)).digest("hex")],
        ],
        content: "",
      },
      facilitatorSecret,
    );
    return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
  }

  const readJson = async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return {
    site: site.url,
    orders: ordersUrl,
    mint: mintUrl,
    facilitatorPubkey,
    ordersCommit: orders.commit,
    ordersSource: orders.source,

    mintQuotes: async () => (await readJson(`${mintUrl}/__test/quotes`)).body ?? [],
    settle: async (quote) => await readJson(`${mintUrl}/__test/settle/${quote}`, { method: "POST" }),
    expire: async (quote) => await readJson(`${mintUrl}/__test/expire/${quote}`, { method: "POST" }),

    /** Read the order straight from the service — no proxy, no browser. */
    readOrder: async (id) => await readJson(`${ordersUrl}/orders/${id}`),
    readInvoice: async (id) => await readJson(`${ordersUrl}/orders/${id}/invoice`),

    /**
     * Facilitator work, exactly as the console does it: a NIP-98 signed POST on
     * the site origin, so it crosses the /api proxy like any other client.
     */
    transition: async (id, state) =>
      await readJson(`${site.url}/api/orders/${id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: await authHeader() },
        body: JSON.stringify({ state }),
      }),

    /** Poll the service until the order reaches `state` (or give up, loudly). */
    waitForState: async (id, state, { timeoutMs = 20_000 } = {}) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await readJson(`${ordersUrl}/orders/${id}`);
        if (last.body?.state === state) return last;
        await sleep(150);
      }
      throw new Error(`order ${id} never reached ${state}; last read: ${JSON.stringify(last)}`);
    },

    stop: async () => {
      await site.close();
      for (const child of [...children].reverse()) await child.stop();
    },
  };
}
