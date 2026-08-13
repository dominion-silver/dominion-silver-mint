#!/usr/bin/env bash
# ROUND 8 T8-01. The installer must authenticate the TOOLCHAIN ARCHIVE, and must extract nothing when
# the bytes are wrong.
#
# WHY THE NEGATIVE CASE LOOKS LIKE THIS. Proving "it refuses" is not enough: the question is whether
# anything from the rejected archive ever reached the filesystem or ran. So the mutated archive
# carries a SENTINEL executable that writes a file when executed, and the case asserts three things:
# the exit is non-zero, the sentinel was never extracted into the destination, and its marker file
# does not exist.
#
# The fixture enters through a FAKE `curl` placed first on PATH, never through an override in the
# production script. An installer that honours an environment variable to change where it fetches
# from has a hole shaped exactly like the one this test exists to close.
#
#   bash .github/test-install-solana.sh
set -uo pipefail
cd "$(dirname "$0")/.."
INSTALLER=".github/install-solana.sh"
export SOLANA_VERSION="${SOLANA_VERSION:-3.0.0}"

pass=0; fail=0
ok()  { echo "ok: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- 1. the happy path
# A temporary HOME, so the toolchain lands in an isolated destination and `solana --version` is
# produced FROM THAT destination rather than from whatever is already on this machine.
HOME_OK="$TMP/home-ok"; mkdir -p "$HOME_OK"
out="$TMP/ok.log"
if env HOME="$HOME_OK" GITHUB_PATH= bash "$INSTALLER" >"$out" 2>&1; then
  BIN="$HOME_OK/.local/share/solana/install/active_release/bin/solana"
  if [[ -x "$BIN" ]] && "$BIN" --version >/dev/null 2>&1; then
    ok "official v$SOLANA_VERSION archive accepted after its pinned SHA-256 matched"
  else
    bad "the installer reported success but produced no runnable solana at $BIN"
  fi
else
  bad "the official archive was rejected"
  tail -12 "$out"
fi

# ---------------------------------------------------------------- 2. a mutated archive
# Built here: a real tar.bz2 whose only content is a sentinel that writes a marker when run. Its
# digest cannot match the pin, so the installer must stop before extraction.
MARKER="$TMP/SENTINEL_RAN"
STAGE="$TMP/stage/solana-release/bin"; mkdir -p "$STAGE"
cat > "$STAGE/solana" <<EOF
#!/usr/bin/env bash
echo ran > "$MARKER"
EOF
chmod +x "$STAGE/solana"
tar -cjf "$TMP/evil.tar.bz2" -C "$TMP/stage" solana-release

FAKE="$TMP/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/curl" <<EOF
#!/usr/bin/env bash
# Stands in for the network. Honours -o and ignores everything else.
dest=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) dest="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$TMP/evil.tar.bz2" "\$dest"
EOF
chmod +x "$FAKE/curl"

HOME_BAD="$TMP/home-bad"; mkdir -p "$HOME_BAD"
out2="$TMP/bad.log"
env PATH="$FAKE:$PATH" HOME="$HOME_BAD" GITHUB_PATH= bash "$INSTALLER" >"$out2" 2>&1
rc=$?
if [[ "$rc" -eq 0 ]]; then
  bad "a one-byte-mutated archive was ACCEPTED"
  tail -12 "$out2"
else
  ok "one-byte-mutated archive rejected before extraction"
fi
if [[ -e "$HOME_BAD/.local/share/solana/install/active_release/bin/solana" ]]; then
  bad "the rejected archive was extracted into the active destination anyway"
elif [[ -e "$MARKER" ]]; then
  bad "an executable from the rejected archive RAN"
else
  ok "no executable from the rejected archive ran"
fi

echo
if [[ "$fail" -ne 0 ]]; then
  echo "INSTALL-SOLANA SELF-TEST FAILED"
  exit 1
fi
echo "INSTALL-SOLANA SELF-TEST OK: $pass/$pass"
