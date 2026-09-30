#!/usr/bin/env bash
# Removes the per-user daakd LaunchAgent. Idempotent: uninstalling an agent
# that was never installed succeeds.
set -euo pipefail

label="dev.darshit.daak.daakd"
target="${HOME}/Library/LaunchAgents/${label}.plist"

launchctl bootout "gui/${UID}/${label}" 2>/dev/null || launchctl unload "${target}" 2>/dev/null || true
rm -f "${target}"
echo "daak: removed ${label}"
