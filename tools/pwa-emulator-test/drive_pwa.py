#!/usr/bin/env python3
"""Drive the customer PWA in a headless Android emulator and capture evidence.

WHY uiautomator2 and not `adb shell input tap`: measured 2026-10-09 (run 172 and
again for the PWA) - synthetic taps/keyevents do NOT dismiss Chrome's first-run
dialogs on a headless guest, and they never focus an EditText (the skill
`android-emulator-rail` documents this as pitfall #7). An accessibility .click()
through uiautomator2 works first try. Do not "simplify" this back to `input tap`.

Chrome also re-shows its first-run experience on every fresh launch, so this
driver clears the whole dialog chain BEFORE navigating, then walks the screens.

Usage:
    drive_pwa.py --url http://HOST:PORT/site/order/ --out ./artifacts
"""
from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

import uiautomator2 as u2

# Every first-run / permission dialog label we have actually seen on the
# android-34 google_apis_playstore image. Checked in order, repeatedly.
DIALOG_LABELS = [
    "Stay signed out", "No thanks", "Skip", "Got it", "Not now",
    "Continue", "Accept & continue", "Don't allow", "Deny",
]

# Screen walk: (tag, list of selectors to try in order)
WALK = [
    ("2-menu",  ["Pizza e Pasta", "Burger", "Doppelt"]),
    ("3-item",  ["Pizza Margherita", "Cheeseburger", "Pizza"]),
    ("4-basket", ["Add to basket", "Add", "In den Warenkorb"]),
]


def clear_dialogs(d, rounds: int = 8) -> list[str]:
    """Dismiss the chain of first-run dialogs. Returns the labels clicked."""
    clicked = []
    for _ in range(rounds):
        time.sleep(3)
        try:
            xml = d.dump_hierarchy()
        except Exception as exc:  # device gone mid-run
            print(f"[drive] dump failed: {exc}")
            return clicked
        hit = next((lab for lab in DIALOG_LABELS if f'text="{lab}"' in xml), None)
        if not hit:
            break
        try:
            d(text=hit).click()
            clicked.append(hit)
            print(f"[drive] dismissed: {hit}")
        except Exception as exc:
            print(f"[drive] could not click {hit}: {exc}")
            break
    return clicked


def snap(d, tag: str, out: Path) -> list[str]:
    time.sleep(3)
    try:
        xml = d.dump_hierarchy()
    except Exception:
        xml = ""
    texts = re.findall(r'text="([^"]{2,80})"', xml)
    shot = out / f"pwa-{tag}.png"
    try:
        d.screenshot(str(shot))
    except Exception as exc:
        print(f"[drive] screenshot failed: {exc}")
    print(f"[{tag}] {' | '.join(texts[:12])}")
    return texts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default="artifacts")
    ap.add_argument("--serial", default=None)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    d = u2.connect(args.serial) if args.serial else u2.connect()
    d.settings["wait_timeout"] = 8.0
    print(f"[drive] device={d.info.get('productName')} size={d.window_size()}")

    d.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", args.url])
    clear_dialogs(d)
    # launch again now the dialogs are gone - the first launch was eaten by them
    d.shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", args.url])
    clear_dialogs(d)
    snap(d, "1-venues", out)

    for tag, selectors in WALK:
        for sel in selectors:
            try:
                el = d(textContains=sel)
                if el.exists:
                    el.click()
                    print(f"[drive] {tag}: clicked {sel!r}")
                    break
            except Exception:
                pass
        snap(d, tag, out)

    print(f"[drive] screenshots in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
