#!/usr/bin/env bash
# emu_teardown.sh - RUNS ON THE EMULATOR HOST.
# Stops the guest and the adb server. It must never wipe userdata: that would
# destroy live registration state (skill android-emulator-rail, pitfall #4).
set -euo pipefail
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
adb emu kill 2>/dev/null || true
sleep 3
adb kill-server 2>/dev/null || true
if pgrep -f qemu-system >/dev/null; then
  echo "WARN: qemu still running:"; pgrep -af qemu-system | head -3
else
  echo "guest stopped"
fi
