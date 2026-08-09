#!/usr/bin/env bash
# Install the Anza/Solana CLI from a CHECKSUMMED binary, with no unverified stage anywhere.
#
# ROUND 6 R6-08 replaced `sh -c "$(curl ...)"` with a checksummed download of the BOOTSTRAP script.
# ROUND 7 R7-01 found that this closed the door and left the window open: the bootstrap it verified
# then built the URL
#
#   https://github.com/anza-xyz/agave/releases/download/v<VERSION>/agave-install-init-$TARGET
#
# downloaded that platform-specific EXECUTABLE, chmod +x'd it and ran it, with no checksum and no
# signature. Whoever controls that second object gets arbitrary code execution inside the job that
# produces the release binary, before the `.so` is built, with the checkout writable. The previous
# version of this file said so in its own comments, which documents a hole rather than closing one.
#
# THE FIX IS TO REMOVE THE STAGE, NOT TO ADD A CHECK TO IT. We fetch `agave-install-init-$TARGET`
# ourselves, verify it against a measured checksum, and only then execute it. The bootstrap script is
# no longer downloaded or run at all: it only ever did platform detection and this download, and both
# are done here in code that is committed and reviewable.
#
# WHAT THIS PROVES, AND WHAT IT STILL DOES NOT. It proves the installer binary is byte-for-byte the
# one measured on 2026-08-09, so a compromised release asset fails loudly. It does NOT verify the
# toolchain TARBALL that this installer subsequently downloads. Anza publishes no stable detached
# signature we can pin for it, and claiming otherwise would be the same overclaim R7-01 exists to
# correct. The container build (`solana-verify`, which pins its own image) remains the independent
# check on the produced bytes. This closes the stage that was executing unauthenticated code; it does
# not make the whole chain authenticated.
#
# WHEN THE VERSION CHANGES: re-measure every target you support, in one commit, with the reason.
#   curl -sSfL "https://github.com/anza-xyz/agave/releases/download/v<V>/agave-install-init-<TARGET>" \
#     | shasum -a 256
set -euo pipefail

VERSION="${SOLANA_VERSION:?SOLANA_VERSION must be set by the workflow env}"

# Platform detection, previously done by the bootstrap we no longer run.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)   TARGET="x86_64-unknown-linux-gnu" ;;
  Darwin/arm64)   TARGET="aarch64-apple-darwin" ;;
  Darwin/x86_64)  TARGET="x86_64-apple-darwin" ;;
  *)              TARGET="" ;;
esac
if [[ -z "$TARGET" ]]; then
  echo "::error::unsupported platform $(uname -s)/$(uname -m) for the pinned Anza installer."
  exit 1
fi

# Measured 2026-08-09 for v3.0.0. One entry per (version, target) we have ever installed, so a
# rollback is a lookup rather than a re-measurement under pressure.
#
# A `case`, not `declare -A`: macOS ships bash 3.2, associative arrays need bash 4, and the first
# version of this file died with "invalid arithmetic operator" the moment it was run locally. A guard
# that only works on the CI runner cannot be exercised before it is relied on.
want=""
case "$VERSION/$TARGET" in
  3.0.0/x86_64-unknown-linux-gnu) want="3b125e56ab458f4832897b96408ca61c7a19648b1e524c339d397e7b7dfaeceb" ;;
  3.0.0/aarch64-apple-darwin)     want="908709df3d030d7483d11a9cc254cae298fd2c867419784eabc86ae724b31434" ;;
  3.0.0/x86_64-apple-darwin)      want="ee87d37e4610a09fd645c31f703a4561ac90b6d19b2907f802c4eef883cefeb2" ;;
esac
if [[ -z "$want" ]]; then
  echo "::error::no pinned installer checksum for Solana $VERSION on $TARGET."
  echo "Measure it and add it to .github/install-solana.sh in the same commit as the version bump:"
  echo "  curl -sSfL \"https://github.com/anza-xyz/agave/releases/download/v$VERSION/agave-install-init-$TARGET\" | shasum -a 256"
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
init="$tmp/agave-install-init"
url="https://github.com/anza-xyz/agave/releases/download/v${VERSION}/agave-install-init-${TARGET}"

# The retry wraps the DOWNLOAD only. The `build` job used to carry its own three-attempt loop around
# `sh -c "$(curl ...)"`, which is what kept it off this installer; the resilience was real, the way it
# was bought was not. Retrying here keeps it and still puts the checksum between the network and
# execution: a transient failure is retried, changed bytes are refused.
for attempt in 1 2 3; do
  if curl -sSfL "$url" -o "$init"; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    echo "::error::could not download $url after 3 attempts."
    exit 1
  fi
  echo "download attempt $attempt failed, retrying in 10s"
  sleep 10
done

got="$(shasum -a 256 "$init" | awk '{print $1}')"
if [[ "$got" != "$want" ]]; then
  echo "::error::the Anza installer for v$VERSION/$TARGET does not match its pinned checksum."
  echo "  fetched : $got"
  echo "  pinned  : $want"
  echo "Either upstream republished the asset (verify and re-pin deliberately) or this download was"
  echo "tampered with. Do NOT run it to find out."
  exit 1
fi
echo "installer checksum OK ($got) for $TARGET"

chmod +x "$init"
# `v$VERSION` is REQUIRED. Measured, not assumed: run with no argument the binary answers
# "Please specify the release to install" and exits non-zero. The bootstrap we replaced passed
# `SOLANA_INSTALL_INIT_ARGS=v3.0.0` for exactly this reason.
"$init" "v${VERSION}"

BIN="$HOME/.local/share/solana/install/active_release/bin"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$BIN" >> "$GITHUB_PATH"
fi
"$BIN/solana" --version
