#!/usr/bin/env bash
#
# Check the icon files that gen-icons.sh writes. Uses sips and python3 (stdlib).
# Exit zero only when every check passes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
count=0

# check <relative path> <width> <height> <hasAlpha: yes|no>
check() {
  local f="$ROOT/$1" w h a
  count=$((count + 1))
  if [ ! -f "$f" ]; then echo "MISSING $1"; fail=1; return; fi
  w="$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')"
  h="$(sips -g pixelHeight "$f" | awk '/pixelHeight/ {print $2}')"
  a="$(sips -g hasAlpha "$f" | awk '/hasAlpha/ {print $2}')"
  if [ "$w" != "$2" ] || [ "$h" != "$3" ] || [ "$a" != "$4" ]; then
    echo "WRONG   $1: got ${w}x${h} alpha=$a, want $2x$3 alpha=$4"; fail=1
  fi
}

IOS=apps/mobile/ios/Daak/Images.xcassets/AppIcon.appiconset
for px in 40 58 60 80 87 120 180 1024; do check "$IOS/icon-$px.png" "$px" "$px" no; done

MAC=apps/desktop/macos/Daak-macOS/Assets.xcassets
for pt in 16 32 128 256 512; do
  check "$MAC/AppIcon.appiconset/icon_${pt}x${pt}@1x.png" "$pt" "$pt" yes
  check "$MAC/AppIcon.appiconset/icon_${pt}x${pt}@2x.png" "$((pt * 2))" "$((pt * 2))" yes
done
check "$MAC/MenuBarIcon.imageset/menubar-18.png" 18 18 yes
check "$MAC/MenuBarIcon.imageset/menubar-36.png" 36 36 yes

RES=apps/mobile/android/app/src/main/res
while read -r d fg leg; do
  check "$RES/mipmap-$d/ic_launcher_foreground.png" "$fg" "$fg" yes
  check "$RES/mipmap-$d/ic_launcher.png" "$leg" "$leg" yes
  check "$RES/mipmap-$d/ic_launcher_round.png" "$leg" "$leg" yes
done <<'DENSITIES'
mdpi 108 48
hdpi 162 72
xhdpi 216 96
xxhdpi 324 144
xxxhdpi 432 192
DENSITIES

UI=packages/ui/src/assets
check "$UI/daak-mark.png" 24 26 yes
check "$UI/daak-mark@2x.png" 48 52 yes
check "$UI/daak-mark@3x.png" 72 78 yes

# Every Contents.json entry must name a file that exists.
for cj in "$IOS/Contents.json" "$MAC/AppIcon.appiconset/Contents.json" "$MAC/MenuBarIcon.imageset/Contents.json"; do
  dir="$(dirname "$ROOT/$cj")"
  [ -f "$ROOT/$cj" ] || { echo "MISSING $cj"; fail=1; continue; }
  entries="$(grep -c '"scale"' "$ROOT/$cj" || true)"
  named="$(grep -c '"filename"' "$ROOT/$cj" || true)"
  if [ "$entries" != "$named" ]; then echo "NOFILE  $cj: $entries entries, $named filenames"; fail=1; fi
  for name in $(sed -n 's/.*"filename" : "\(.*\)".*/\1/p' "$ROOT/$cj"); do
    [ -f "$dir/$name" ] || { echo "MISSING $dir/$name (named in $cj)"; fail=1; }
  done
done
grep -qs '"template-rendering-intent" : "template"' "$ROOT/$MAC/MenuBarIcon.imageset/Contents.json" \
  || { echo "NOTEMPLATE MenuBarIcon Contents.json"; fail=1; }

# Pixel checks: the template is pure black, the Android foreground fits the 66 dp circle.
python3 -I - "$ROOT/$MAC/MenuBarIcon.imageset/menubar-36.png" "$ROOT/$MAC/MenuBarIcon.imageset/menubar-18.png" \
  "$ROOT/$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" "$ROOT/$RES/mipmap-mdpi/ic_launcher_foreground.png" <<'PY' || fail=1
import struct, sys, zlib

def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', path
    i, idat = 8, b''
    while i < len(d):
        n, = struct.unpack('>I', d[i:i + 4])
        t, body = d[i + 4:i + 8], d[i + 8:i + 8 + n]
        if t == b'IHDR':
            w, h, depth, ctype, _, _, inter = struct.unpack('>IIBBBBB', body)
        if t == b'IDAT':
            idat += body
        i += 12 + n
    assert (depth, ctype, inter) == (8, 6, 0), path + ': need 8-bit RGBA, not interlaced'
    raw, stride, bpp = zlib.decompress(idat), w * 4, 4
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        f, line = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, rows

ok = True
for path in sys.argv[1:3]:
    w, h, rows = read_png(path)
    seen = 0
    for row in rows:
        for x in range(w):
            r, g, b, a = row[x * 4:x * 4 + 4]
            if a > 0:
                seen += 1
                if (r, g, b) != (0, 0, 0):
                    ok = False
                    print('NOTBLACK', path, (r, g, b, a))
                    break
    if seen == 0:
        ok = False
        print('EMPTY', path)
for path, dp_px in ((sys.argv[3], 4), (sys.argv[4], 1)):
    w, h, rows = read_png(path)
    limit = 33 * dp_px + 1.5
    cx = cy = w / 2
    for y, row in enumerate(rows):
        for x in range(w):
            if row[x * 4 + 3] > 0 and ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2) ** .5 > limit:
                ok = False
                print('OUTSIDE', path, x, y)
                break
sys.exit(0 if ok else 1)
PY

if [ "$fail" -ne 0 ]; then echo "check-icons: FAILED"; exit 1; fi
echo "check-icons: ok ($count images)"
