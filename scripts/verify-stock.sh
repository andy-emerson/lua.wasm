#!/bin/sh
# verify-stock.sh -- witness that the vendored Lua is verbatim stock 5.4.8:
# every C source, header and the build Makefile in src/ byte-equal to the
# official release, and every file of the official test suite byte-equal
# to tests/ (upstream ships it as a second tarball, testes/; only the
# directory name differs).
#
# Refreshing to a new Lua release: replace src/ with a clean copy of the
# release's src/ and tests/ with the test tarball's testes/, then update
# the version and the two sha256 pins here. This script diffs every file
# present in both the official tree and ours:
#   - any shared file that differs -> FAIL
#   - a suite file missing from tests/ -> FAIL
# Files unique to this repo (the onelua monolith; the placeholder that
# keeps tests/libs/P1 in git) are reported, not diffed.
#
# Network: by default this fetches both tarballs from lua.org. Run it where
# outbound HTTPS to lua.org is permitted -- locally, or the provenance job
# of witness.yml; some sandboxes deny that egress. To diff against
# already-extracted trees instead of downloading, set LUA_SRC_DIR to the
# release's src/ directory and LUA_TESTS_DIR to the suite's directory.

set -eu

LUA_VERSION=5.4.8
# sha256 of the official lua-5.4.8.tar.gz, pinned from the provenance
# job's first green run (witness.yml, run 28798839189, 2026-07-06).
LUA_SHA256="4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae"
URL="https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz"
# sha256 of the official lua-5.4.8-tests.tar.gz, pinned when the suite
# check was added (2026-10-13; the tree matched tests/ in the same run).
LUA_TESTS_SHA256="9581d5a7c39ffbf29b8ccde2709083c380f7bbddbd968dcb15712d2f2e33f4e5"
TESTS_URL="https://www.lua.org/tests/lua-${LUA_VERSION}-tests.tar.gz"

REPO_SRC=$(CDPATH= cd "$(dirname "$0")/../src" && pwd)
REPO_TESTS=$(CDPATH= cd "$(dirname "$0")/../tests" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() {   # fetch <url> <sha256> <out>: download and check the pin
  echo "fetching $1"
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c -
}

if [ -n "${LUA_SRC_DIR:-}" ]; then
  UP_SRC="$LUA_SRC_DIR"
  echo "using upstream tree: $UP_SRC"
else
  fetch "$URL" "$LUA_SHA256" "$work/lua.tar.gz"
  tar xzf "$work/lua.tar.gz" -C "$work"
  UP_SRC="$work/lua-${LUA_VERSION}/src"
fi
if [ -n "${LUA_TESTS_DIR:-}" ]; then
  UP_TESTS="$LUA_TESTS_DIR"
  echo "using upstream test suite: $UP_TESTS"
else
  fetch "$TESTS_URL" "$LUA_TESTS_SHA256" "$work/tests.tar.gz"
  tar xzf "$work/tests.tar.gz" -C "$work"
  UP_TESTS="$work/lua-${LUA_VERSION}-tests"
fi

fail=0

# 1. every shared file of src/ must be verbatim
for up in "$UP_SRC"/*.c "$UP_SRC"/*.h "$UP_SRC"/*.hpp "$UP_SRC"/Makefile; do
  [ -f "$up" ] || continue
  f=$(basename "$up")
  ours="$REPO_SRC/$f"
  if [ ! -f "$ours" ]; then
    echo "  upstream-only, not vendored: $f"
    continue
  fi
  if ! cmp -s "$up" "$ours"; then
    echo "UNEXPECTED DIFF: $f differs from stock"
    diff -u "$up" "$ours" | head -60 || true
    fail=1
  fi
done

# 2. report files unique to this repo's src/ (additions, not stock)
for ours in "$REPO_SRC"/*.c "$REPO_SRC"/*.h "$REPO_SRC"/*.hpp; do
  [ -f "$ours" ] || continue
  f=$(basename "$ours")
  [ -f "$UP_SRC/$f" ] || echo "  repo addition, not stock: $f"
done

# 3. the test suite: every upstream file present and verbatim; the
#    repo's own additions reported (tracked files only, so the suite's
#    build outputs -- .so, all, time*.txt -- do not count)
n=0
for up in $(cd "$UP_TESTS" && find . -type f | sort); do
  up=${up#./}
  n=$((n + 1))
  ours="$REPO_TESTS/$up"
  if [ ! -f "$ours" ]; then
    echo "MISSING: tests/$up is in the official suite but not here"
    fail=1
  elif ! cmp -s "$UP_TESTS/$up" "$ours"; then
    echo "UNEXPECTED DIFF: tests/$up differs from the official suite"
    diff -u "$UP_TESTS/$up" "$ours" | head -60 || true
    fail=1
  fi
done
for ours in $(git -C "$REPO_TESTS" ls-files 2>/dev/null || (cd "$REPO_TESTS" && find . -type f | sed 's|^\./||')); do
  [ -f "$UP_TESTS/$ours" ] || echo "  repo addition, not stock: tests/$ours"
done

if [ "$fail" -eq 0 ]; then
  echo "OK: all shared files are verbatim stock $LUA_VERSION (src/, and the $n files of the official test suite in tests/)"
else
  echo "FAIL: the vendored Lua diverges from stock $LUA_VERSION in unexpected ways"
  exit 1
fi
