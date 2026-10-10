// tools/run-e2e.mjs — the ONE entry point for the cvm-registry browser e2e suite.
//
// Why this file exists. The four e2e scripts are real — they drive a real browser
// against real bytes — but until now nothing declared the Playwright dependency
// (a clean checkout died with ERR_MODULE_NOT_FOUND), and the fourth script needs
// a dashboard cache that nothing produced. This runner fixes both and gives the
// suite a single, reportable outcome:
//
//   1. makes sure a browser exists (Playwright's Chromium, or the system Chrome);
//   2. PROVISIONS the dashboard cache from the committed capture
//      (fixtures/e2e-dashboard.catalog.json) and serves site/ on loopback, so the
//      offline legs have a real dashboard to render — no strfry relay, no live
//      collector, no network;
//   3. runs the four scripts and prints a PASS/FAIL/SKIP table.
//
// A SKIP is never a pass. Skipped legs are printed in a loud banner, counted in
// the summary, and exit 3 (unless E2E_ALLOW_SKIP=1, which only the operator
// should set). Exit 0 means: every leg ran and passed. That is the failure mode
// this runner exists to kill — a "skipped" test that reports success.
//
// Usage:
//   npm run e2e            # all legs
//   npm run e2e:hermetic   # the two offline legs only
//   npm run e2e:live       # the two live-network legs only
//
// Env:
//   E2E_ALLOW_SKIP=1     downgrade skips from exit 3 to a loud non-fatal warning
//   E2E_VENUE_PAGES=1    attempt the click-through to the venues' own pages even
//                        without a headed browser (both are Cloudflare-gated)
//   E2E_LIVE_URL         live dashboard origin (default https://cvm.orangesync.tech)
//   E2E_LOCAL_PORT       loopback port for the provisioned dashboard (default 8099)
//   E2E_CHROMIUM         explicit Chromium binary (honoured by the child scripts)
//   PYTHON               Python interpreter that should have Playwright
//   PLAYWRIGHT_BROWSERS_PATH  honour Playwright's browser cache override

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const SITE = join(ROOT, "site");
const SCRATCH = join(ROOT, ".scratch");
const FIXTURE_CATALOG = join(ROOT, "fixtures", "e2e-dashboard.catalog.json");
const LOCAL_PORT = Number(process.env.E2E_LOCAL_PORT ?? 8099);
const LIVE_BASE = (process.env.E2E_LIVE_URL ?? "https://cvm.orangesync.tech").replace(/\/+$/, "");
const ONLY = (process.argv[2] ?? "all").replace(/^--/, "");
const ALLOW_SKIP = process.env.E2E_ALLOW_SKIP === "1";

// The two venues the hermetic capture announces. Their pages are opened by the
// dashboard leg; reaching them needs the open network, so the leg says so out
// loud when it cannot.
const VENUE_URLS = [
  "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase",
  "https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway",
];

const results = [];
const say = (msg) => console.log(`[e2e] ${msg}`);
const record = (leg, phase, status, detail = "") => {
  results.push({ leg, phase, status, detail });
  const line = `[e2e] ${status.padEnd(4)} ${phase.padEnd(8)} ${leg}${detail ? ` — ${detail}` : ""}`;
  status === "FAIL" ? console.error(line) : console.log(line);
};

const have = (cmd) => {
  try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; }
};
const curlOk = (url, seconds = 10) =>
  spawnSync("curl", ["--fail", "--silent", "--show-error", "--max-time", String(seconds), "-o", "/dev/null", url], { stdio: "ignore" }).status === 0;

// Run a child WITHOUT blocking the event loop. spawnSync would freeze this
// process — and this process is also the loopback server the child is about to
// fetch the dashboard from, so a synchronous spawn deadlocks the leg it is
// waiting on (observed: Page.goto timed out at 30s against our own server).
// A leg that never returns is the worst failure shape the suite can have: it
// hangs CI until the job's own timeout and leaves no verdict at all. Every leg
// gets a wall-clock cap (E2E_LEG_TIMEOUT seconds, default 300) and a timeout is
// reported as a FAIL with its cause, never as a hang.
const LEG_TIMEOUT = Number(process.env.E2E_LEG_TIMEOUT ?? 300);

