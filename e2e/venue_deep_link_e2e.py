#!/usr/bin/env python3
"""Hermetic end-to-end evidence run: announcement -> relay -> collector ->
dashboard -> the venue's own ordering page.

What this actually exercises (no mocks on the CVM path):

  venue.json
    -> tools/emit-venue-announcement.ts   (signed kind 11317, one key per venue)
    -> strfry relay on 127.0.0.1:7781     (plain relay, no NIP-29 write policy)
    -> collector/collect.ts               (allow-list applied, fail-closed)
    -> site/catalog.json                  (static cache)
    -> site/index.html in a real browser  (this file)
    -> click the venue's `r` deep-link    (opens the venue's real site)

Honest scope: there is NO ContextVM/MCP server call and NO ring proof in this
flow. The announcement declares a tool; the ordering rail is the venue's own
page. Absences are labelled, not faked.

Run:  e2e/venue_deep_link_e2e.py [--headless|--headed]
Env:  E2E_BASE_URL (default http://127.0.0.1:8099)
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs" / "e2e"
BASE = os.environ.get("E2E_BASE_URL", "http://127.0.0.1:8099")

# slug -> the venue's own ordering rail (must equal the `r` tag in the announcement)
VENUES = {
    "doppelt-kaese-berlin": "https://www.doppelt-kaese-berlin.de/speisekarte/doppeltkase",
    "pizza-e-pasta-ruedesheimerplatz": "https://pizzaepasta-ruedesheimerplatz.de/pizza-e-pasta/takeaway",
}


def log(msg: str) -> None:
    print(f"[e2e] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true", help="run headed (needs a display / xvfb)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    video_dir = OUT / "video"
    if video_dir.exists():
        shutil.rmtree(video_dir)
    video_dir.mkdir(parents=True)

    catalog_path = SITE / "catalog.json"
    if not catalog_path.exists():
        log(f"FATAL: {catalog_path} missing — run the collector first")
        return 2
    catalog = json.loads(catalog_path.read_text())
    entries = {e["d"]: e for e in catalog.get("entries", [])}
    log(f"catalog: {len(entries)} entries, generated_at_iso={catalog.get('generated_at_iso')}")
    log(f"allowlist: {[c['npub'][:16] for c in catalog['allowlist']['curators']]}")

    for slug, url in VENUES.items():
        if slug not in entries:
            log(f"FATAL: {slug} not in the catalog — the collector dropped it")
            return 2
        got = entries[slug].get("links") or []
        if got != [url]:
            log(f"FATAL: {slug} deep-link mismatch: {got} != [{url}]")
            return 2
        log(f"OK {slug}: r-published={got[0]}")

    results = {"catalog": str(catalog_path), "entries": {}, "venue_pages": {}}

    with sync_playwright() as p:
        # A real browser, not the bundled headless shell: venue sites sit behind
        # Cloudflare and challenge the headless shell. `--headed` under xvfb uses
        # the system Chrome, which is also what a user actually has.
        launch_kwargs: dict = {"headless": not args.headed}
        if args.headed:
            launch_kwargs["channel"] = "chrome"
        browser = p.chromium.launch(**launch_kwargs)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            record_video_dir=str(video_dir),
            record_video_size={"width": 1280, "height": 800},
        )
        page = ctx.new_page()
        page.set_default_timeout(30_000)

        log(f"goto {BASE}/")
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_selector("article.card", timeout=20_000)
        page.wait_for_timeout(1500)

        cards = page.locator("article.card")
        n = cards.count()
        log(f"dashboard rendered {n} card(s)")
        assert n == 2, f"expected 2 venue cards, got {n}"

        summary_text = page.locator("p.summary").first.inner_text()
        log(f"summary line: {summary_text}")

        page.screenshot(path=str(OUT / "01-dashboard-two-venues.png"), full_page=True)

        for idx, (slug, url) in enumerate(VENUES.items(), start=2):
            card = page.locator("article.card", has_text=slug).first
            assert card.count() == 1, f"card for {slug} not found"
            # scroll the card into view so the video shows the click
            card.scroll_into_view_if_needed()
            page.wait_for_timeout(800)
            link = card.locator("a.deep-link").first
            href = link.get_attribute("href")
            log(f"card {slug}: deep-link href={href}")
            assert href == url, f"{slug}: rendered href {href} != announced {url}"
            page.screenshot(path=str(OUT / f"0{idx}-card-{slug}.png"))

            with ctx.expect_page() as new_page_info:
                link.click()
            venue_page = new_page_info.value
            venue_page.set_default_timeout(45_000)
            venue_page.wait_for_load_state("domcontentloaded")
            venue_page.wait_for_timeout(12000)
            title = venue_page.title()
            final_url = venue_page.url
            body = (venue_page.inner_text("body") or "")[:4000]
            log(f"venue page: title={title!r} url={final_url}")
            venue_page.screenshot(path=str(OUT / f"0{idx}b-venue-page-{slug}.png"), full_page=False)
            results["venue_pages"][slug] = {
                "announced_url": url,
                "final_url": final_url,
                "title": title,
                "body_head": body[:600],
            }
            venue_page.close()

        results["entries"] = {
            slug: {
                "event_id": e.get("event_id"),
                "pubkey": e.get("pubkey"),
                "npub": e.get("npub"),
                "tier": e.get("tier"),
                "links": e.get("links"),
                "classes": e.get("classes"),
                "geohashes": e.get("geohashes"),
            }
            for slug, e in entries.items()
        }

        ctx.close()  # finalises the video file
        browser.close()

    vids = sorted(video_dir.glob("*.webm"))
    if not vids:
        log("FATAL: no video produced")
        return 3
    final_webm = OUT / "venue-discovery-e2e.webm"
    if final_webm.exists():
        final_webm.unlink()
    shutil.move(str(vids[0]), str(final_webm))
    log(f"video: {final_webm} ({final_webm.stat().st_size} bytes)")

    mp4 = OUT / "venue-discovery-e2e.mp4"
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        cand = sorted(pathlib.Path.home().glob(".cache/ms-playwright/ffmpeg-*/ffmpeg-linux"))
        if cand:
            ffmpeg = str(cand[-1])
    if ffmpeg:
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(final_webm),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)],
            check=True,
        )
        log(f"mp4: {mp4} ({mp4.stat().st_size} bytes)")
    else:
        log("WARN: no ffmpeg found — leaving the .webm only")

    (OUT / "venue-discovery-e2e.json").write_text(json.dumps(results, indent=2) + "\n")
    log("wrote docs/e2e/venue-discovery-e2e.json")
    print("\n=== E2E RESULT ===")
    for slug, v in results["venue_pages"].items():
        print(f"{slug}: {v['announced_url']} -> HTTP final {v['final_url']} | title={v['title']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
