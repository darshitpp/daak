#!/usr/bin/env bash
# Installs the per-user daakd LaunchAgent (AGENTS.md: launchd label is
# dev.darshit.daak.daakd). No sudo: this is a per-user agent.
set -euo pipefail

label="dev.darshit.daak.daakd"
here="$(cd "$(dirname "$0")" && pwd)"
target="${HOME}/Library/LaunchAgents/${label}.plist"

# Resolve the daemon binary. Order is the first existing of:
#   $DAAKD_BIN                     explicit override (packaging / CI)
#   /Applications/Daak.app/...     the shipped bundle
#   apps/desktop/macos/build/...   the repo-built bundle
#   target/{release,debug}/daakd   this checkout's own cargo build
#   $HOME/.local/bin, /usr/local/bin, /opt/homebrew/bin, then `command -v`
# The plan hardcoded /Applications/Daak.app/Contents/MacOS/daakd, but nothing
# puts daakd in that bundle: Daak.xcodeproj has no copy phase for it (pod
# install rewrites project.pbxproj, so that fix belongs in packaging), and the
# built Daak.app/Contents/MacOS holds only Daak, Daak.debug.dylib and
# __preview.dylib. So the path is RESOLVED here and the install refuses rather
# than writing a plist that points at nothing.
daakd_bin=""
for candidate in \
  "${DAAKD_BIN:-}" \
  "/Applications/Daak.app/Contents/MacOS/daakd" \
  "${HOME}/Applications/Daak.app/Contents/MacOS/daakd" \
  "$(cd "${here}/../.." && pwd)/apps/desktop/macos/build/Build/Products/Release/Daak.app/Contents/MacOS/daakd" \
  "$(cd "${here}/../.." && pwd)/apps/desktop/macos/build/Build/Products/Debug/Daak.app/Contents/MacOS/daakd" \
  "$(cd "${here}/../.." && pwd)/target/release/daakd" \
  "$(cd "${here}/../.." && pwd)/target/debug/daakd" \
  "${HOME}/.local/bin/daakd" \
  "/usr/local/bin/daakd" \
  "/opt/homebrew/bin/daakd"
do
  [ -n "${candidate}" ] && [ -x "${candidate}" ] || continue
  daakd_bin="${candidate}"
  break
done

if [ -z "${daakd_bin}" ]; then
  # Last resort: a daakd already on PATH. Kept last so the list above wins, but
  # it has to EXIST here or the "...and PATH" below is a lie.
  if found="$(command -v daakd 2>/dev/null)" && [ -x "${found}" ]; then
    daakd_bin="${found}"
  fi
fi

if [ -z "${daakd_bin}" ]; then
  echo "daak: found no daakd binary to install; looked in \${DAAKD_BIN}," >&2
  echo "daak: /Applications/Daak.app/Contents/MacOS/daakd, ~/Applications/Daak.app/...," >&2
  echo "daak: apps/desktop/macos/build/... , target/{release,debug}/daakd," >&2
  echo "daak: ~/.local/bin, /usr/local/bin, /opt/homebrew/bin and PATH." >&2
  echo "daak: build one first (cargo build -p daakd) or set DAAKD_BIN=/path/to/daakd." >&2
  exit 1
fi

# A newline in the path is not escapable into something launchd can exec, and
# plutil ACCEPTS one (it round-trips it as \n), so nothing downstream would
# catch it. Refuse here, as the systemd installer does. This is checked before
# anything is created, so a refusal leaves no temp file behind.
case "${daakd_bin}" in
  *$'\n'*)
    echo "daak: path contains a newline; refusing to write a plist launchd cannot exec: ${daakd_bin}" >&2
    exit 1
    ;;
esac

# Point the agent at the binary we just found, using plutil: it OWNS the plist
# format, so `&`, `<`, `>`, quotes and backslashes round-trip correctly. Doing
# this with sed on the XML is how the first version of this script emitted
# `\/` (not a plist entity) and produced a plist launchctl then refused with
# "Bootstrap failed: 5: Input/output error".
#
# The WHOLE array is rebuilt rather than edited in place: `-replace
# ProgramArguments.0` assigns index 0 and leaves the shipped placeholder in
# place beside it, so the agent ran `daakd /usr/local/bin/daakd` with argv[1]
# shadowing the real path. Harmless only while daakd has no arg parser.
#
# `plutil -replace ProgramArguments -array` is NOT the whole-array replacement it
# looks like: with no value operand it EMPTIES the array, returns 0, and the
# plist still lints. So: remove the key, insert an empty array, then insert
# element 0. `-string` takes the path as a VALUE, so no layer re-scans it --
# `-json` would, and would need the path JSON-escaped first.
#
# Generated into a temp file in the TARGET directory (same filesystem, so the
# mv is atomic) and linted BEFORE it replaces anything, so a generation failure
# leaves a previously-good plist byte-identical instead of truncating it.
mkdir -p "${HOME}/Library/LaunchAgents"
tmp="${target}.new.$$"
cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT
if ! cp "${here}/${label}.plist" "${tmp}" \
  || ! plutil -remove ProgramArguments "${tmp}" \
  || ! plutil -insert ProgramArguments -array "${tmp}" \
  || ! plutil -insert ProgramArguments.0 -string "${daakd_bin}" "${tmp}" \
  || ! plutil -lint "${tmp}" >/dev/null; then
  echo "daak: could not build a valid plist; ${target} left untouched." >&2
  exit 1
fi

# Exactly ONE argv element, or the stale-argv bug is back: index 0 must exist
# and index 1 must not. Proved by extraction rather than by counting commas in
# the JSON, because a comma is a legal character in a path and a grep-based
# count rejects a perfectly good install -- a check that fails on a valid
# install gets deleted by the next engineer.
if ! plutil -extract ProgramArguments.0 raw -o - "${tmp}" >/dev/null \
  || plutil -extract ProgramArguments.1 raw -o - "${tmp}" >/dev/null 2>&1; then
  echo "daak: generated plist does not hold exactly one argv element; ${target} left untouched." >&2
  exit 1
fi

mv "${tmp}" "${target}"
trap - EXIT

# bootout before load so a re-install replaces the loaded job instead of
# complaining; bootout on a job that was never loaded is not an error here.
launchctl bootout "gui/${UID}/${label}" 2>/dev/null || launchctl unload "${target}" 2>/dev/null || true
launchctl bootstrap "gui/${UID}" "${target}"
launchctl enable "gui/${UID}/${label}"

# Prove the agent is actually loaded: a plist copied but not bootstrapped is the
# silent failure mode this script exists to avoid.
launchctl print "gui/${UID}/${label}" >/dev/null

echo "daak: installed ${label} -> ${daakd_bin}"
# Display only. `|| true` because `set -o pipefail` would otherwise turn a
# `launchctl list` that exits non-zero into an install failure, and the real
# proof of a loaded agent is the `launchctl print` above.
launchctl list | awk -v l="${label}" '$3 == l' || true