// A timeout is its own cause and must read as one in the summary.
const failNote = (r) => (r.timedOut ? `timed out after ${LEG_TIMEOUT}s` : `exit ${r.status}`);

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    // `detached` puts the leg in its own process group so a timeout can kill the
    // WHOLE tree. Killing only the direct child leaves `xvfb-run`'s X server and
    // its Chrome behind, and those orphans then wedge the next run (observed: a
    // kill left 1 Xvfb + 2 chrome-linux alive and the following hermetic run hung
    // forever waiting on them).
    const child = spawn(cmd, args, { stdio: "inherit", detached: true, ...opts });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, LEG_TIMEOUT * 1000);
    const done = (r) => {
      clearTimeout(timer);
      resolveRun(timedOut ? { ...r, status: 124, timedOut: true } : r);
    };
    child.on("error", () => done({ status: 127, signal: null }));
    child.on("exit", (status, signal) => done({ status, signal }));
  });
}

// --------------------------------------------------------------- environment

const systemChrome = ["google-chrome", "chromium", "chromium-browser"].find(have) ?? null;
const xvfbRun = have("xvfb-run") ? "xvfb-run" : null;

function playwrightBrowser() {
  try {
    const out = execFileSync(process.execPath, ["-e", "const{chromium}=require('playwright');process.stdout.write(chromium.executablePath())"], { cwd: ROOT, encoding: "utf8" }).trim();
    return out && existsSync(out) ? out : null;
  } catch { return null; }
}

