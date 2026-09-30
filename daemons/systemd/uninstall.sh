#!/usr/bin/env bash
# Removes the per-user daakd systemd unit. Idempotent: removing a unit that was
# never installed succeeds. macOS has had an uninstall script from Task 8 and a
# unit that install.sh enabled with `enable --now` otherwise survives reboot
# with no supported way to take it back out.
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "daak: systemctl not found; nothing to uninstall." >&2
  exit 1
fi

target="${HOME}/.config/systemd/user/daakd.service"
systemctl --user disable --now daakd.service 2>/dev/null || true
rm -f "${target}"
systemctl --user daemon-reload
systemctl --user reset-failed daakd.service 2>/dev/null || true
echo "daak: removed daakd.service"
