#!/usr/bin/env bash
# Test for scripts/android-from-actions.sh. Run: bash scripts/android-from-actions.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "${TMPDIR%/}/daak"
export DAAK_SOURCE_ONLY=1
# shellcheck disable=SC1091
. "$here/android-from-actions.sh"

fail() { echo "FAIL: $*"; exit 1; }
work="$(mktemp -d "${TMPDIR%/}/daak/afa-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# --- pick_run: picks only a new run that builds the expected commit.
runs='[{"databaseId":11,"headSha":"aaa"},
       {"databaseId":12,"headSha":"bbb"},
       {"databaseId":13,"headSha":"bbb"},
       {"databaseId":14,"headSha":"ccc"}]'
[ "$(printf '%s' "$runs" | pick_run bbb "")" = "13" ] || fail "pick_run: wrong run"
[ "$(printf '%s' "$runs" | pick_run bbb "13")" = "12" ] || fail "pick_run: ignored a known id"
[ "$(printf '%s' "$runs" | pick_run bbb "12")" = "13" ] || fail "pick_run: picked a run with another commit"
[ "$(printf '%s' "$runs" | pick_run ccc "")" = "14" ] || fail "pick_run: wrong run for ccc"
[ -z "$(printf '%s' "$runs" | pick_run bbb "12,13")" ] || fail "pick_run: found a known run"
[ -z "$(printf '%s' "$runs" | pick_run ddd "")" ] || fail "pick_run: found a run for another commit"

# --- wait_run: stops at the deadline when the run never finishes.
cat > "$work/gh-pending" <<'EOS'
#!/usr/bin/env bash
echo '{"status":"waiting","conclusion":""}'
EOS
chmod +x "$work/gh-pending"
if GH="$work/gh-pending" DAAK_WAIT_SECONDS=2 DAAK_POLL_SECONDS=1 wait_run 12 >/dev/null 2>&1; then
  fail "wait_run: no stop at the deadline"
fi
cat > "$work/gh-done" <<'EOS'
#!/usr/bin/env bash
echo '{"status":"completed","conclusion":"success"}'
EOS
chmod +x "$work/gh-done"
GH="$work/gh-done" DAAK_WAIT_SECONDS=5 DAAK_POLL_SECONDS=1 wait_run 12 >/dev/null || fail "wait_run: a good run failed"
cat > "$work/gh-failed" <<'EOS'
#!/usr/bin/env bash
echo '{"status":"completed","conclusion":"failure"}'
EOS
chmod +x "$work/gh-failed"
if GH="$work/gh-failed" DAAK_WAIT_SECONDS=5 DAAK_POLL_SECONDS=1 wait_run 12 >/dev/null 2>&1; then
  fail "wait_run: a failed run passed"
fi

# --- verify_apk: the signer must equal the expected value.
: > "$work/app.apk"
EXPECTED_SIGNER="$(expected_signer)"
[ ${#EXPECTED_SIGNER} -eq 64 ] || fail "expected_signer: not a SHA-256 value"
cat > "$work/apksigner-good" <<EOS
#!/usr/bin/env bash
echo "Signer #1 certificate SHA-256 digest: $EXPECTED_SIGNER"
EOS
cat > "$work/apksigner-fail" <<EOS
#!/usr/bin/env bash
echo "Signer #1 certificate SHA-256 digest: $EXPECTED_SIGNER"
exit 1
EOS
cat > "$work/apksigner-bad" <<'EOS'
#!/usr/bin/env bash
echo "Signer #1 certificate SHA-256 digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EOS
cat > "$work/aapt-good" <<'EOS'
#!/usr/bin/env bash
echo "package: name='dev.darshit.daak' versionCode='42' versionName='0.1.3'"
EOS
cat > "$work/aapt2-good" <<'EOS'
#!/usr/bin/env bash
printf '    resource 0x7f0d0054 string/react_native_dev_server_ip\n      () "localhost"\n'
EOS
cat > "$work/aapt2-ip" <<'EOS'
#!/usr/bin/env bash
printf '    resource 0x7f0d0054 string/react_native_dev_server_ip\n      () "192.168.0.226"\n'
EOS
chmod +x "$work"/apksigner-* "$work"/aapt-* "$work"/aapt2-*
APKSIGNER="$work/apksigner-good" AAPT="$work/aapt-good" AAPT2="$work/aapt2-good" verify_apk "$work/app.apk" 0.1.3 \
  || fail "verify_apk: a good APK failed"
if APKSIGNER="$work/apksigner-bad" AAPT="$work/aapt-good" AAPT2="$work/aapt2-good" verify_apk "$work/app.apk" 0.1.3 2>/dev/null; then
  fail "verify_apk: a wrong signer passed"
fi
if APKSIGNER="$work/apksigner-fail" AAPT="$work/aapt-good" AAPT2="$work/aapt2-good" verify_apk "$work/app.apk" 0.1.3 2>/dev/null; then
  fail "verify_apk: a failed apksigner verify passed"
fi
if APKSIGNER="$work/apksigner-good" AAPT="$work/aapt-good" AAPT2="$work/aapt2-good" verify_apk "$work/app.apk" 0.9.9 2>/dev/null; then
  fail "verify_apk: a wrong version passed"
fi
if APKSIGNER="$work/apksigner-good" AAPT="$work/aapt-good" AAPT2="$work/aapt2-ip" verify_apk "$work/app.apk" 0.1.3 2>/dev/null; then
  fail "verify_apk: a build host IP passed"
fi

echo "PASS"
