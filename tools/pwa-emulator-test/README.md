# PWA emulator test (Android)

Reproduces the customer-order PWA check that was run by hand on 2026-10-09:
serve the repo, drive Chrome on a headless Android guest, capture one
screenshot per screen.

## Why this exists

The PWA could be verified in a desktop browser, but the operator wanted it
exercised on a real Android guest. Two things made that non-obvious, and both
are encoded here so nobody re-derives them:

1. **Synthetic taps do not work on this guest.** `adb shell input tap` / `input
   keyevent` do not dismiss Chrome's first-run dialogs, and never focus an
   EditText (skill `android-emulator-rail`, pitfall #7). The fix is
   **uiautomator2** - an accessibility `.click()` works first try. See
   `drive_pwa.py`. Do not "simplify" it back to `input tap`.
2. **Chrome re-shows its first-run experience on every fresh launch.** So the
   driver clears the whole dialog chain, *then* navigates, and clears again -
   otherwise the first launch is eaten by the dialog.

## Run it

```bash
tools/pwa-emulator-test/run-pwa-emulator-test.sh \
  --emu-host c03rad0r@c03rad0r-dq05proplus.local \
  --url-host 192.168.2.43
```

Options: `--avd` (default `wa-dev`), `--port` (default 8099), `--out`
(default `artifacts/pwa-emulator`), `--keep` (leave the guest running).

Output: `artifacts/pwa-emulator/pwa-*.png` plus the visible text of each screen
on stdout.

## Requirements

- **Emulator host** with an openable `/dev/kvm` (this box does not qualify; dq05
  does), the Android SDK (`emulator` + `platform-tools`), and the AVD already
  created. `python3`; `uiautomator2` is installed by the script.
- The host resolves under the FIPS mesh as `<name>.fips` - useful when the
  public IPv4 firewalls off 22 while leaving 80/443 open.
- The guest must reach `--url-host`; same-LAN works, and the emulator's own
  guest-to-host address is `10.0.2.2`.
- Chrome is present on the `google_apis_playstore` image
  (`com.android.chrome`), so no extra APK is needed.

## What was verified (2026-10-09)

Screens captured and read back from the live DOM, on real registry data:

| screen | evidence |
|---|---|
| 1 venues | "Order food, pay in sats", wallet `45 210 sats`, venue card *Pizza e Pasta · 112 items · from 2 700 sats / 2,70 €* |
| 2 menu | "Catalog snapshot · prices served by venue", Pickup/Delivery toggle, real SKUs + dual pricing + allergens |
| 3 item | "Sauce required · pick 1", "Extras up to 3" with prices, `+ Avocado sold out` disabled, "Size required · pick 1" |
| 4 basket | item added, "1 items" badge |

**Not verified:** the pay screen. The basket->pay transition was not reached, so
"never fabricate an invoice" is untested in the emulator. An open item.

## Safety

The guest holds ~3.3 GB RSS. The script tears it down by default; `--keep` is
for a follow-up step only. Never `-wipe-data`: it destroys live registration
state on that AVD.
