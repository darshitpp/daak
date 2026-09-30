#!/usr/bin/env bash
# Installs and enables the daakd systemd --user unit. No sudo: a per-user unit
# belongs to the user manager, which is what keeps the IPC socket same-user.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
unit_dir="${HOME}/.config/systemd/user"
target="${unit_dir}/daakd.service"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "daak: systemctl not found; this installer is Linux-only." >&2
  exit 1
fi

# Same resolution order as daemons/macos/install.sh: $DAAKD_BIN, then the
# conventional prefixes, then PATH. The plan hardcoded %h/.local/bin/daakd,
# which exists only if something installed it there.
daakd_bin=""
for candidate in \
  "${DAAKD_BIN:-}" \
  "${HOME}/.local/bin/daakd" \
  "/usr/local/bin/daakd" \
  "/usr/bin/daakd"
do
  [ -n "${candidate}" ] && [ -x "${candidate}" ] || continue
  daakd_bin="${candidate}"
  break
done
if [ -z "${daakd_bin}" ]; then
  # Last resort: a daakd already on PATH.
  if found="$(command -v daakd 2>/dev/null)" && [ -x "${found}" ]; then
    daakd_bin="${found}"
  fi
fi
if [ -z "${daakd_bin}" ]; then
  echo "daak: found no daakd binary; looked in \${DAAKD_BIN}, ~/.local/bin," >&2
  echo "daak: /usr/local/bin, /usr/bin and PATH. Install one (cargo install" >&2
  echo "daak: --path crates/daakd) or set DAAKD_BIN=/path/to/daakd." >&2
  exit 1
fi

# systemd's ExecStart is not a shell: no $VAR expansion, split on whitespace, and
# '%' is a specifier. Validate BEFORE the live unit is touched. The first
# version of this script sed-patched the ExecStart line with an UNESCAPED
# replacement (`&` expanded to the whole match, `#` ended the s/// early) and
# its `>` redirect had already truncated the previously-good unit to 0 bytes.
case "${daakd_bin}" in
  /*) ;;
  *)
    echo "daak: not an absolute path: ${daakd_bin}" >&2
    exit 1
    ;;
esac
case "${daakd_bin}" in
  *$'\n'*)
    echo "daak: path contains a newline; refusing to write a broken unit." >&2
    exit 1
    ;;
  *%*)
    echo "daak: path contains '%', which systemd expands as a specifier: ${daakd_bin}" >&2
    exit 1
    ;;
  *'"'*)
    # systemd has no escape for a double quote inside a quoted argument.
    echo "daak: path contains a double quote; refusing to write a broken unit: ${daakd_bin}" >&2
    exit 1
    ;;
esac

# systemd quoting, done ONCE, by bash parameter expansion: double the
# backslashes (systemd unescapes `\` inside a quoted argument) and wrap in double
# quotes so a space stays ONE argument.
#
# Deliberately NOT sed and NOT `awk -v`: both re-scan their input. sed's
# replacement string expands `&` and dies on an unescaped newline, and BSD awk's
# `-v` assignment re-interprets backslash escapes in its VALUE, so a doubled
# backslash is collapsed again on the way in. Pure bash moves the bytes intact.
execstart="${daakd_bin//\\/\\\\}"
execstart_line="ExecStart=\"${execstart}\""

# Substitute the ExecStart line IN PLACE. Do not prepend it: a bare key before
# the first [Section] header is not a valid assignment, systemd discards it
# SILENTLY, and daemon-reload / enable --now still succeed with only SubState=
# failed to show for it. A read loop in bash, so the path is never handed to a
# tool that re-scans it.
# Written to a temp file in the unit directory (same filesystem, so mv is
# atomic) and moved into place only once complete and verified, so any failure
# leaves a previously-good unit byte-identical.
mkdir -p "${unit_dir}"
tmp="${target}.new.$$"
cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT
while IFS= read -r line || [ -n "${line}" ]; do
  case "${line}" in
    ExecStart=*) printf '%s\n' "${execstart_line}" ;;
    *) printf '%s\n' "${line}" ;;
  esac
done <"${here}/daakd.service" >"${tmp}"

# The generated unit must carry exactly one ExecStart, whose value round-trips
# back to the path we resolved. Asserted on the PARSED value, not with grep -qx:
# -qx reinterprets the backslashes systemd needs, so it fails on a perfectly
# correct backslash install. A check that fails on a valid install gets deleted.
[ "$(grep -c '^ExecStart=' "${tmp}")" -eq 1 ]
[ "$(sed -n 's/^ExecStart=\"\(.*\)"$/\1/p' "${tmp}")" = "${execstart}" ]

# ...and ExecStart must sit inside [Service], never above the first header. A
# key before any [Section] is silently dropped by systemd, so assert the ORDER,
# not just the presence: [Unit] and [Service] headers, and ExecStart after them.
grep -q '^\[Unit\]$' "${tmp}"
grep -q '^\[Service\]$' "${tmp}"
exec_line_no="$(grep -n '^ExecStart=' "${tmp}" | head -1 | cut -d: -f1)"
service_line="$(grep -n '^\[Service\]$' "${tmp}" | head -1 | cut -d: -f1)"
[ "${exec_line_no}" -gt "${service_line}" ]
mv "${tmp}" "${target}"
trap - EXIT

systemctl --user daemon-reload
systemctl --user enable --now daakd.service
systemctl --user is-enabled daakd.service
systemctl --user show -p SubState -p LoadState daakd.service
echo "daak: installed daakd.service -> ${daakd_bin}"
