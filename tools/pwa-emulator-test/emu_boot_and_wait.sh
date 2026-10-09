#!/usr/bin/env bash
# emu_boot_and_wait.sh - RUNS ON THE EMULATOR HOST.
# Boots the headless AVD if no guest is running, then waits for sys.boot_completed.
# Split out of run-pwa-emulator-test.sh so the boot loop needs no nested quoting.
set -euo pipefail
AVD="${1:-wa-dev}"
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
if ! pgrep -f qemu-system >/dev/null; then
  nohup "$HOME/Android/Sdk/emulator/emulator" -avd "$AVD" -no-window -no-audio \
    -no-snapshot -gpu swiftshader_indirect -no-metrics -no-boot-anim \
    >/tmp/emu-boot.log 2>&1 &
  echo "booting $AVD (log: /tmp/emu-boot.log)"
else
  echo "guest already running"
fi
adb wait-for-device
for i in $(seq 1 40); do
  b="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  if [ "$b" = "1" ]; then echo "booted after $((i*10))s"; exit 0; fi
  sleep 10
done
echo "TIMEOUT: sys.boot_completed never reached 1" >&2
exit 1
