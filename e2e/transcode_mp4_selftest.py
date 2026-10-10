#!/usr/bin/env python3
"""Self-test for transcode_mp4's "NEVER fatal" contract.

Why this file exists. A missing mp4 is evidence for a human, not a correctness
assertion — but the opposite was once true here: on CI, where there is no system
ffmpeg and Playwright's bundled `ffmpeg-linux` is a trimmed build that rejects
`-movflags +faststart` with exit 8, the transcode took the whole e2e job red. The
`e2e` job was failing on an evidence convenience. These cases pin the contract so
that cannot come back, and they run without a browser, a relay or a network:

  1. no ffmpeg anywhere            -> False, no exception
  2. ffmpeg exists but exits 8     -> False, no exception  (the CI shape)
  3. ffmpeg exits 127 / not exec-able -> False, no exception
  4. ffmpeg exits 0 and writes out -> True

Run:  python3 e2e/transcode_mp4_selftest.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import tempfile

HERE = pathlib.Path(__file__).resolve().parent


def load_module():
    spec = importlib.util.spec_from_file_location("venue_e2e", HERE / "venue_deep_link_e2e.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # module-level code only defines things; main() is guarded
    return mod


def with_fake_ffmpeg(script: str | None, home: pathlib.Path):
    """Point both ffmpeg lookups at a test double (or at nothing at all)."""
    mod = load_module()
    if script is None:
        mod.shutil.which = lambda _name: None          # no system ffmpeg
        mod.pathlib.Path.home = staticmethod(lambda: home)  # and no bundled one
    else:
        binp = home / "fakebin" / "ffmpeg"
        binp.parent.mkdir(parents=True, exist_ok=True)
        binp.write_text(script)
        binp.chmod(0o755)
        mod.shutil.which = lambda _name: str(binp)
        mod.pathlib.Path.home = staticmethod(lambda: home)
    return mod


def case(name: str, script: str | None, want: bool) -> bool:
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        webm = tmp / "in.webm"
        webm.write_bytes(b"not-really-a-webm-but-nothing-reads-it")
        mp4 = tmp / "out.mp4"
        mod = with_fake_ffmpeg(script, tmp)
        try:
            got = mod.transcode_mp4(webm, mp4)
        except BaseException as exc:  # noqa: BLE001 - the whole point is that nothing escapes
            print(f"  FAIL {name}: raised {exc.__class__.__name__}: {exc}")
            return False
        ok = got is want and mp4.exists() is want
        print(f"  {'ok  ' if ok else 'FAIL'} {name}: returned {got!r}, mp4 exists={mp4.exists()}")
        return ok


TRUNK = "#!/bin/sh\necho \"Unrecognized option 'movflags'.\" >&2\nexit 8\n"
NONEXEC = "#!/bin/sh\nexit 127\n"
OK = "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\nprintf 'mp4bytes' > \"$last\"\nexit 0\n"

if __name__ == "__main__":
    print("transcode_mp4 must never be fatal (see e2e/venue_deep_link_e2e.py):")
    results = [
        case("no ffmpeg anywhere (CI: none installed)", None, False),
        case("trimmed ffmpeg build exits 8 (the ngit CI failure)", TRUNK, False),
        case("ffmpeg present but exec fails (exit 127)", NONEXEC, False),
        case("working ffmpeg writes the mp4", OK, True),
    ]
    print(f"{sum(results)}/{len(results)} cases passed")
    raise SystemExit(0 if all(results) else 1)
