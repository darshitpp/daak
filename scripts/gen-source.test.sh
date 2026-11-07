#!/usr/bin/env bash
# Test for scripts/gen-source.sh. Run: bash scripts/gen-source.test.sh
# macOS only: the script reads plists with plutil and sizes with stat -f.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
gen="$here/gen-source.sh"
mkdir -p "${TMPDIR%/}/daak"
work="$(mktemp -d "${TMPDIR%/}/daak/gen-source-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

SOURCE_URL="https://github.com/darshitpp/daak/releases/latest/download/source.json"

fail() { echo "FAIL: $1"; exit 1; }

# plist <short-version> <build> <bundle-id>: print an Info.plist.
plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>$1</string>
<key>CFBundleVersion</key><string>$2</string>
<key>CFBundleIdentifier</key><string>$3</string>
</dict></plist>
EOF
}

# put_plist <entry> <short-version> <build> <bundle-id>: write one plist under $work/stage.
put_plist() {
  mkdir -p "$work/stage/$(dirname "$1")"
  plist "$2" "$3" "$4" > "$work/stage/$1"
}

# make_ipa <out> <entry>...: zip the entries in the given order.
make_ipa() {
  local out="$1"; shift
  rm -f "$out"
  ( cd "$work/stage" && zip -qX "$out" "$@" )
}

reset_stage() { rm -rf "$work/stage"; mkdir -p "$work/stage"; }

printf '{ "version": "0.1.5", "buildNumber": 6 }\n' > "$work/version.json"
APP="Payload/Daak.app/Info.plist"

# 1. ok: every field is right.
reset_stage; put_plist "$APP" 0.1.5 6 dev.darshit.daak
make_ipa "$work/Daak-0.1.5.ipa" "$APP"
rc=0; bash "$gen" "$work/Daak-0.1.5.ipa" "$work/version.json" "$work/ok.json" 2>"$work/err" || rc=$?
[ "$rc" -eq 0 ] || fail "ok case exit $rc, want 0: $(cat "$work/err")"
size="$(stat -f %z "$work/Daak-0.1.5.ipa")"
sum="$(shasum -a 256 "$work/Daak-0.1.5.ipa" | awk '{print $1}')"
jq -e --arg u "$SOURCE_URL" --argjson s "$size" --arg h "$sum" '
  .sourceURL == $u
  and .apps[0].bundleIdentifier == "dev.darshit.daak"
  and .apps[0].versions[0].version == "0.1.5"
  and .apps[0].versions[0].buildVersion == "6"
  and .apps[0].versions[0].size == $s
  and .apps[0].versions[0].sha256 == $h
  and .apps[0].versions[0].minOSVersion == "16.0"
  and (.apps[0].versions[0].date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
  and (.apps[0].versions[0].downloadURL | endswith("/v0.1.5/Daak-0.1.5.ipa"))
  and (.apps[0].iconURL | contains("/v0.1.5/"))
  and (.apps[0] | has("marketplaceID") | not)
  and (.apps[0].versions | length == 1)
' "$work/ok.json" >/dev/null || fail "ok case: a field is wrong"

# 2. version_mismatch: the ipa says 0.1.4.
reset_stage; put_plist "$APP" 0.1.4 6 dev.darshit.daak
make_ipa "$work/v.ipa" "$APP"
rc=0; bash "$gen" "$work/v.ipa" "$work/version.json" "$work/v.json" 2>"$work/err" || rc=$?
[ "$rc" -eq 1 ] || fail "version_mismatch exit $rc, want 1"
grep -q CFBundleShortVersionString "$work/err" || fail "version_mismatch: key not named"

# 3. build_mismatch: the ipa says build 5.
reset_stage; put_plist "$APP" 0.1.5 5 dev.darshit.daak
make_ipa "$work/b.ipa" "$APP"
rc=0; bash "$gen" "$work/b.ipa" "$work/version.json" "$work/b.json" 2>"$work/err" || rc=$?
[ "$rc" -eq 1 ] || fail "build_mismatch exit $rc, want 1"
grep -q CFBundleVersion "$work/err" || fail "build_mismatch: key not named"

# 4. bad_version_format: version.json holds a bad version.
printf '{ "version": "0.1.5; x", "buildNumber": 6 }\n' > "$work/badver.json"
reset_stage; put_plist "$APP" "0.1.5; x" 6 dev.darshit.daak
make_ipa "$work/f.ipa" "$APP"
rc=0; bash "$gen" "$work/f.ipa" "$work/badver.json" "$work/f.json" 2>/dev/null || rc=$?
[ "$rc" -eq 1 ] || fail "bad_version_format exit $rc, want 1"

# 5. no_plist: no Payload/*.app/Info.plist. No output file.
reset_stage; printf 'x' > "$work/stage/readme.txt"
make_ipa "$work/n.ipa" readme.txt
rc=0; bash "$gen" "$work/n.ipa" "$work/version.json" "$work/n.json" 2>/dev/null || rc=$?
[ "$rc" -eq 1 ] || fail "no_plist exit $rc, want 1"
[ ! -e "$work/n.json" ] || fail "no_plist left an output file"

# 6. two_plists: two app directories give two matches.
reset_stage
put_plist "Payload/A.app/Info.plist" 0.1.5 6 dev.darshit.daak
put_plist "Payload/B.app/Info.plist" 0.1.5 6 dev.darshit.daak
make_ipa "$work/t.ipa" Payload/A.app/Info.plist Payload/B.app/Info.plist
rc=0; bash "$gen" "$work/t.ipa" "$work/version.json" "$work/t.json" 2>/dev/null || rc=$?
[ "$rc" -eq 1 ] || fail "two_plists exit $rc, want 1"

# 7. nested_plist_first: a framework plist with a wrong version comes first.
reset_stage
put_plist "Payload/Daak.app/Frameworks/F.framework/Info.plist" 9.9.9 99 com.example.f
put_plist "$APP" 0.1.5 6 dev.darshit.daak
make_ipa "$work/q.ipa" Payload/Daak.app/Frameworks/F.framework/Info.plist "$APP"
rc=0; bash "$gen" "$work/q.ipa" "$work/version.json" "$work/q.json" 2>"$work/err" || rc=$?
[ "$rc" -eq 0 ] || fail "nested_plist_first exit $rc, want 0: $(cat "$work/err")"

# 8. path_with_space: the ipa path holds a space.
reset_stage; put_plist "$APP" 0.1.5 6 dev.darshit.daak
make_ipa "$work/with space.ipa" "$APP"
rc=0; bash "$gen" "$work/with space.ipa" "$work/version.json" "$work/space.json" 2>"$work/err" || rc=$?
[ "$rc" -eq 0 ] || fail "path_with_space exit $rc, want 0: $(cat "$work/err")"

# 9. not_a_zip: exit 2.
printf 'not a zip' > "$work/bad.ipa"
rc=0; bash "$gen" "$work/bad.ipa" "$work/version.json" "$work/bad.json" 2>/dev/null || rc=$?
[ "$rc" -eq 2 ] || fail "not_a_zip exit $rc, want 2"

# 10. usage: no arguments exit 2.
rc=0; bash "$gen" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "usage exit $rc, want 2"

# 11. missing_file: exit 2.
rc=0; bash "$gen" "$work/missing.ipa" "$work/version.json" "$work/m.json" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "missing_file exit $rc, want 2"

echo "PASS"