function ensureBrowser() {
  const bundled = playwrightBrowser();
  if (bundled) { say(`browser: Playwright Chromium at ${bundled.replace(process.env.HOME, "$HOME")}`); return true; }
  if (systemChrome) { say(`browser: no Playwright Chromium; falling back to the system Chrome (${systemChrome})`); return true; }
  // ffmpeg is a SEPARATE install target, not a chromium dependency: a context
  // that asks for recordVideo without it dies at newPage(). The scripts also
  // guard for that, but install it here so the evidence keeps its video.
  say("browser: none found — installing the pinned Playwright Chromium + ffmpeg");
  const r = spawnSync("npx", ["playwright", "install", "chromium", "ffmpeg"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0 || !playwrightBrowser()) {
    say("browser: install failed; the browser legs cannot run");
    return false;
  }
  return true;
}

// The python and npm Playwrights are pinned separately (1.56.0 vs 1.56.1) and
// each resolves its OWN browser revision from its own browsers.json. Reusing a
// browser installed for the other one is a coin flip: when it loses you get an
// "Executable doesn't exist at …/chromium-1234/…" at page creation, which reads
// like a product bug. Install from the interpreter that will drive the browser.
function ensurePythonBrowser(py, key) {
  const marker = join(SCRATCH, `python-browser-${key}.ok`);
  if (existsSync(marker)) return;
  say(`python: provisioning the browser for the ${key} interpreter (its own Playwright revision)`);
  const r = spawnSync(py, ["-m", "playwright", "install", "chromium", "ffmpeg"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) say(`python: browser install failed — the python leg will report it`);
  else writeFileSync(marker, "");
}

function resolvePython() {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  for (const p of candidates) {
    if (spawnSync(p, ["-c", "import playwright"], { stdio: "ignore" }).status === 0) {
      ensurePythonBrowser(p, "system");
      return { cmd: p, note: `${p} (already has Playwright)` };
    }
  }
  const venv = join(SCRATCH, "e2e-venv");
  const venvPy = join(venv, "bin", "python");
  const base = candidates.find((c) => spawnSync(c, ["-c", "import venv"], { stdio: "ignore" }).status === 0);
  if (!base) return null;
  if (!existsSync(venvPy)) {
    say(`python: creating ${venv.replace(ROOT, ".")} and installing requirements-e2e.txt`);
    if (spawnSync(base, ["-m", "venv", venv], { cwd: ROOT, stdio: "inherit" }).status !== 0) return null;
  }
  if (spawnSync(venvPy, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", join(ROOT, "requirements-e2e.txt")], { cwd: ROOT, stdio: "inherit" }).status !== 0) return null;
  if (spawnSync(venvPy, ["-c", "import playwright"], { stdio: "ignore" }).status !== 0) return null;
  ensurePythonBrowser(venvPy, "venv");
  return { cmd: venvPy, note: ".scratch/e2e-venv" };
}

// ------------------------------------------------------- hermetic provisioning

// The committed capture is the replayable artifact (see its _fixture_provenance).
// Its generated_at is re-stamped to the run time: policy.json freshness has
// max_age_seconds=21600, and an honestly-old capture would render the dashboard
// cache EXPIRED with zero cards (fail-closed). Contents are not touched.
function provisionCatalog() {
  if (!existsSync(FIXTURE_CATALOG)) throw new Error(`missing ${FIXTURE_CATALOG.replace(ROOT, ".")}`);
  const cat = JSON.parse(readFileSync(FIXTURE_CATALOG, "utf8"));
  const fixtureStamp = cat.generated_at_iso ?? null;
  const now = Math.floor(Date.now() / 1000);
  cat.generated_at = now;
  cat.generated_at_iso = new Date(now * 1000).toISOString();
  cat.e2e_provisioned = {
    by: "tools/run-e2e.mjs",
    fixture: "fixtures/e2e-dashboard.catalog.json",
    fixture_generated_at_iso: fixtureStamp,
    note: "generated_at re-stamped to the run time so policy.json freshness (max_age_seconds) does not render the cache EXPIRED; entry contents unmodified",
  };
  mkdirSync(SITE, { recursive: true });
  writeFileSync(join(SITE, "catalog.json"), `${JSON.stringify(cat, null, 2)}\n`);
  return { entries: (cat.entries ?? []).length, fixtureStamp };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".webm": "video/webm", ".mp4": "video/mp4" };

function serveDir(dir) {
  return createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    let file = join(dir, rel || "index.html");
    if (!file.startsWith(dir)) { res.writeHead(403).end("no"); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
}

// Bind the loopback server and WAIT until it is actually accepting, then report
// the port. The first version called listen() and immediately spawned the
// browser, which raced the socket and failed with ERR_CONNECTION_REFUSED. If the
// preferred port is taken, fall back to an ephemeral one — a busy port on the
// operator's box must not turn into a test failure.
function listenOnPort(server, port) {
  return new Promise((resolvePort, rejectPort) => {
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && port !== 0) {
        server.removeListener("error", onError);
        say(`port ${port} is busy; falling back to an ephemeral port`);
        listenOnPort(server, 0).then(resolvePort, rejectPort);
      } else {
        rejectPort(err);
      }
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolvePort(server.address().port);
    });
  });
}

// ------------------------------------------------------------------- the legs

async function main() {
  let localBase = null;
  if (!["all", "hermetic", "live"].includes(ONLY)) {
    record(`unknown selector '${ONLY}'`, "suite", "FAIL", "use all | hermetic | live");
    return;
  }

  mkdirSync(SCRATCH, { recursive: true });
  const browserOk = ensureBrowser();

  const hermetic = ONLY !== "live";
  const live = ONLY !== "hermetic";

  // ---- leg 1: the renderer, against its own served fixture (offline)
  if (hermetic && browserOk) {
    const r = await run(process.execPath, ["e2e/catalog_render_e2e.mjs"], { cwd: ROOT });
    record("e2e/catalog_render_e2e.mjs", "hermetic", r.status === 0 ? "PASS" : "FAIL", r.status === 0 ? "served fixture, real browser" : failNote(r));
  } else if (hermetic) {
    record("e2e/catalog_render_e2e.mjs", "hermetic", "FAIL", "no browser available");
  }

  // ---- leg 2: the provisioned dashboard, in a real browser (offline)
  let server = null;
  if (hermetic) {
    try {
      const prov = provisionCatalog();
      say(`provisioned site/catalog.json from the committed capture (${prov.entries} entries; capture was ${prov.fixtureStamp})`);
      server = serveDir(SITE);
      const port = await listenOnPort(server, LOCAL_PORT);
      localBase = `http://127.0.0.1:${port}`;
      say(`serving ${SITE.replace(ROOT, ".")} at ${localBase}`);
    } catch (err) {
      record("site/catalog.json", "hermetic", "FAIL", `cannot provision the dashboard cache: ${err.message}`);
      server = null;
    }
  }

  if (hermetic && server) {
    const py = browserOk ? resolvePython() : null;
    // Headed Chrome under xvfb is the Cloudflare-safe path the capture used; it
    // needs BOTH a display and the system Chrome. Otherwise run headless.
    const headed = Boolean(xvfbRun && systemChrome);

    // `curl` reaching a page is NOT the same as that page being testable: both
    // venue sites sit behind Cloudflare, which answers a bot with HTTP 200 and an
    // interstitial ("Just a moment..."). The headless shell is challenged where
    // headed Chrome is not, so a click-through run under it fails for a reason
    // that has nothing to do with this repo — and CI's own log showed the runner
    // recording pizza's page as `title='Just a moment...'` while calling the leg
    // a PASS. That is the shape of failure this suite exists to kill.
    //
    // So: probe EVERY venue (one clear venue says nothing about the other) and
    // attempt the click-through only when the pages answer cleanly AND we have a
    // browser that can read them — or when E2E_VENUE_PAGES=1 explicitly says to
    // try anyway. The honest default is to verify the deep-link in the rendered
    // DOM and say plainly, and loudly, that the venue's own page was not opened.
    const challenge = /just a moment|attention required|checking your browser|cf-chl/i;
    const probes = VENUE_URLS.map((url) => {
      const reached = spawnSync("curl", ["--fail", "--silent", "--max-time", "10", "-o", "/dev/null", url], { stdio: "ignore" }).status === 0;
      if (!reached) return "unreachable";
      const html = spawnSync("curl", ["--silent", "--max-time", "10", "-L", url], { encoding: "utf8", maxBuffer: 2_000_000 });
      return challenge.test(html.stdout ?? "") ? "challenged" : "clear";
    });
    const wantVenue = process.env.E2E_VENUE_PAGES === "1";
    const pagesClean = probes.every((p) => p === "clear");
    const venueSafe = pagesClean && (headed || wantVenue);
    if (!py) {
      record("e2e/venue_deep_link_e2e.py", "hermetic", "FAIL", "no Python with Playwright (declare it in requirements-e2e.txt)");
    } else {
      const args = ["e2e/venue_deep_link_e2e.py"];
      if (headed) args.push("--headed");
      if (!venueSafe) {
        args.push("--skip-venue-pages");
        const why = !pagesClean
          ? `the venue pages do not answer cleanly from this host (probe: ${probes.join("/")})`
          : `this host has no headed browser (xvfb-run + system Chrome) and the headless shell is Cloudflare-challenged; set E2E_VENUE_PAGES=1 to attempt it anyway`;
        console.log("\n[e2e] ###############################################################");
        console.log("[e2e] # NOT VERIFIED — the venue pages are not opened.            #");
        console.log("[e2e] # The dashboard + the announced deep-link are asserted in   #");
        console.log("[e2e] # the DOM; the click-through to the venue's own page is NOT.#");
        console.log("[e2e] ###############################################################");
        for (const [i, url] of VENUE_URLS.entries()) say(`venue page probe ${i + 1}/${VENUE_URLS.length}: ${probes[i]} — ${url}`);
        say(`venue click-through not attempted: ${why}`);
      }
      const env = { ...process.env, E2E_BASE_URL: localBase };
      const cmd = headed ? xvfbRun : py.cmd;
      const argv = headed ? ["-a", py.cmd, ...args] : args;
      say(`python: ${py.note}; ${headed ? "headed Chrome under xvfb" : "headless"}; base ${localBase}`);
      const r = await run(cmd, argv, { cwd: ROOT, env });
      // Our probe decides whether to ATTEMPT the click-through; the leg's own
      // evidence decides whether it actually happened. Trust the second one: a
      // venue page can answer curl `clear` from this host and still be challenged
      // in the real browser (Cloudflare fingerprints the client, not the bytes),
      // and that is exactly the silent green this suite exists to catch. Without
      // this read-back the leg's own `NOT VERIFIED`/`CHALLENGED` lines go to the
      // child's stdout — which is inherited, so the summary never saw them and
      // reported a clean PASS for a page that never loaded.
      let unverified = venueSafe
        ? null
        : (pagesClean ? "no headed browser" : probes.join("/"));
      if (venueSafe) {
        try {
          const evidence = JSON.parse(readFileSync(join(ROOT, "docs", "e2e", "venue-discovery-e2e.json"), "utf8"));
          const bad = Object.entries(evidence?.venue_pages ?? {})
            .filter(([, v]) => v?.challenged || v?.skipped)
            .map(([slug, v]) => `${slug} (${v?.challenged ? "challenged" : "skipped"})`);
          if (bad.length) unverified = `the leg itself reports ${bad.join(", ")}`;
        } catch {
          // No evidence file: the leg already failed on its own; failNote says why.
        }
      }
      const detail = r.status !== 0
        ? failNote(r)
        : `provisioned dashboard, ${headed ? "headed" : "headless"}` +
          (unverified === null ? "" : `, venue click-through NOT verified (${unverified})`);
      record("e2e/venue_deep_link_e2e.py", "hermetic", r.status === 0 ? "PASS" : "FAIL", detail);
    }
  }

  // ---- legs 3-4: the live origin (network-gated)
  if (live) {
    const liveOk = curlOk(`${LIVE_BASE}/`);
    const legs = [
      // [script, description, needs a display]
      ["e2e/dashboard-discovery.mjs", `live discovery on ${LIVE_BASE}`, true],
      ["e2e/live_deploy_check.mjs", `deployed menus on ${LIVE_BASE}`, false],
    ];
    if (!liveOk) {
      console.log("\n[e2e] ###############################################################");
      console.log("[e2e] # SKIP — the live dashboard is unreachable from this host.   #");
      console.log(`[e2e] # ${LIVE_BASE} did not answer; the live legs are NOT a pass.`);
      console.log("[e2e] ###############################################################\n");
      for (const [leg] of legs) record(leg, "live", "SKIP", `${LIVE_BASE} unreachable`);
    } else if (!browserOk) {
      for (const [leg] of legs) record(leg, "live", "FAIL", "no browser available");
    } else {
      for (const [leg, why, needsDisplay] of legs) {
        if (!existsSync(join(ROOT, leg))) { record(leg, "live", "FAIL", "script missing"); continue; }
        if (needsDisplay && !xvfbRun) {
          record(leg, "live", "SKIP", "headed browser leg needs a display: install xvfb (xvfb-run)");
          continue;
        }
        const useXvfb = needsDisplay && xvfbRun;
        const r = useXvfb
          ? await run(xvfbRun, ["-a", process.execPath, leg], { cwd: ROOT })
          : await run(process.execPath, [leg], { cwd: ROOT });
        record(leg, "live", r.status === 0 ? "PASS" : "FAIL", r.status === 0 ? `${why}${useXvfb ? " (xvfb)" : ""}` : failNote(r));
      }
    }
  }

  if (server) server.close();
}

// -------------------------------------------------------------------- report

function report() {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL");
  const skip = results.filter((r) => r.status === "SKIP");
  // A leg can pass every assertion it ran while a NAMED sub-assertion was not
  // verified (the venue click-through, when the third-party site is behind a bot
  // wall). That is not a skip of the leg and it is not a failure, but it must be
  // visible in the summary itself — otherwise the verdict reads "every leg ran and
  // passed" while a reader who only sees the summary believes the venue pages were
  // opened. Say it here, in the same block as the verdict.
  const partial = results.filter((r) => r.status === "PASS" && /NOT verified/i.test(r.detail ?? ""));
  console.log("\n=== E2E SUMMARY ===");
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.phase.padEnd(8)} ${r.leg}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`  ${pass} passed, ${fail.length} failed, ${skip.length} skipped`);
  for (const r of partial) console.log(`  NOTE: ${r.leg} — a named sub-assertion was NOT verified: ${r.detail}`);
  if (partial.length) console.log(`  NOTE: ${partial.length} leg(s) carried an un-verified sub-assertion; the verdict covers only what ran.`);
  if (fail.length === 0 && skip.length === 0) {
    console.log("  verdict: PASS — every leg ran and passed");
    process.exitCode = 0;
  } else if (fail.length > 0) {
    console.log("  verdict: FAIL — see the failures above");
    process.exitCode = 1;
  } else if (ALLOW_SKIP) {
    console.log("  verdict: INCOMPLETE — legs were SKIPPED (not a pass). E2E_ALLOW_SKIP=1 downgraded this to a warning.");
    process.exitCode = 0;
  } else {
    console.log("  verdict: INCOMPLETE — legs were SKIPPED, and a skip is not a pass. Exit 3.");
    process.exitCode = 3;
  }
}

// main() is async (it waits for the loopback server to accept before spawning a
// browser), so the report cannot sit in a `finally` around a bare call.
main().then(report, (err) => {
  record("runner", "suite", "FAIL", err?.stack ?? String(err));
  report();
});
