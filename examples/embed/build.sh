#!/bin/sh
# build.sh -- app.c linked with Lua from the tarball, with plain clang.
#
#   sh examples/embed/build.sh <unpacked tarball> [app.wasm]
#
# CC names the compiler (default clang; clang 20+ for the module's own
# code is not required here -- app.c carries no exceptions, the EH unit
# in the archive does). The link needs LLVM's wasm32 compiler-rt
# builtins (musl's printf reaches __multf3): found in CC's resource
# directory (the libclang-rt-N-dev-wasm32 package), or named in RT.
# zig cc: its bundled compiler-rt carries a libm that would replace
# musl's behind the archive, so it is left out (-rtlib=none) and RT
# must be named.
set -eu
SDK=$1
OUT=${2:-app.wasm}
CC=${CC:-clang}
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)

RTFLAG=
case "$CC" in *zig*) RTFLAG=-rtlib=none ;; esac
if [ -z "${RT:-}" ]; then
  RES=$($CC -print-resource-dir)
  for p in "$RES"/lib/libclang_rt.builtins-wasm32.a "$RES"/lib/wasi/libclang_rt.builtins-wasm32.a \
           "$RES"/lib/wasm32-*/libclang_rt.builtins.a "$RES"/lib/wasm32-*/libclang_rt.builtins-wasm32.a; do
    if [ -f "$p" ]; then RT=$p; break; fi
  done
fi
[ -n "$RT" ] || { echo "build.sh: no wasm32 compiler-rt builtins under $($CC -print-resource-dir); install libclang-rt-N-dev-wasm32 or name the archive in RT" >&2; exit 1; }

# compile: the tarball's include/ holds Lua's headers and the libc's
# (named with -isystem, not only --sysroot: zig's freestanding target
# adds no sysroot include directory of its own)
$CC --target=wasm32-freestanding -isystem "$SDK/include" -O2 -Wall -c "$HERE/app.c" -o "${OUT%.wasm}.o"
# link: the reactor crt named first, the program, the archive, the builtins;
# no entry (a reactor), the stack Lua's recursion needs
$CC --target=wasm32-freestanding -nostdlib $RTFLAG -Wl,--no-entry -Wl,-z,stack-size=8388608 -Wl,--strip-all \
  "$SDK/lib/crt-reactor.o" "${OUT%.wasm}.o" -L"$SDK/lib" -llua-wasm "$RT" -o "$OUT"
echo "$OUT: $(wc -c < "$OUT") bytes"
