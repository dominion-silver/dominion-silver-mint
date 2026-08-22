#!/usr/bin/env bash
# Install the Anza/Solana toolchain from an archive this script AUTHENTICATES ITSELF.
# WHAT WAS WRONG, in this file's own previous words. An earlier revision replaced `sh -c "$(curl ...)"` with a
# checksummed bootstrap. An earlier revision found that closed the door and left the window open: the bootstrap
# then downloaded `agave-install-init-$TARGET` unverified and ran it. An earlier revision pinned that binary. And
# the header said, honestly, that it still did NOT verify the toolchain TARBALL the installer then
# downloads. That was the remaining unauthenticated stage: whoever controls that object gets code
# execution inside the job that produces the release binary.
# THE FIX IS TO REMOVE THE STAGE, AGAIN. We fetch `solana-release-$TARGET.tar.bz2` ourselves, compare
# its SHA-256 to a pin measured here, and only then extract. `agave-install-init` is no longer
# downloaded or run at all: it existed to fetch this archive, and we fetch it.
# THE PINS BELOW WERE MEASURED, not copied. An earlier draft of this work was handed three digests by
# a reviewer; pinning a digest nobody in this repository has measured is theatre, so they were
# re-measured by streaming each archive through shasum on 2026-08-09. The two that matter agreed.
# x86_64-apple-darwin is DELIBERATELY ABSENT. No Intel Mac exists in this project, so a pin for it
# would be an unmeasured constant, and the missing-entry branch below fails loudly with the command
# to measure it. An absent pin is safer than a guessed one.
# WHEN THE VERSION CHANGES: re-measure every target you support, in one commit, with the reason.
#   curl -sSfL "https://github.com/anza-xyz/agave/releases/download/v<V>/solana-release-<TARGET>.tar.bz2" | shasum -a 256
set -euo pipefail

VERSION="${SOLANA_VERSION:?SOLANA_VERSION must be set by the workflow env}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)   TARGET="x86_64-unknown-linux-gnu" ;;
  Darwin/arm64)   TARGET="aarch64-apple-darwin" ;;
  Darwin/x86_64)  TARGET="x86_64-apple-darwin" ;;
  *)              TARGET="" ;;
esac
if [[ -z "$TARGET" ]]; then
  echo "::error::unsupported platform $(uname -s)/$(uname -m) for the pinned Anza toolchain."
  exit 1
fi

# A `case`, not `declare -A`: macOS ships bash 3.2 and associative arrays need bash 4. A guard that
# only works on the CI runner cannot be exercised before it is relied on.
want=""
case "$VERSION/$TARGET" in
  3.0.0/x86_64-unknown-linux-gnu) want="912f3ce691f3f6d82c466b90574878312bbdcd455b5d2726795d2bc019b993b5" ;;
  3.0.0/aarch64-apple-darwin)     want="40c35d143bbf212b6887872b34552ee8ad472485bce76957996aa748bb4175b8" ;;
esac
if [[ -z "$want" ]]; then
  echo "::error::no MEASURED archive checksum for Solana $VERSION on $TARGET."
  echo "Measure it and add it to .github/install-solana.sh in the same commit as the version bump:"
  echo "  curl -sSfL \"https://github.com/anza-xyz/agave/releases/download/v$VERSION/solana-release-$TARGET.tar.bz2\" | shasum -a 256"
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/solana-release.tar.bz2"
url="https://github.com/anza-xyz/agave/releases/download/v${VERSION}/solana-release-${TARGET}.tar.bz2"

# The retry wraps the DOWNLOAD only, so a transient failure is retried while changed bytes are
# refused. The checksum sits between the network and anything that executes.
for attempt in 1 2 3; do
  if curl -sSfL "$url" -o "$archive"; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    echo "::error::could not download $url after 3 attempts."
    exit 1
  fi
  echo "download attempt $attempt failed, retrying in 10s"
  sleep 10
done

got="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$got" != "$want" ]]; then
  echo "::error::the Anza toolchain archive for v$VERSION/$TARGET does not match its measured checksum."
  echo "  fetched : $got"
  echo "  pinned  : $want"
  echo "Either upstream republished the asset (verify and re-pin deliberately) or this download was"
  echo "tampered with. NOTHING HAS BEEN EXTRACTED and nothing from it has run."
  exit 1
fi
echo "archive checksum OK ($got) for $TARGET"

# Only now. Extraction is the first moment attacker-controlled bytes touch the filesystem, so it must
# come after the comparison and never before it.
DEST="$HOME/.local/share/solana/install/active_release"
mkdir -p "$DEST"
tar -xjf "$archive" -C "$DEST" --strip-components 1

BIN="$DEST/bin"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$BIN" >> "$GITHUB_PATH"
fi
"$BIN/solana" --version
