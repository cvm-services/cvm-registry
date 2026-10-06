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

        # R2: reviews must actually be on the card, with a rating, and the block
        # must say it is unranked. A review feature whose reviews do not render is
        # indistinguishable from no review feature at all.
        review_counts = {}
        for slug in VENUES:
            rcard = page.locator("article.card", has_text=slug).first
            block = rcard.locator("div.reviews")
            assert block.count() == 1, f"{slug}: no reviews block on the card"
            items = block.locator("li.review")
            review_counts[slug] = items.count()
            log(f"card {slug}: {items.count()} review(s) rendered")
            for i in range(items.count()):
                item = items.nth(i)
                head = item.locator("span.rating").first.inner_text()
                body = item.locator("p.review-body").first.inner_text()
                assert head.endswith("/5") or head == "unrated", f"{slug}: odd rating badge '{head}'"
                assert len(body) > 0, f"{slug}: review with empty body"
            note = block.locator("p.muted").first.inner_text()
            assert "unranked" in note, f"{slug}: the block must state it is unranked, got '{note}'"
        assert sum(review_counts.values()) >= 2, f"expected >=2 reviews rendered, got {review_counts}"

        # R3: assert the no-ranking claim from the RENDERED DOM, not from the
        # collector's JSON. On the venue that has two reviews, the older one has
        # far more sats behind it and must still render LAST.
        two_review_slug = next((s for s, n in review_counts.items() if n >= 2), None)
        if two_review_slug:
            rows = page.locator(
                f"article.card:has-text('{two_review_slug}') li.review"
            )
            stamps = [int(rows.nth(i).get_attribute("data-created-at")) for i in range(rows.count())]
            sats = [int(rows.nth(i).get_attribute("data-zap-sats")) for i in range(rows.count())]
            log(f"{two_review_slug}: created_at={stamps} zap_sats={sats} (rendered order)")
            assert stamps == sorted(stamps, reverse=True), f"reviews are not newest-first: {stamps}"
            if max(sats) > 0 and sats[0] != max(sats):
                log(f"{two_review_slug}: richest review ({max(sats)} sats) renders at index "
                    f"{sats.index(max(sats))}, NOT first — zaps did not promote it")
            else:
                log(f"{two_review_slug}: WARNING — the richest review is first, which does not "
                    f"demonstrate non-promotion with this data")
            zap_lines = page.locator("article.card p.zaps")
            assert zap_lines.count() >= 1, "expected at least one zap line rendered"
            first_zap = zap_lines.first.inner_text()
            assert "spend signal" in first_zap, f"zap line must be labelled: '{first_zap}'"

        # R4a: exactly ONE review carries the venue-confirmed badge — the one the
        # venue actually vouched for. A badge on both reviews of the same venue
        # would mean the author check is not doing anything.
        badges = page.locator("article.card li.review span.badge.venue-confirmed")
        n_badges = badges.count()
        confirmed_rows = page.locator("article.card li.review[data-attestation='venue-signed']")
        n_confirmed = confirmed_rows.count()
        total_rows = page.locator("article.card li.review").count()
        log(f"venue-confirmed badges={n_badges} confirmed rows={n_confirmed} of {total_rows} review rows")
        assert n_badges == 1, f"expected exactly 1 venue-confirmed badge, got {n_badges}"
        assert n_confirmed == 1, f"expected exactly 1 confirmed review row, got {n_confirmed}"
        assert total_rows > 1, "need more than one review to show the badge is discriminating"
        note = page.locator("article.card li.review[data-attestation='venue-signed'] p.attestation-note").first.inner_text()
        log(f"badge note: {note}")
        assert "not proof" in note, f"the badge must state its limit, got '{note}'"
        assert "verified visit" not in note.lower(), "the badge must not overclaim"
        page.screenshot(path=str(OUT / "04-review-venue-confirmed.png"), full_page=True)

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
