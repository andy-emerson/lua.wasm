#!/bin/sh
# verify-musl.sh -- witness that third_party/musl/ is the official musl
# release, verbatim: every file byte-identical, none missing, none added.
#
# lua.wasm's C library is upstream musl, unmodified. The trust chain is:
#   1. the release tarball is signed by the musl project key, whose
#      fingerprint is pinned below (from https://musl.libc.org/releases.html);
#   2. the tarball's sha256 is pinned, so a re-signed or replaced upload
#      is diagnosable from the log;
#   3. the extracted tree is diffed against third_party/musl/ in both
#      directions.
# Any difference is a failure; there is no known-modified list.
#
# Refreshing to a new musl release: delete third_party/musl/, extract the
# new tarball there, `git add -f third_party/musl` (musl's own .gitignore
# hides dist/config.mak), update MUSL_VERSION and MUSL_SHA256 here, and run
# this script. The scheduled musl-upstream.yml workflow opens an issue when
# a newer signed release appears.
#
# Network: fetches the tarball, its signature and the project key from
# musl.libc.org. To verify against an already-downloaded tarball instead,
# set MUSL_TARBALL (and MUSL_TARBALL_SIG, MUSL_KEY) to local paths.

set -eu

MUSL_VERSION=1.2.6
# sha256 of the official musl-1.2.6.tar.gz, pinned at vendoring
# (2026-10-13; signature verified against the key below in the same run).
MUSL_SHA256="d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a"
# musl project GPG key fingerprint, as published on the releases page.
MUSL_KEY_FPR="836489290BB6B70F99FFDA0556BCDB593020450F"
BASE_URL="https://musl.libc.org"

REPO_MUSL=$(CDPATH= cd "$(dirname "$0")/../third_party/musl" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tarball="${MUSL_TARBALL:-}"
sig="${MUSL_TARBALL_SIG:-}"
key="${MUSL_KEY:-}"
if [ -z "$tarball" ]; then
  echo "fetching musl-${MUSL_VERSION} release, signature and project key from $BASE_URL"
  tarball="$work/musl.tar.gz"; sig="$work/musl.tar.gz.asc"; key="$work/musl.pub"
  curl -fsSL -o "$tarball" "$BASE_URL/releases/musl-${MUSL_VERSION}.tar.gz"
  curl -fsSL -o "$sig"     "$BASE_URL/releases/musl-${MUSL_VERSION}.tar.gz.asc"
  curl -fsSL -o "$key"     "$BASE_URL/musl.pub"
fi

# 1. integrity: the pinned hash
echo "musl-${MUSL_VERSION}.tar.gz sha256:"
sha256sum "$tarball"
echo "$MUSL_SHA256  $tarball" | sha256sum -c -

# 2. authenticity: the signature, checked with a throwaway keyring that
#    holds only the project key, and the key checked against the pinned
#    fingerprint (gpgv avoids the agent, which some sandboxes lack)
if [ -z "$sig" ] || [ -z "$key" ]; then
  echo "FAIL: MUSL_TARBALL set without MUSL_TARBALL_SIG and MUSL_KEY"
  exit 1
fi
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --no-default-keyring --keyring "$work/musl.kbx" --import "$key" 2>/dev/null \
  || { echo "FAIL: $key is not an importable GPG public key"; exit 1; }
fprs=$(gpg --batch --no-default-keyring --keyring "$work/musl.kbx" --with-colons --fingerprint 2>/dev/null \
       | awk -F: '$1=="fpr"{print $10}')
case "$fprs" in
  *"$MUSL_KEY_FPR"*) echo "project key fingerprint matches the pin: $MUSL_KEY_FPR" ;;
  *) echo "FAIL: downloaded key fingerprint(s) [$fprs] do not include the pinned $MUSL_KEY_FPR"; exit 1 ;;
esac
gpgv --keyring "$work/musl.kbx" "$sig" "$tarball"

# 3. verbatim: the whole tree, both directions
tar xzf "$tarball" -C "$work"
UP="$work/musl-${MUSL_VERSION}"
if diff -r "$UP" "$REPO_MUSL" > "$work/diff.txt"; then
  n=$(find "$REPO_MUSL" -type f | wc -l)
  echo "OK: third_party/musl is verbatim musl $MUSL_VERSION ($n files, signature good)"
else
  echo "FAIL: third_party/musl diverges from musl $MUSL_VERSION:"
  head -40 "$work/diff.txt"
  exit 1
fi
