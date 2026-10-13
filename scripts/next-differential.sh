#!/bin/sh
# next-differential.sh -- the differential witness: every script in the
# corpus runs on the browser-native artifact (scripts/next-run.mjs, under
# Node) and on the oracle, stock Lua 5.4.8 built natively for musl
# (`make lua-musl`), and stdout, stderr and the exit status must be
# byte-identical. The reference behaviour is "Lua 5.4.8 on musl Linux,
# bugs included" (doc/history/browser-native-2026-10-13.md); any
# difference is a bug in the port.
#
#   sh scripts/next-differential.sh <lua.wasm> <native-lua> [corpus-dir]
#
# Both sides see the same world: a working directory holding the script
# as t.lua (so chunk names and messages match) and an empty data/
# directory, the same stdin, the same environment (a POSIX TZ rule, no
# LUA_INIT), the same argv. What the corpus must avoid, since it cannot be
# equal across any two processes: addresses (tostring of tables and
# functions), the random part of os.tmpname, timing, memory counts.

set -eu

WASM=$(CDPATH= cd "$(dirname "$1")" && pwd)/$(basename "$1")
NATIVE=$(CDPATH= cd "$(dirname "$2")" && pwd)/$(basename "$2")
CORPUS=${3:-port/test/diff}
ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

STDIN_TEXT='alpha
beta
42 3.5 0x10
last line without newline'
ENV_TZ='EST5EDT,M3.2.0,M11.1.0'

fail=0; n=0
for script in "$CORPUS"/*.lua; do
  name=$(basename "$script" .lua)
  n=$((n + 1))
  rm -rf "$work/native" "$work/stage"
  mkdir -p "$work/native/data" "$work/stage/data"
  cp "$script" "$work/native/t.lua"
  cp "$script" "$work/stage/t.lua"

  # the oracle: cwd is the prepared directory; argv[0] is "lua" (python's
  # execv sets it) so lua.c's progname, the prefix of its error messages,
  # is the same word on both sides, with the same PATH
  set +e
  (cd "$work/native" && printf '%s' "$STDIN_TEXT" | env -i TZ="$ENV_TZ" PATH=/usr/bin:/bin \
     python3 -c 'import os, sys; os.execv(sys.argv[1], ["lua"] + sys.argv[2:])' "$NATIVE" t.lua one two \
     > "$work/$name.native.out" 2> "$work/$name.native.err"; echo $? > "$work/$name.native.rc")
  # the artifact: the prepared directory mirrored into the in-memory filesystem
  printf '%s' "$STDIN_TEXT" | node --experimental-wasm-exnref "$ROOT/scripts/next-run.mjs" "$WASM" \
     --dir "$work/stage" --env TZ="$ENV_TZ" --env PATH=/usr/bin:/bin -- t.lua one two \
     > "$work/$name.wasm.out" 2> "$work/$name.wasm.err"; echo $? > "$work/$name.wasm.rc"
  set -e

  ok=1
  for part in out err rc; do
    if ! cmp -s "$work/$name.native.$part" "$work/$name.wasm.$part"; then
      ok=0
      echo "DIFF in $name ($part): native vs wasm"
      diff "$work/$name.native.$part" "$work/$name.wasm.$part" | head -20 || true
    fi
  done
  if [ "$ok" = 1 ]; then
    echo "  identical: $name ($(wc -l < "$work/$name.native.out") stdout lines, exit $(cat "$work/$name.native.rc"))"
  else
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "OK: $n corpus scripts byte-identical on the artifact and native Lua on musl (stdout, stderr, exit status)"
else
  echo "FAIL: the artifact diverges from native Lua on musl"
  exit 1
fi
