#!/bin/sh
# verify-stock.sh -- witness that the vendored Lua core is verbatim stock
# 5.4.8 except for the one file we knowingly changed.
#
# The fork vendors PUC-Rio Lua 5.4.8 and modifies exactly one file:
# luac.c (the assert-safe bytecode-listing rework: stock luac hoists
# GETARG_* into locals, which trips lua_assert on opcodes lacking those
# argument formats under -DLUAI_ASSERT; found by this witness's first CI
# run -- it was inherited from the lua-aot import, undeclared). Until
# v0.2.0 there were five modified files: lobject.h, lfunc.c, lvm.c, and
# luaconf.h carried AOT hooks, now removed with AOT.
#
# Refreshing to a new Lua release: replace src/ with a clean copy, reapply
# the luac.c change above, and extract upstream's testes/* into this repo's
# tests/ (contents verbatim; only the directory name differs -- upstream
# ships the suite in testes/). This script is the guardrail for step one.
# This script diffs every source
# file present in both the official release and src/:
#   - a file outside the known-modified set that differs   -> FAIL
#   - a known-modified file that is byte-identical to stock -> FAIL (the
#     modified list has gone stale)
# Files unique to this repo (the onelua monolith) are
# reported, not diffed.
#
# Network: by default this fetches the release from lua.org. Run it where
# outbound HTTPS to lua.org is permitted -- locally, or the CI job in #3;
# some sandboxes deny that egress. To diff against an already-extracted
# tree instead of downloading, set LUA_SRC_DIR to its src/ directory.

set -eu

LUA_VERSION=5.4.8
# sha256 of the official lua-5.4.8.tar.gz, pinned from the provenance
# job's first green run (witness.yml, run 28798839189, 2026-07-06).
LUA_SHA256="4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae"
URL="https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz"

MODIFIED="luac.c"
REPO_SRC=$(CDPATH= cd "$(dirname "$0")/../src" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${LUA_SRC_DIR:-}" ]; then
  UP_SRC="$LUA_SRC_DIR"
  echo "using upstream tree: $UP_SRC"
else
  echo "fetching $URL"
  curl -fsSL -o "$work/lua.tar.gz" "$URL"
  if [ -n "$LUA_SHA256" ]; then
    echo "$LUA_SHA256  $work/lua.tar.gz" | sha256sum -c -
  else
    echo "WARNING: LUA_SHA256 unset -- skipping tarball integrity check"
  fi
  tar xzf "$work/lua.tar.gz" -C "$work"
  UP_SRC="$work/lua-${LUA_VERSION}/src"
fi

is_modified() { case " $MODIFIED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

fail=0

# 1. every shared source file must be verbatim, unless known-modified
for up in "$UP_SRC"/*.c "$UP_SRC"/*.h "$UP_SRC"/*.hpp; do
  [ -f "$up" ] || continue
  f=$(basename "$up")
  ours="$REPO_SRC/$f"
  if [ ! -f "$ours" ]; then
    echo "  upstream-only, not vendored: $f"
    continue
  fi
  if is_modified "$f"; then
    if cmp -s "$up" "$ours"; then
      echo "STALE: $f is listed as modified but is identical to stock"
      fail=1
    else
      echo "  modified (expected): $f"
    fi
  elif ! cmp -s "$up" "$ours"; then
    echo "UNEXPECTED DIFF: $f differs from stock but is not in the modified list"
    diff -u "$up" "$ours" | head -60 || true
    fail=1
  fi
done

# 2. report files unique to this repo (additions, not stock)
for ours in "$REPO_SRC"/*.c "$REPO_SRC"/*.h "$REPO_SRC"/*.hpp; do
  [ -f "$ours" ] || continue
  f=$(basename "$ours")
  [ -f "$UP_SRC/$f" ] || echo "  repo addition, not stock: $f"
done

if [ "$fail" -eq 0 ]; then
  echo "OK: all shared files are verbatim stock $LUA_VERSION except { $MODIFIED }"
else
  echo "FAIL: the vendored core diverges from stock $LUA_VERSION in unexpected ways"
  exit 1
fi
