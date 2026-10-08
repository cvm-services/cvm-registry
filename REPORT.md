# Task t_80eef259 report

Implemented and merged PR #15 (merge commit `7dec48a`) for the venue hand-off mockup revision.

- Replaced mobile screens 4/5 and desktop screens 2/3 payment/settlement imagery with basket payload, venue deep-link hand-off, and explicit venue-site confirmation caveats.
- Corrected basket math: Cheeseburger ×2 = 17,80 € / 17 800 sats; Curly Fries ×1 = 4,50 € / 4 500 sats; total = 22,30 € / 22 300 sats.
- Updated PR #14 body in place, then opened revised PR #15 with explicit v1 scope and no Track-B art retained.
- Replaced deprecated `--headless=old` with `--headless`.
- Render command: `bash docs/ui-mockups/shot.sh` (exit 0). All nine outputs were non-blank by ImageMagick mean/standard-deviation checks; dimensions: mobile 780x1688, desktop 2880x1800.
- Published branch to GitHub and ngit. Merged with `gh pr merge 15 --merge`.
- Verified `git ls-remote origin refs/heads/main` and `git ls-remote ngit refs/heads/main` both return `7dec48a846a7a25c584f3e16eb5fbf898c229aa1`.
