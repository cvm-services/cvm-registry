// video.mjs — keep a run's recording as the artifact a human can watch.
//
// Playwright finalises a recording when its context closes, so the only correct
// moment to save it is after close(). The context fixture would close it later
// anyway; doing it here first is what makes the .webm exist in time.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Where evidence lands. Default: docs/e2e/order-pwa/ (committed, next to the suite). */
export function evidenceDir() {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (dir && dir.trim() !== "") {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const fallback = join(process.cwd(), "docs", "e2e", "order-pwa");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Save the page's recording to `target`. Returns the path, or null when the
 * context had no recording (video off) or Playwright refused to finalise it —
 * a missing artifact must not turn a green journey into a red test.
 */
export async function saveVideo(page, target) {
  const video = page.video();
  if (!video) return null;
  try {
    await page.context().close();
  } catch {
    // already gone; saveAs may still have the file
  }
  try {
    await video.saveAs(target);
    return target;
  } catch (error) {
    console.warn(`[e2e] video not saved to ${target}: ${error?.message ?? error}`);
    return null;
  }
}
