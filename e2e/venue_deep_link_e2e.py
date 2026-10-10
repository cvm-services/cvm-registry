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

The dashboard leg is HERMETIC: `tools/run-e2e.mjs` provisions `site/catalog.json`
from the committed capture (`fixtures/e2e-dashboard.catalog.json`) and serves
`site/` on loopback, so this script never needs a relay, a collector or the live
origin. Only the CLICK-THROUGH to each venue's own page needs the open network:
when the venues cannot be reached, `--skip-venue-pages` keeps every dashboard and
deep-link assertion (the href is read from the rendered DOM) and says out loud
that the click-through was NOT verified.

Two things this script will NOT do, both learned from real runs:

- It will not call a Cloudflare interstitial a verified venue page. A challenge
  answers HTTP 200 at the venue's own URL with the title "Just a moment..."; that
  is recorded as `challenged: true` and printed as NOT VERIFIED, because a leg
  that reports PASS while the venue's page never loaded is worse than a loud fail.
- It will not fail the run because an mp4 could not be muxed. The mp4 is a
  convenience for a human reader, and Playwright's bundled ffmpeg is a trimmed
  build that rejects `-movflags` (this killed the `e2e` job in ngit CI at
  34209ac). The transcode is best-effort and degrades with a warning.

Run:  e2e/venue_deep_link_e2e.py [--headless|--headed] [--skip-venue-pages] [--catalog PATH]
Env:  E2E_BASE_URL (default http://127.0.0.1:8099)
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
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

# A Cloudflare interstitial answers HTTP 200 at the venue's own URL with the title
# "Just a moment...". ONE definition, imported by tools/capture_venue_page.py, so a
# single-venue re-shoot classifies a page exactly as this leg does. (The JS runner
# carries the same pattern for its curl probe; both are asserted by hand against
# the same five titles documented in docs/e2e/README.md.)
CHALLENGE_RE = re.compile(
    r"just a moment|attention required|checking your browser|cf-chl", re.I
)


def log(msg: str) -> None:
    print(f"[e2e] {msg}", flush=True)


def repo_rel(p: pathlib.Path) -> str:
    """Path as written in committed evidence: repo-relative when it lives in the
    repo, otherwise the path as given. Keeps home paths out of the record."""
    try:
        return str(pathlib.Path(p).resolve().relative_to(ROOT))
    except ValueError:
        return str(p)


def resolve_channel() -> str | None:
    """The Playwright `channel` to launch, or None for the bundled Chromium.

    Only a real Google Chrome qualifies for channel="chrome" — a binary named
    `chromium` is not that channel, and asking for it makes Playwright fail with
    "Chromium distribution 'chrome' is not found" instead of falling back.
    E2E_BROWSER_CHANNEL pins the choice ("" forces the bundled build).
    """
    if "E2E_BROWSER_CHANNEL" in os.environ:
        return os.environ["E2E_BROWSER_CHANNEL"] or None
    for name in ("google-chrome", "google-chrome-stable"):
        if shutil.which(name):
            return "chrome"
    return None


def video_kwargs(video_dir: pathlib.Path) -> dict:
    """`record_video_dir` only when Playwright's OWN ffmpeg is present.

    A context that asks for video recording needs the bundled ffmpeg (it is not
    resolved from PATH), and without it page creation dies with
    "Executable doesn't exist at .../ffmpeg-1011/ffmpeg-linux" — a failure that
    looks like a product bug but is a missing encoder. Video is evidence for a
    human, not a correctness assertion, so its absence degrades with a loud
    warning instead of failing the leg.
    """
    if sorted(pathlib.Path.home().glob(".cache/ms-playwright/ffmpeg-*/ffmpeg-linux")):
        return {
            "record_video_dir": str(video_dir),
            "record_video_size": {"width": 1280, "height": 800},
        }
    log("WARN: no Playwright ffmpeg — running WITHOUT video recording; "
        "every dashboard and deep-link assertion still runs in full")
    return {}


def transcode_mp4(webm: pathlib.Path, mp4: pathlib.Path) -> bool:
    """Best-effort webm -> mp4 for human playback. NEVER fatal.

    The system ffmpeg is preferred; Playwright's bundled `ffmpeg-linux` is a
    trimmed build. Asking that build for `-movflags +faststart` makes it exit 8
    ("Unrecognized option 'movflags'") — observed in ngit CI at commit 34209ac,
    where an evidence convenience killed the whole leg and turned the `e2e` job
    red. Try the full command, then the trimmed-build-safe one, and report False
    instead of raising: a missing mp4 is a degraded artifact, not a failure.
    """
    ffmpegs: list[str] = []
    system = shutil.which("ffmpeg")
    if system:
        ffmpegs.append(system)
    ffmpegs += [str(p) for p in sorted(pathlib.Path.home().glob(".cache/ms-playwright/ffmpeg-*/ffmpeg-linux"))]
    base = ["-y", "-loglevel", "error", "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    for ffmpeg in ffmpegs:
        for extra in (["-movflags", "+faststart"], []):
            if mp4.exists():
                mp4.unlink()
            try:
                r = subprocess.run([ffmpeg, *base, *extra, str(mp4)], capture_output=True, text=True)
            except OSError as exc:
                # `which` said it exists and the exec still failed (races, no-exec
                # mount, ENOMEM). This is the same class of accident as a missing
                # binary, and it must not be the one thing that fails the leg.
                log(f"WARN: mp4 transcode could not run {ffmpeg}: {exc.__class__.__name__}: {exc}")
                continue
            if r.returncode == 0 and mp4.exists() and mp4.stat().st_size > 0:
                return True
            tail = (r.stderr or "").strip().splitlines()
            log(f"WARN: mp4 transcode failed with {ffmpeg}{' (+faststart)' if extra else ' (basic)'}: "
                f"{tail[-1] if tail else 'exit ' + str(r.returncode)}")
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true", help="run headed (needs a display / xvfb)")
    ap.add_argument("--skip-venue-pages", action="store_true",
                    help="assert the dashboard + the announced deep-links in the DOM, but do NOT open the "
                         "venues' own pages (they need the open network). Reported as SKIPPED, never as a pass.")
    ap.add_argument("--catalog", default=None,
                    help="catalog path to render (default site/catalog.json; the runner provisions it)")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    video_dir = OUT / "video"
    if video_dir.exists():
        shutil.rmtree(video_dir)
    video_dir.mkdir(parents=True)

    catalog_path = pathlib.Path(args.catalog) if args.catalog else SITE / "catalog.json"
    if not catalog_path.exists():
        log(f"FATAL: {catalog_path} missing — run `npm run e2e` (it provisions the cache), or the collector")
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

    results = {
        # Repo-relative: a committed evidence file must not carry a literal home
        # path (it would not travel to another box, and the fleet gate refuses it).
        "catalog": repo_rel(catalog_path),
        "base": BASE,
        "venue_pages_skipped": bool(args.skip_venue_pages),
        "entries": {},
        "venue_pages": {},
    }

    # Video is optional evidence: `video_kwargs` returns {} when the bundled
    # encoder is absent, so the tail of this script must not then demand a file
    # that was never requested. Computed once, outside the browser block.
    video_opts = video_kwargs(video_dir)

    with sync_playwright() as p:
        # A real browser, not the bundled headless shell: venue sites sit behind
        # Cloudflare and challenge the headless shell. `--headed` under xvfb
        # prefers the system Chrome, which is also what a user actually has.
        #
        # The channel is RESOLVED, not assumed: this used to hardcode
        # channel="chrome" whenever --headed was passed, which is a lie in a CI
        # container (there is no Google Chrome there) and makes the launch fail
        # outright rather than falling back. Say which browser actually ran.
        launch_kwargs: dict = {"headless": not args.headed}
        channel = resolve_channel() if args.headed else None
        if channel:
            launch_kwargs["channel"] = channel
        browser = p.chromium.launch(**launch_kwargs)
        results["browser"] = {
            "headless": not args.headed,
            "how": f"system chrome (channel={channel})" if channel else "playwright chromium",
            "version": browser.version,
        }
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            **video_opts,
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

            if args.skip_venue_pages:
                # The announced URL was verified in the DOM above (this is the real
                # assertion). Opening it needs the open network, so it is SKIPPED
                # loudly and recorded as skipped — never counted as verified.
                log(f"SKIPPED (live network) {slug}: not opening {url} — the venue host is unreachable "
                    f"from this host, so the click-through that lands on it is NOT verified")
                results["venue_pages"][slug] = {
                    "announced_url": url,
                    "skipped": "venue host unreachable from this host at run time",
                }
                continue

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
            # A Cloudflare interstitial answers HTTP 200 with the venue's URL and
            # the title "Just a moment...". Recording that as a verified venue page
            # is exactly the silent green this suite exists to prevent, so it is
            # recorded as CHALLENGED and printed as NOT VERIFIED.
            if CHALLENGE_RE.search(f"{title}\n{body}"):
                log(f"NOT VERIFIED {slug}: the venue's own page was NOT reached — a bot "
                    f"challenge answered instead (title={title!r}); the announced deep-link "
                    f"itself was verified in the dashboard DOM above")
                results["venue_pages"][slug] = {
                    "announced_url": url,
                    "final_url": final_url,
                    "title": title,
                    "challenged": True,
                    "note": "bot challenge (Cloudflare interstitial) — the venue's own page was NOT reached",
                }
                venue_page.close()
                continue
            results["venue_pages"][slug] = {
                "announced_url": url,
                "final_url": final_url,
                "title": title,
                "challenged": False,
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
        # `video_opts` is empty only when the encoder is missing, in which case
        # no video was ever requested — demanding one here would turn an absent
        # evidence artifact into a product failure. Say so in the record instead.
        if video_opts:
            log("FATAL: video recording was requested but no video was produced")
            return 3
        results["video_note"] = (
            "not recorded: this host has no Playwright ffmpeg. The committed "
            "webm/mp4 next to this file are from an earlier full run."
        )
        log("WARN: no video recorded (see video_note in the evidence)")
        (OUT / "venue-discovery-e2e.json").write_text(json.dumps(results, indent=2) + "\n")
        log("wrote docs/e2e/venue-discovery-e2e.json")
        return 0
    final_webm = OUT / "venue-discovery-e2e.webm"
    if final_webm.exists():
        final_webm.unlink()
    shutil.move(str(vids[0]), str(final_webm))
    log(f"video: {final_webm} ({final_webm.stat().st_size} bytes)")
    results["video"] = {
        "webm": repo_rel(final_webm),
        "bytes": final_webm.stat().st_size,
    }

    mp4 = OUT / "venue-discovery-e2e.mp4"
    if transcode_mp4(final_webm, mp4):
        log(f"mp4: {mp4} ({mp4.stat().st_size} bytes)")
        results["video"]["mp4"] = {"mp4": repo_rel(mp4), "bytes": mp4.stat().st_size}
    else:
        # The mp4 is a convenience for a human reader; the webm is the evidence.
        # CI has no system ffmpeg, and Playwright's trimmed build cannot mux mp4,
        # so on CI this branch is the normal one and must not fail the leg.
        results["video"]["mp4_note"] = (
            "not produced: no ffmpeg on this host could mux mp4 (Playwright's bundled "
            "build is trimmed). The .webm next to this file is the recorded evidence."
        )
        log("WARN: no mp4 produced (see mp4_note in the evidence) — the .webm is the evidence")

    (OUT / "venue-discovery-e2e.json").write_text(json.dumps(results, indent=2) + "\n")
    log("wrote docs/e2e/venue-discovery-e2e.json")
    print("\n=== E2E RESULT ===")
    for slug, v in results["venue_pages"].items():
        if v.get("skipped"):
            print(f"{slug}: {v['announced_url']} -> SKIPPED ({v['skipped']}) — the deep-link was "
                  f"verified in the DOM; the venue's own page was NOT opened")
        elif v.get("challenged"):
            print(f"{slug}: {v['announced_url']} -> CHALLENGED (title={v['title']!r}) — the venue's "
                  f"own page was NOT reached")
        else:
            print(f"{slug}: {v['announced_url']} -> HTTP final {v['final_url']} | title={v['title']!r}")
    challenged = [s for s, v in results["venue_pages"].items() if v.get("challenged")]
    if results["venue_pages_skipped"]:
        print("NOTE: the venue click-through was SKIPPED — this run does NOT prove the venues' own pages open.")
    elif challenged:
        print(f"NOTE: {' and '.join(challenged)} answered with a bot challenge — this run does NOT "
              f"prove that venue's own page opens. The deep-links themselves WERE verified in the DOM.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
