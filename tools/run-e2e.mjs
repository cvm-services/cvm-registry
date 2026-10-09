import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME, ".cache", "ms-playwright");
const hasChromium = existsSync(browserRoot) && (() => {
  try { return execFileSync("find", [browserRoot, "-maxdepth", "4", "-type", "f", "-name", "chrome", "-print", "-quit"], { encoding: "utf8" }).trim() !== ""; }
  catch { return false; }
})();
const systemChrome = ["google-chrome", "chromium", "chromium-browser"].find((name) => {
  try { execFileSync("which", [name], { stdio: "ignore" }); return true; } catch { return false; }
});
if (!hasChromium && !systemChrome) {
  console.log("[e2e] Playwright Chromium is missing; installing the pinned browser build");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], { cwd: root, stdio: "inherit" });
}

const run = (label, command, args) => {
  console.log(`[e2e] running ${label}`);
  const actual = label === "dashboard-discovery.mjs" ? "xvfb-run" : command;
  const actualArgs = label === "dashboard-discovery.mjs" ? ["-a", command, ...args] : args;
  const result = spawnSync(actual, actualArgs, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
};
const skipLive = (label, reason) => console.log(`[e2e] SKIPPED — ${label}: ${reason}. This is an explicit network skip, not a pass.`);

  run("catalog_render_e2e.mjs", process.execPath, ["e2e/catalog_render_e2e.mjs"]);
const live = spawnSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", "https://cvm.orangesync.tech/"], { cwd: root, stdio: "ignore" }).status === 0;
if (live) {
  run("dashboard-discovery.mjs", process.execPath, ["e2e/dashboard-discovery.mjs"]);
  run("live_deploy_check.mjs", process.execPath, ["e2e/live_deploy_check.mjs"]);
} else {
  skipLive("dashboard-discovery.mjs", "cvm.orangesync.tech is unreachable");
  skipLive("live_deploy_check.mjs", "cvm.orangesync.tech is unreachable");
}
const python = process.env.PYTHON || "python3";
if (live) {
  if (spawnSync(python, ["-c", "import playwright"], { stdio: "ignore" }).status !== 0) {
    console.log("[e2e] Python Playwright is missing; installing the pinned package");
    run("pip install", python, ["-m", "pip", "install", "--user", "--break-system-packages", "--requirement", "requirements-e2e.txt"]);
  }
  run("venue_deep_link_e2e.py", python, ["e2e/venue_deep_link_e2e.py"]);
} else {
  skipLive("venue_deep_link_e2e.py", "live dashboard is unreachable");
}
