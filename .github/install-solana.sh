#!/usr/bin/env bash
# ROUND 6 R6-08. Install the Anza/Solana CLI from a CHECKSUMMED installer instead of piping a URL to a
# shell.
#
# THE DEFECT THIS REPLACES. Three jobs ran `sh -c "$(curl -sSfL https://release.anza.xyz/vX/install)"`.
# That is remote code, fetched over the network, executed unverified, inside the job that produces the
# release binary. Whoever controls that URL controls `cargo build-sbf`, and therefore the bytes this
# workflow exists to attest. The audit's remediation names it directly: verify the Solana archives or
# installers by checksum or signature.
#
# WHAT THIS DOES AND DOES NOT PROVE. It proves the installer script is byte-for-byte the one measured
# on 2026-08-08, so a change to it fails loudly instead of silently altering the toolchain. It does NOT
# verify the release tarball the installer then downloads; Anza does not publish a stable detached
# signature we can pin here, and claiming otherwise would be exactly the kind of overclaim this repo
# keeps having to correct. The container build (`solana-verify`, which pins its image) is the
# independent check on the bytes; this closes the easiest hole, not every hole.
#
# WHEN THE VERSION CHANGES: re-measure, in one commit, with the reason.
#   curl -sSfL "https://release.anza.xyz/v<VERSION>/install" | shasum -a 256
set -euo pipefail

VERSION="${SOLANA_VERSION:?SOLANA_VERSION must be set by the workflow env}"

# Measured 2026-08-08 for v3.0.0. One entry per version we have ever installed, so a rollback is a
# lookup rather than a re-measurement under pressure.
#
# A `case`, not `declare -A`: macOS ships bash 3.2, associative arrays need bash 4, and the first
# version of this file died with "invalid arithmetic operator" the moment it was run locally. A guard
# that only works on the CI runner cannot be exercised before it is relied on.
case "$VERSION" in
  3.0.0) want="7d588d188cb9ea550434cabc62a9927cf75de22e1aeb2a87f2352071812944fb" ;;
  *)     want="" ;;
esac
if [[ -z "$want" ]]; then
  echo "::error::no pinned installer checksum for Solana $VERSION."
  echo "Measure it and add it to .github/install-solana.sh in the same commit as the version bump:"
  echo "  curl -sSfL \"https://release.anza.xyz/v$VERSION/install\" | shasum -a 256"
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# The retry wraps the DOWNLOAD only. The `build` job used to carry its own three-attempt loop around
# `sh -c "$(curl ...)"`, which is what kept it off this installer; the resilience was real, the way it
# was bought was not. Retrying here keeps it and still puts the checksum between the network and the
# shell: a transient failure is retried, a changed script is refused.
for attempt in 1 2 3; do
  if curl -sSfL "https://release.anza.xyz/v${VERSION}/install" -o "$tmp"; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    echo "::error::could not download the Anza installer for v$VERSION after 3 attempts."
    exit 1
  fi
  echo "download attempt $attempt failed, retrying in 10s"
  sleep 10
done

got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
if [[ "$got" != "$want" ]]; then
  echo "::error::the Anza installer for v$VERSION does not match its pinned checksum."
  echo "  fetched : $got"
  echo "  pinned  : $want"
  echo "Either upstream changed the script (verify and re-pin deliberately) or this download was"
  echo "tampered with. Do NOT run it to find out."
  exit 1
fi
echo "installer checksum OK ($got)"

bash "$tmp"
echo "$HOME/.local/share/solana/install/active_release/bin" >> "$GITHUB_PATH"
"$HOME/.local/share/solana/install/active_release/bin/solana" --version
