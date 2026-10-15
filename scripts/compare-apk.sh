#!/usr/bin/env bash
#
# Compare two APKs the way F-Droid needs them to match.
#
#   scripts/compare-apk.sh <apk-a> <apk-b>
#
# First the SHA-256 of the whole file. F-Droid copies the signature of one APK
# onto the other, so the zip bytes must be equal. If they differ, the script
# lists the zip entries (name, size, method, CRC) that differ. META-INF holds
# the signature, so the list skips it.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <apk-a> <apk-b>" >&2; exit 2; }
a="$1"
b="$2"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
sa="$(sha "$a")"
sb="$(sha "$b")"
echo "a  $sa  $a"
echo "b  $sb  $b"

if [ "$sa" = "$sb" ]; then
  echo "IDENTICAL"
  exit 0
fi

# Columns of `unzip -lv`: Length Method Size Cmpr Date Time CRC-32 Name.
list() {
  unzip -lv "$1" | awk 'NF == 8 && $7 ~ /^[0-9a-f]{8}$/ && $8 !~ /^META-INF\// { print $8, $1, $2, $7 }'
}

if diff <(list "$a") <(list "$b"); then
  echo "Entries equal (name, order, size, method, CRC) outside META-INF."
  echo "The difference is in the zip layout, a timestamp, an extra field, or the signing block."
else
  echo "DIFFERENT. Lines with < are in a. Lines with > are in b."
fi
exit 1
