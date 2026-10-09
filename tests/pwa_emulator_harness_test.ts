import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const dir = "tools/pwa-emulator-test";
const read = (p: string) => Deno.readTextFileSync(`${dir}/${p}`);

Deno.test("emulator harness ships every piece needed to reproduce", () => {
  for (const f of ["run-pwa-emulator-test.sh", "emu_boot_and_wait.sh", "emu_teardown.sh", "drive_pwa.py", "README.md"]) {
    const st = Deno.statSync(`${dir}/${f}`);
    assert(st.isFile, `${f} exists`);
  }
});

Deno.test("harness keeps the uiautomator2 fix for the synthetic-tap pitfall", () => {
  // adb input tap cannot dismiss Chrome first-run dialogs nor focus EditText on
  // the headless guest; the driver must use accessibility clicks.
  const driver = read("drive_pwa.py");
  assertStringIncludes(driver, "uiautomator2", "driver uses uiautomator2");
  assertStringIncludes(driver, "clear_dialogs", "driver clears the first-run dialog chain");
  const run = read("run-pwa-emulator-test.sh");
  assertStringIncludes(run, "uiautomator2", "runner installs uiautomator2");
});

Deno.test("harness never leaves the guest holding the rail", () => {
  const run = read("run-pwa-emulator-test.sh");
  assertStringIncludes(run, "emu_teardown.sh", "runner tears the guest down");
  assertStringIncludes(run, "--keep", "teardown is opt-out, not opt-in");
  const td = read("emu_teardown.sh");
  assert(!td.includes("-wipe-data"), "teardown must never wipe userdata");
});

Deno.test("deploy ships the files the app actually fetches", () => {
  // app.js fetches ../menu.json and ../../vocab/service-inputs.json relative to
  // /order/. Shipping only order/ leaves the app unable to price or to render
  // its declared inputs.
  const dep = Deno.readTextFileSync("deploy/deploy-pwa.sh");
  assertStringIncludes(dep, "menu.json", "ships menu.json at the path app.js fetches");
  assertStringIncludes(dep, "service-inputs.json", "ships the declared-inputs register");
  assertStringIncludes(dep, "caddy validate", "validates caddy before reload");
});

Deno.test("deploy makes the tree readable by the caddy user", () => {
  // Files present but unreadable by user 'caddy' => every request 403s while the
  // deploy reports success. Observed on the first cvm-pwa deploy.
  const dep = Deno.readTextFileSync("deploy/deploy-pwa.sh");
  assertStringIncludes(dep, "chmod 755", "dirs are traversable");
  assertStringIncludes(dep, "chmod 644", "files are readable");
});

Deno.test("harness guards against the cold-boot Chrome ANR", () => {
  // Driving straight after boot, or onto a stale Chrome, ANRs the browser and
  // renders nothing (observed against the deployed site 2026-10-09).
  const driver = read("drive_pwa.py");
  assertStringIncludes(driver, "force-stop", "Chrome is force-stopped before driving");
  const run = read("run-pwa-emulator-test.sh");
  assertStringIncludes(run, "settling", "runner lets the guest settle after boot");
});

Deno.test("harness can validate a real deployment, not just a local tree", () => {
  const run = Deno.readTextFileSync("tools/pwa-emulator-test/run-pwa-emulator-test.sh");
  assertStringIncludes(run, "--external-url", "external URL mode exists");
  assertStringIncludes(run, "TARGET_URL", "the driven URL is resolved from that mode");
});
