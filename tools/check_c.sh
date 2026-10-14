#!/bin/sh
# Type-checks the watch code on a computer without the Pebble SDK, against
# the stand-in header in test/c (normal build and every screenshot harness
# build), then builds and runs the C unit tests (test/c/*_test.c).
# `pebble build` is still the real check.
#
# Usage: sh tools/check_c.sh
set -e
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# MESSAGE_KEY_* in package.json order, as the SDK numbers them, and the
# resource ids.
node -e '
var p = require("./package.json").pebble;
p.messageKeys.forEach(function (k, i) { console.log("#define MESSAGE_KEY_" + k + " " + (10000 + i)); });
(p.resources.media || []).forEach(function (r, i) { console.log("#define RESOURCE_ID_" + r.name + " " + (i + 1)); });
' > "$out/message_keys.h"

# The SDK's own flags (sdk/waftools/pebble_sdk_gcc.py in Core Devices'
# PebbleOS): C99, -Os (some warnings only show with optimisation), -Werror
# with its exceptions, and on the ARM compiler (apt install
# gcc-arm-none-eabi) a 32-bit time_t as the SDK has it.
warn="-Wall -Wextra -Werror -Wno-unused-parameter -Wno-error=unused-function -Wno-error=unused-variable
  -Wno-error=builtin-declaration-mismatch -Wno-error=format-truncation -Wno-error=expansion-to-defined
  -Wno-error=zero-length-bounds -Wno-error=cast-function-type -Wno-error=unused-value"
# clang (macOS's gcc) doesn't know some of GCC's warning names.
gcc --version 2>/dev/null | grep -q clang && warn="$warn -Wno-unknown-warning-option"
flags="-std=c99 -Os $warn -I test/c -I $out -I src/c"
arm="-mcpu=cortex-m3 -mthumb -ffunction-sections -fdata-sections -fcommon -fPIE -D_TIME_H_ -Dtime_t=long"
have_arm=$(command -v arm-none-eabi-gcc || true)

# The release build, in full, warnings shown.
for f in src/c/*.c; do
  gcc $flags -c "$f" -o "$out/host.o"
  if [ -n "$have_arm" ]; then
    arm-none-eabi-gcc $flags $arm -c "$f" -o "$out/$(basename "$f" .c).o"
  fi
done
# Every screenshot build, with the computer's compiler at -Os (so warnings
# that need optimisation show), main.c only (the others don't use
# SKY_SHOT); quiet unless it fails.
for shot in 1 2 3 4 5 6 7 9 10 11 12 13 14 15 16 17 18 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73; do
  gcc $flags -DSKY_SHOT=$shot -c src/c/main.c -o "$out/shot.o" 2> "$out/err" || { cat "$out/err"; exit 1; }
done
# ... and one with touch put back in (SKY_TOUCH).
gcc $flags -DSKY_SHOT=72 -DSKY_TOUCH -c src/c/main.c -o "$out/shot.o" 2> "$out/err" || { cat "$out/err"; exit 1; }
echo "watch code type-checks"
if [ -n "$have_arm" ]; then
  arm-none-eabi-size "$out"/main.o "$out"/sky.o "$out"/offline.o
fi

for t in test/c/*_test.c; do
  [ -e "$t" ] || continue
  gcc -std=gnu99 -Wall -Wextra -Wno-unused-parameter -Werror -O1 -I test/c -I "$out" -I src/c "$t" src/c/sky.c src/c/offline.c test/c/host.c -lm \
    -o "$out/t"
  "$out/t"
done
