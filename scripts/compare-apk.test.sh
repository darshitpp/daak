#!/usr/bin/env bash
# Test for scripts/compare-apk.sh. Run: bash scripts/compare-apk.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR%/}/daak/compare-test.XXXXXX")"
trap 'rm -rf "$work/a" "$work/b" "$work/one.zip" "$work/same.zip" "$work/two.zip" "$work/sig.zip" "$work/nosig.zip"; rmdir "$work"' EXIT

mkdir "$work/a" "$work/b"
printf 'alpha' > "$work/a/x.txt"; printf 'beta' > "$work/a/y.txt"
cp "$work/a/x.txt" "$work/b/x.txt"; printf 'gamma' > "$work/b/y.txt"
( cd "$work/a" && zip -q -X "$work/one.zip" x.txt y.txt )
cp "$work/one.zip" "$work/same.zip"
( cd "$work/b" && zip -q -X "$work/two.zip" x.txt y.txt )

# 1. Equal files are identical.
out="$(bash "$here/compare-apk.sh" "$work/one.zip" "$work/same.zip")"
echo "$out" | grep -q '^IDENTICAL$' || { echo "FAIL: equal files"; exit 1; }

# 2. A changed entry exits 1 and names the entry.
if out="$(bash "$here/compare-apk.sh" "$work/one.zip" "$work/two.zip")"; then
  echo "FAIL: a changed entry passed"; exit 1
fi
echo "$out" | grep -q 'y.txt' || { echo "FAIL: y.txt not named"; exit 1; }
echo "$out" | grep -q 'x.txt' && { echo "FAIL: x.txt named, it is equal"; exit 1; }

# 3. A META-INF entry alone does not count as a difference in the entry list.
mkdir "$work/a/META-INF"; printf 'sig' > "$work/a/META-INF/CERT.SF"
( cd "$work/a" && zip -q -X "$work/sig.zip" x.txt y.txt META-INF/CERT.SF )
out="$(bash "$here/compare-apk.sh" "$work/one.zip" "$work/sig.zip" || true)"
echo "$out" | grep -q 'Entries equal' || { echo "FAIL: META-INF counted"; exit 1; }

echo "PASS"
