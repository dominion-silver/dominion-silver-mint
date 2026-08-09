#!/usr/bin/env bash
# Gate: refuse to deploy an artifact not built from this tree with the default features.
#
# ASSERTS: the .so is byte-identical to a clean default-feature rebuild; the forbidden
# instruction names are absent as strings; the IDL exists, advertises none of them, and its
# address equals declare_id!. It asserts NOTHING about what is deployed on-chain.
# The rebuild is the primary gate. The string scan is a secondary signal only, because a
# `no-log-ix-name` build strips the msg! names it looks for. `test-harness` and `dev-hatch`
# builds land at target/deploy/dominion_silver_mint.so, the exact path `solana program deploy`
# reads, and dev-hatch compiles in setters that mutate config with NO timelock. Three defeated
# earlier designs of this gate: private/trimmed-notes/gates.md

# Usage: scripts/verify-release-artifact.sh [path-to-so] [path-to-idl]
#   --skip-rebuild   secondary checks only. Weaker, and exits 2, never 0.
#   --local-only     ask ONLY "is this a clean default-feature build of this tree", and exit 0 on
#                    success. Skips the release-pin comparison entirely instead of reporting on it.
#
# EXIT CODES, and the reason they exist (round 5 P0-02). This script used to print
# `EXPECTED MISMATCH` and then finish with `ARTIFACT OK` and exit 0. A caller reading the exit code,
# or a human reading the last line, was told the artifact was attested when the script had just said
# it could not be. The previous session saw that 0 in its own test output and took it for the
# intended behaviour, which is the same class of defect as a harness runner printing OK over zero
# tests executed.
#
#   0  ATTESTED. Clean rebuild AND the artifact reproduces the pinned release binary.
#      Under --local-only: clean rebuild, and no claim about the release pin is made or implied.
#   1  REJECTED. A check failed: the rebuild differs, a forbidden instruction is present, the IDL is
#      missing or wrong, or the host SHOULD reproduce the pin and does not.
#   2  PARTIAL. --skip-rebuild: the one check that catches a feature-flag build did not run.
#   3  NOT ATTESTED. Every check that CAN run here passed, and the release pin could not be
#      evaluated: no candidate is pinned yet, or this host cannot reproduce a linux/amd64 container
#      build. Not a failure, and not an attestation either. Deploying on a 3 is the thing this code
#      exists to stop.
set -euo pipefail

# The release hash has ONE home, config/mainnet-authorities.json. A bare 64-hex string in docs/
# fails whether or not it is correct today: a hand-maintained duplicate goes stale, and this one
# went stale three times. Before the --skip-rebuild exit, since that path is the hurried one.
# ROOT FIRST. This block used to sit ABOVE the ROOT assignment and grep a cwd-relative `docs`, with
# `2>/dev/null || true` swallowing the "No such file or directory", so run from anywhere but the repo
# root it scanned nothing and passed. Exactly the defect this same file fixes for the manifest read a
# hundred lines below, left in place one block earlier. `verify-mainnet-readiness.ts` invoked it with
# an inherited cwd.
# ROOT is the tree of the REAL script, not of the path used to invoke it. R6-03 removed the env var
# that redirected the manifest; a symlink is the same redirection through the filesystem, and ROOT is
# what selects MANIFEST_JSON below.
#
# REVIEW OF FIXES ON 993e628, P1. The first attempt was `cd -P "$(dirname "$BASH_SOURCE")/.."`, which
# closes only ONE of the two symlink shapes. Measured:
#   ln -s <repo>/scripts       <fake>/scripts        -> cd -P resolves it. Closed.
#   ln -s <repo>/scripts/x.sh  <fake>/scripts/x.sh   -> dirname is already <fake>/scripts, a real
#                                                       directory, so -P has nothing to resolve.
# The second shape is the natural one, and it still read a prepared tree's manifest, lib.rs and
# target/. Resolving BASH_SOURCE ITSELF is what closes both. `readlink -f` is not portable to older
# macOS, and this script already depends on python3.
#
# ROUND 7 R7-01 [sic, R7-02]. Symlinks were two of THREE shapes. A HARD LINK carries no target to
# resolve: the alias and the original share one inode, `realpath` returns the alias's own path, and
# ROOT becomes the directory holding the alias. The auditor reproduced it: a hard link dropped into a
# prepared tree made this script attest that tree's `.so` against that tree's manifest and print
# ARTIFACT OK, while looking byte-identical to the audited script because it IS the same inode.
#
# `st_nlink` is what distinguishes them, and it is the only thing that does. A file reachable under
# more than one name cannot tell you which tree it belongs to, so it must not try to guess.
_self="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${BASH_SOURCE[0]}")"
_nlink="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_nlink)' "$_self")"
if [ "$_nlink" != "1" ]; then
  echo ""
  echo "REFUSING TO RUN: this script has $_nlink hard links, so its location does not identify a"
  echo "repository. ROOT is derived from where the script sits, and it selects the manifest, the"
  echo "sources and target/ that get attested. An alias in another tree would make this attest that"
  echo "tree while appearing to be this exact file."
  echo ""
  echo "  resolved path : $_self"
  echo "  inode         : $(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_ino)' "$_self")"
  echo ""
  echo 'This also fires on a link nobody meant to create: a stale temp tree, a backup tool, a cp -l.'
  echo "The guard cannot tell which name is the original, so it refuses rather than guess. Find the"
  echo "other names and remove the ones you do not want:"
  echo "  find / -xdev -inum <inode above> 2>/dev/null"
  echo ""
  echo "Run the script from its own checkout. To copy it elsewhere, copy the repository, not the file."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi
ROOT="$(cd -P "$(dirname "$_self")/.." && pwd)"

# ================================================================ ROUND 8 T8-02: WHOSE TREE IS THIS?
#
# THE THIRD ALIASING SHAPE. ROOT comes from where this file sits, and ROOT selects the manifest that
# is read, the sources that are rebuilt and the target/ that is attested. Round 7 closed two of the
# three ways a file can sit somewhere it does not belong: a SYMLINK is resolved by `realpath` above,
# and a HARD LINK is refused by the `st_nlink` guard above. A COPY, or a MOVE, defeats both. It has
# exactly one link and it resolves to itself, so the guards see nothing, and the verifier proceeds to
# attest a foreign repository while being byte-identical to the audited script.
#
# That is not a hypothetical: reviewing the FILE cannot distinguish the two, because it is the same
# file. What distinguishes them is whether the checkout it sits in is the authenticated one.
#
# WHAT THIS ESTABLISHES, and deliberately no more:
#   1. ROOT is the top level of a Git working tree, and it is the SAME tree this file lives in.
#   2. This exact file is TRACKED in that tree, and its blob matches HEAD. A copy dropped into a
#      foreign repository is untracked there, which is the cheap and decisive discriminator.
#   3. The tree knows the commit the release pin attests, so the pin can be compared against real
#      history rather than against a string.
#
# WHAT IT DELIBERATELY DOES NOT DO: require `HEAD == release_artifact.source_commit`. The commit that
# RECORDS a pin necessarily comes after the run that produced the candidate, so that equality would
# make committing a pin impossible. The identity that matters is the checkout's, not the tip's.
#
# It runs HERE, before the docs scan, before the rebuild at `cargo build-sbf` and before
# `MANIFEST_JSON` is even assigned, so a foreign tree is refused before anything reads or rebuilds it.
# `scripts/test-verifier-root-identity.sh` asserts that ordering from a `bash -x` trace rather than
# from the exit code, because "refused" and "refused for the right reason" are different facts.
if ! command -v git >/dev/null 2>&1; then
  echo ""
  echo "REFUSING TO RUN: git is not available, so this script cannot establish which repository it"
  echo "belongs to. ROOT selects the manifest, the sources and the target/ that get attested."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi
_toplevel="$(cd -P "$ROOT" && git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$_toplevel" ]; then
  echo ""
  echo "REFUSING TO RUN: $ROOT is not inside a Git working tree, so nothing authenticates the sources"
  echo "this script would rebuild and attest."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi
# Compare RESOLVED paths: ROOT went through `cd -P`, and on macOS /var is a symlink to /private/var,
# so a raw string comparison fails on a perfectly correct checkout.
_toplevel="$(cd -P "$_toplevel" && pwd)"
if [ "$_toplevel" != "$ROOT" ]; then
  echo ""
  echo "REFUSING TO RUN: this script sits at $ROOT but the enclosing Git tree is $_toplevel."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi
# THE IDENTITY GATE. Fourth design, and the first one that states its own limit.
#
# WHAT THREE PREVIOUS ATTEMPTS GOT WRONG, in order:
#   1. "is this file TRACKED here" fell to `git init && git add -A && git commit`.
#   2. "does this tree contain the attested source commit" only fires once a candidate is pinned, and
#      the status is `no-candidate`, so it never fired.
#   3. "does this tree CONTAIN the anchor commit" fell to a foreign clone placed on an ORPHAN commit:
#      the anchor object is public, `git cat-file -e` finds it, and containment says nothing about
#      where HEAD is. Codex reproduced it: foreign_head=4f69c71, is-ancestor exit 1, cat-file exit 0,
#      gate passed.
#
# THE LIMIT, stated once so nobody has to rediscover it a fourth time. This script LIVES IN the tree
# it authenticates. Whoever can prepare that tree can also delete these lines. No gate written here
# can defend against that, and any claim that it does is false. What this gate defends against is an
# operator running the verifier from the WRONG tree: a stale clone, a dirty worktree, a fork, a
# copy. That is the realistic failure, and it is the one being closed. Against a prepared tree the
# control is procedural and lives OUTSIDE this file: obtain the verifier from a separately fetched
# clone at a signed tag, and compare its blob hash out of band. `docs/MAINNET_LAUNCH_RUNBOOK.md`
# carries that procedure.
#
# Within that limit, four facts are established, each refusing BEFORE the docs scan, before
# `MANIFEST_JSON` is assigned and before the rebuild.

# (a) ANCESTRY, not containment. The anchor must be reachable FROM HEAD. A clone that merely owns the
#     object fails this; only a checkout whose history actually passes through it succeeds. This is
#     the single line that kills Codex's orphan reproduction.
ANCHOR_COMMIT="1314be417bfbdcea861bb75047964e722a8eada9"
if ! (cd -P "$ROOT" && git merge-base --is-ancestor "$ANCHOR_COMMIT" HEAD 2>/dev/null); then
  echo ""
  echo "REFUSING TO RUN: $ANCHOR_COMMIT is not an ancestor of HEAD in the tree at $ROOT."
  echo "That commit is on this repository's protected main branch, so every genuine checkout"
  echo "descends from it. Merely POSSESSING the object is not enough and is not checked: a clone"
  echo "parked on an unrelated commit owns it too."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi

# THE CLOSED LIST, declared HERE because (b) below compares it across a merge and (c) compares it
# against HEAD. Declaring it after its first use made the merge path silently compare NOTHING.
BUILD_INPUTS="programs Cargo.toml Cargo.lock rust-toolchain.toml Anchor.toml scripts/verify-release-artifact.sh scripts/_read-release-pin.py scripts/_strict-build-sbf.sh"
#     ROUND 8 FINAL-02. `scripts/_strict-build-sbf.sh` was missing, and it is the script that
#     actually RUNS the rebuild (line ~326). A hand-written list is a list someone forgets to update,
#     so `scripts/test-verifier-root-identity.sh` now DERIVES the set of repo scripts this file
#     invokes and fails if any of them is absent from the line above. The list stays literal here
#     because it must be readable at a glance in an audited file; the derivation is the guard.

# (b) HEAD IS SIGNED BY A PINNED KEY. A commit hash is public; a signing key is not. This is the only
#     fact here an attacker cannot obtain by cloning. The allowed-signers file is written from a key
#     pinned BELOW rather than read from the user's git config, because a check that depends on the
#     operator's local configuration is a check the operator can be missing without noticing, and CI
#     runners have no such configuration at all.
#     Caveat, per THE LIMIT above: the pinned key sits in this file, so a tree-preparer can swap it.
#     It raises the bar from "clone a public repo" to "edit the audited verifier", which is a
#     detectable act. It does not make the gate unconditional.
RELEASE_SIGNER_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKz73pnCUcRB2YNuMQFWQZb46U7PF05XEltkVkTg93mB"
RELEASE_SIGNER_ID="toblanc34@gmail.com"
_signers="$(mktemp)"
printf '%s %s\n' "$RELEASE_SIGNER_ID" "$RELEASE_SIGNER_KEY" > "$_signers"
_verify_commit() {
  (cd -P "$ROOT" && git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$_signers" \
      verify-commit "$1" >/dev/null 2>&1)
}

# ROUND 8 FINAL-01. A MERGE IS NOT SIGNED BY US, AND DEMANDING THAT IT IS MADE CI IMPOSSIBLE.
#
# The first version required HEAD itself to carry the pinned signature. The file even said "a merge
# commit created by the forge is signed by the FORGE, not by this key", and then refused it. Since
# branch protection delivers through pull requests, `actions/checkout` puts HEAD on GitHub's
# synthetic merge on `pull_request` and on the real merge on `push` to main. The required checks
# therefore could not all go green on the only delivery shape the protection allows. Measured:
#
#     57de5e43 (owner commit, SSH-signed) : exit 0
#     1314be41 (real GitHub merge)        : exit 1   Commit: GitHub <noreply@github.com>, RSA
#
# WHAT IS ACTUALLY BEING AUTHENTICATED IS THE BYTES, NOT THE TIP. So a merge is accepted when one of
# its parents carries the pinned signature AND the BUILD INPUTS are byte-identical between that
# parent and HEAD. Everything outside the closed list may differ, which is what a merge legitimately
# does. GitHub's own key is deliberately NOT trusted: this needs no third-party identity, it needs
# the reviewed bytes to be the built bytes.
# THE OPERATIONAL EDGE, measured on this repository rather than assumed: both merges in history
# (1314be4, 3a4af1c) are true merge commits, committed by the forge, whose second parent is a
# branch tip we signed. That is the shape this accepts. Two shapes it does NOT accept, on purpose:
#   - a SQUASH merge, which has one unsigned parent whose build inputs differ, so nobody signed the
#     squashed bytes. If this repository ever switches to squash merging, this gate must change with
#     it, deliberately.
#   - a merge that pulled main forward THROUGH a build input. Then the merged bytes are genuinely
#     not the reviewed bytes, and re-signing the merge, or attesting from the branch tip, is the
#     correct answer rather than widening this.
_identity_ok=no
_identity_via=""
if _verify_commit HEAD; then
  _identity_ok=yes
  _identity_via="HEAD is signed by the pinned release key"
else
  for _p in $( (cd -P "$ROOT" && git rev-list --parents -n 1 HEAD 2>/dev/null) | cut -d' ' -f2- ); do
    if _verify_commit "$_p" && (cd -P "$ROOT" && git diff --quiet "$_p" HEAD -- $BUILD_INPUTS 2>/dev/null); then
      _identity_ok=yes
      _identity_via="HEAD is a merge whose build inputs are identical to signed parent ${_p:0:12}"
      break
    fi
  done
fi
rm -f "$_signers"
if [ "$_identity_ok" != "yes" ]; then
  echo ""
  echo "REFUSING TO RUN: neither HEAD nor a parent whose build inputs match HEAD is signed by the"
  echo "pinned release key ($RELEASE_SIGNER_ID)."
  echo ""
  echo "A merge is accepted when a parent carries the signature AND the build inputs are unchanged"
  echo "across the merge, because what is attested is the reviewed BYTES and not the tip. A merge"
  echo "that CHANGED a build input is refused on purpose: nobody signed those bytes."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi
echo "  identity   : $_identity_via"

# (c) THE BYTES ON DISK ARE HEAD'S BYTES, for everything that gets rebuilt or attested. Without this,
#     every fact above is about a commit and none of them is about the files the rebuild will read.
#     A dirty worktree is the realistic accident this catches, and it is also the cheapest way to
#     attest something that was never committed.
#     The manifest is deliberately NOT in this list, and that is a distinction worth keeping. This
#     list is what gets REBUILT: sources, lockfile, toolchain, plus the checker itself. The manifest
#     is the CLAIM being checked. Binding it to HEAD conflates the two and would forbid the one
#     legitimate reason to hold an uncommitted pin: reading a candidate before recording it. It loses
#     nothing, because a manifest that lies is caught downstream by its own path: `validate_pinned`
#     requires the source commit to exist, (d) below requires it to be an ancestor with identical
#     inputs, and the rebuilt hash is then compared against the pinned one.
_dirty="$(cd -P "$ROOT" && git status --porcelain -- $BUILD_INPUTS 2>/dev/null || true)"
if [ -n "$_dirty" ]; then
  echo ""
  echo "REFUSING TO RUN: the build inputs differ from HEAD in $ROOT."
  echo "$_dirty"
  echo ""
  echo "The facts established above are about a COMMIT. They say nothing about a file that was"
  echo "edited after it. Commit or stash, then re-run."
  echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
  exit 1
fi

# (d) WHEN A CANDIDATE IS PINNED, THE REBUILT INPUTS ARE THE ATTESTED COMMIT'S INPUTS. This is the
#     fact the whole script exists to support, and no previous version had it. HEAD cannot EQUAL
#     `source_commit`: the commit that RECORDS a pin necessarily comes after the run that produced
#     the candidate. So the requirement is narrower and exact: `source_commit` is an ancestor of HEAD,
#     and the BUILD INPUTS are byte-identical between the two. Everything outside that closed list
#     (docs, the pin record itself, apps, tests) may legitimately differ, which is precisely what
#     lets a pin be committed at all.
_pin_commit="$(cd -P "$ROOT" && python3 -c "
import json,sys
try: r=json.load(open('config/mainnet-authorities.json'))['release_artifact']
except Exception: sys.exit(0)
if r.get('status')=='pinned' and r.get('source_commit'): print(r['source_commit'])
" 2>/dev/null || true)"
if [ -n "$_pin_commit" ]; then
  if ! (cd -P "$ROOT" && git merge-base --is-ancestor "$_pin_commit" HEAD 2>/dev/null); then
    echo ""
    echo "REFUSING TO RUN: the pinned source_commit $_pin_commit is not an ancestor of HEAD."
    echo "The rebuild would attest sources that are not descended from the commit the pin names."
    echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
    exit 1
  fi
  _drift="$(cd -P "$ROOT" && git diff --name-only "$_pin_commit" HEAD -- $BUILD_INPUTS 2>/dev/null || true)"
  if [ -n "$_drift" ]; then
    echo ""
    echo "REFUSING TO RUN: build inputs changed between the pinned source_commit $_pin_commit"
    echo "and HEAD:"
    echo "$_drift"
    echo ""
    echo "A rebuild here does not reproduce the pinned artifact, so comparing its hash to the pin"
    echo "would compare two different programs and call the difference a mismatch, or worse, a match."
    echo "Attest from $_pin_commit, or record a new pin."
    echo "ARTIFACT REJECTED: the verifier cannot establish which tree it belongs to."
    exit 1
  fi
fi

_stray=$(grep -rnoE --include="*.md" "\b[0-9a-f]{64}\b" "$ROOT/docs" 2>/dev/null || true)
if [ -n "$_stray" ]; then
  echo ""
  echo "A bare sha256 appears in docs/. The release hash has ONE home:"
  echo "      config/mainnet-authorities.json -> release_artifact"
  echo "      Replace the literal with a pointer to that file plus 'bash scripts/verify-release-artifact.sh'."
  echo "$_stray"
  # Verdict LAST, same contract as every other exit path in this file. It used to end on the grep
  # output, so `... | tail -1` returned a bare 64-hex string: pasted into the launch checklist this
  # script's header says its final line feeds, that reads as the release hash rather than a refusal.
  echo "ARTIFACT REJECTED: a bare sha256 is present in docs/. DO NOT DEPLOY THIS FILE."
  exit 1
fi
MANIFEST="$ROOT/programs/dominion_silver_mint_v2/Cargo.toml"
SKIP_REBUILD=0
LOCAL_ONLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --skip-rebuild) SKIP_REBUILD=1 ;;
    --local-only)   LOCAL_ONLY=1 ;;
    *)              ARGS+=("$a") ;;
  esac
done
# Set by check 1b when the pin could not be evaluated. Read at the very bottom, and it is what makes
# the LAST LINE and the EXIT CODE agree with each other.
not_attested=0
not_attested_why=""
SO="${ARGS[0]:-$ROOT/target/deploy/dominion_silver_mint.so}"
IDL="${ARGS[1]:-$ROOT/target/idl/dominion_silver_mint.json}"
LIB_RS="$ROOT/programs/dominion_silver_mint_v2/src/lib.rs"

FORBIDDEN_IX=(probe_oracle_price dev_set_max_staleness dev_set_premiums)

echo "Verifying release artifact"
echo "  so:  $SO"
echo "  idl: $IDL"
echo

if [[ ! -f "$SO" ]]; then
  echo "Build it: cargo build-sbf --manifest-path $MANIFEST"
  # Verdict last, same rule as every other exit path in this script.
  echo "ARTIFACT REJECTED: no .so at $SO. DO NOT DEPLOY THIS FILE."
  exit 1
fi

fail=0

# ---- 1. Primary gate: reproducible rebuild with default features ----
if [[ "$SKIP_REBUILD" -eq 1 ]]; then
  echo "1. Reproducible rebuild: SKIPPED (--skip-rebuild). This is the only check"
  echo "   that catches a no-log-ix-name build. Do not skip it before a deploy."
else
  echo "1. Reproducible rebuild with the default feature set"
  TMPDIR_BUILD="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_BUILD"' EXIT
  # The reference build gets its OWN CARGO_TARGET_DIR. --sbf-out-dir only moves the final .so, so
  # compilation would otherwise reuse the shared target/ that CI restores from a Cargo.lock-keyed
  # cache: a tampered rlib would be linked into both sides and the hashes would agree.
  # ROUND 8 F-03. Through the shared strict builder, which treats a stack-overflow line as fatal even
  # when cargo exits 0. This rebuild is the REFERENCE the artifact is compared against: an overflow
  # here reproduces on both sides, so the hashes would agree and the comparison would bless corrupted
  # bytes. The previous version captured build.log and only read it when the exit code was non-zero,
  # which is precisely the case that never happens for this defect.
  if ! CARGO_TARGET_DIR="$TMPDIR_BUILD/target" \
      bash "$ROOT/scripts/_strict-build-sbf.sh" --manifest-path "$MANIFEST" --sbf-out-dir "$TMPDIR_BUILD" -- --locked >"$TMPDIR_BUILD/build.log" 2>&1; then
    echo "   FAIL: the default-feature rebuild did not succeed or overflowed the BPF stack"
    tail -8 "$TMPDIR_BUILD/build.log" | sed 's/^/     /'
    echo "ARTIFACT REJECTED: the reference rebuild failed. DO NOT DEPLOY THIS FILE."
    exit 1
  fi
  REF="$TMPDIR_BUILD/dominion_silver_mint.so"
  if [[ ! -f "$REF" ]]; then
    echo "   FAIL: rebuild produced no artifact at $REF"
    echo "ARTIFACT REJECTED: the reference rebuild produced nothing. DO NOT DEPLOY THIS FILE."
    exit 1
  fi
  h_have="$(shasum -a 256 "$SO" | awk '{print $1}')"
  h_ref="$(shasum -a 256 "$REF" | awk '{print $1}')"
  if [[ "$h_have" != "$h_ref" ]]; then
    echo "   FAIL: the artifact does NOT match a clean default-feature rebuild."
    echo "     artifact: $h_have"
    echo "     rebuild:  $h_ref"
    echo "   The artifact was built with extra features, from different source, or"
    echo "   with a different toolchain. Do not deploy it."
    fail=1
  else
    echo "   ok: byte-identical to a clean default rebuild on THIS host ($h_ref)"
  fi

  # ---- 1b. And that is NOT the same claim as matching the release pin ----
  #
  # S-07, measured 2026-08-07. Check 1a compares two builds made on the SAME machine, so it proves the
  # artifact is a clean default build here. It says NOTHING about whether it matches what ships, because
  # SBF builds are not deterministic across host platforms: our .so embeds
  # /Users/runner/work/platform-tools/... paths baked into the macOS-built platform-tools std, and the
  # linux-x86_64 tarball carries /home/runner/... of a different length, shifting every rodata offset
  # after it. macOS and Linux disagree at v1.51 AND at v1.52.
  #
  # The Solana docs state it directly: "Solana program builds are not deterministic across different
  # systems", and "make sure that you actually deploy the verified build and don't accidentally overwrite
  # it with anchor build or cargo build-sbf". The RELEASE artifact is therefore a Linux container build
  # produced by `solana-verify build`, and release_artifact.sha256 pins THAT.
  #
  # So this check reports the comparison honestly instead of letting 1a's green imply something it cannot
  # mean. It FAILS only on linux/x86_64, where the two should agree.
  #
  # ROUND 5 P0-02: every branch below now sets `fail` or `not_attested`, and neither of them can end
  # at the `ARTIFACT OK` line. The branch that used to print EXPECTED MISMATCH and fall through to a
  # green conclusion is the third one.
  if [[ "$LOCAL_ONLY" -eq 1 ]]; then
    echo "1b. Release pin: NOT CHECKED (--local-only)"
    echo "   This run answers 'is this a clean default build of this tree' and nothing else."
    echo "   The release pin is the reproducible-build job's job."
  else
  # THE MANIFEST PATH IS NOT CONFIGURABLE. Round 6 R6-03: an earlier version of this script honoured
  # `DOMINION_RELEASE_MANIFEST` so the self-test could drive the state machine, and printed two loud
  # warnings when it was set. The warnings did not matter. What matters is the MACHINE contract, which
  # this script's own header declares to be the exit code and the final line: with an injected manifest
  # carrying the local .so's hash and size, it still exited 0 with `ARTIFACT OK`. An environment
  # variable inherited from a shell, a CI step or a wrapper was therefore a channel for a false release
  # attestation, and the self-test blessed it in its positive case.
  #
  # An attestation tool must have exactly ONE source of truth and no way to point it elsewhere. The
  # self-test now copies the repository into a temporary directory and edits ITS copy, which tests the
  # same state machine without leaving a door in production.
  #
  # $ROOT-anchored, not cwd-relative: the old form opened 'config/mainnet-authorities.json' against
  # whatever directory the caller happened to be in, so running this from anywhere but the repo root
  # silently took the unreadable branch.
  MANIFEST_JSON="$ROOT/config/mainnet-authorities.json"
  # ROUND 6 R6-07. THE `pinned` STATE HAS A CLOSED SCHEMA, and it is validated here rather than being
  # a set of fields the CI happens to write. Before this, the CI generated eight fields and every gate
  # compared three: `status`, `sha256`, `bytes`. `normalized_sha256` was consumed by nothing in the
  # repository, and the runbook accepted a null `idl_sha256` with an assertion that is vacuously true
  # when the pin is null. A pin entered by hand at runbook step 2c could therefore be incomplete or
  # internally inconsistent and still satisfy every check, while the manifest claimed "Every gate
  # compares against them".
  #
  # `schema` below is empty when the pin is coherent, or the list of what is wrong.
  read -r PIN_STATUS PINNED PIN_BYTES PIN_SCHEMA <<<"$(python3 "$ROOT/scripts/_read-release-pin.py" "$MANIFEST_JSON" "$ROOT" 2>/dev/null || echo "UNREADABLE - - -")"
  HOST_OS="$(uname -s)"; HOST_ARCH="$(uname -m)"
  echo "1b. The local artifact versus the PINNED release artifact"
  if [[ "$PIN_STATUS" == "UNREADABLE" || "$PIN_STATUS" == "MISSING" ]]; then
    echo "   FAIL: could not read release_artifact.status from config/mainnet-authorities.json"
    fail=1
  elif [[ "$PIN_STATUS" == "no-candidate" ]]; then
    # The honest state of this tree today. The mainnet program id does not exist yet, so the binary
    # that ships has not been built and there is nothing to compare against. Saying OK here would be
    # the same lie in a new place.
    echo "   NOT ATTESTED: release_artifact.status is 'no-candidate'."
    echo "     local : $h_have"
    echo "   No release candidate has been pinned yet. Round 6 R6-11: this used to say the source"
    echo "   still carried the devnet id and that step 2 would change declare_id!, which stopped"
    echo "   being true the moment the mainnet id was created, so the script printed a false reason"
    echo "   for a correct refusal."
    echo "   Pin the candidate from the reproducible-build job (runbook step 2c), never from a local"
    echo "   build: SBF builds are not deterministic across host platforms (S-07)."
    not_attested=1
    not_attested_why="no release candidate is pinned yet (release_artifact.status = no-candidate)"
  elif [[ "$PIN_STATUS" != "pinned" ]]; then
    echo "   FAIL: release_artifact.status is '$PIN_STATUS', which is neither 'pinned' nor 'no-candidate'."
    fail=1
  elif [[ "$PIN_SCHEMA" != "-" ]]; then
    # A pin that is INCOMPLETE or SELF-CONTRADICTORY is refused before its hash is even compared. The
    # hash matching would otherwise make an unusable pin look attested.
    echo "   FAIL: release_artifact.status is 'pinned' but the pin does not validate:"
    printf '     %s\n' "${PIN_SCHEMA//,/$'\n     '}"
    echo "   Re-record every field from the reproducible-build job's release-manifest.json."
    fail=1
  elif [[ "$h_have" == "$PINNED" ]]; then
    echo "   ok: the local artifact IS the pinned release artifact ($PINNED)"
    # Size is compared too, not merely printed (round 5 P2-01): two files can only share a sha256 by
    # accident nobody has ever produced, but a manifest whose bytes field disagrees with its own hash
    # is a manifest that was hand-edited, and that IS reachable.
    have_bytes="$(wc -c < "$SO" | tr -d ' ')"
    if [[ "$PIN_BYTES" != "-" && "$have_bytes" != "$PIN_BYTES" ]]; then
      echo "   FAIL: the hash matches but the size does not. The manifest disagrees with itself."
      echo "     artifact: $have_bytes bytes"
      echo "     manifest: $PIN_BYTES bytes"
      fail=1
    fi
  elif [[ "$HOST_OS" == "Linux" && ( "$HOST_ARCH" == "x86_64" || "$HOST_ARCH" == "amd64" ) ]]; then
    echo "   FAIL: on linux/x86_64 the local build should reproduce the pinned release artifact."
    echo "     local : $h_have"
    echo "     pinned: $PINNED"
    echo "   Either the pin is stale (re-record it from the reproducible-build job) or the source differs."
    fail=1
  else
    echo "   NOT ATTESTED on $HOST_OS/$HOST_ARCH, and this is not a defect of the artifact:"
    echo "     local : $h_have"
    echo "     pinned: $PINNED   (a linux/amd64 solana-verify container build)"
    echo "   This host CANNOT reproduce the release artifact, so it cannot attest it either."
    echo "   The deployable bytes come from CI: solana-verify build, job reproducible-build."
    not_attested=1
    not_attested_why="$HOST_OS/$HOST_ARCH cannot reproduce a linux/amd64 container build (S-07)"
  fi
  fi
fi

# ---- 2. Secondary: forbidden name strings (no pipeline, so no SIGPIPE) ----
echo "2. Forbidden instruction names as strings (secondary signal)"
( python3 - "$SO" "${FORBIDDEN_IX[@]}" <<'PY'
import sys
blob = open(sys.argv[1], "rb").read()
bad = []
for name in sys.argv[2:]:
    pascal = "".join(p.capitalize() for p in name.split("_"))
    for probe in (name, pascal):
        if blob.find(probe.encode()) != -1:
            print(f"   FAIL: string '{probe}' present in the binary")
            bad.append(probe)
if not bad:
    print("   ok: none of the forbidden names appear")
sys.exit(1 if bad else 0)
PY
# `|| fail=1` must sit on the command itself: under `set -e` a later `$?` test is dead code.
) || fail=1

# ---- 3. IDL must exist and must not advertise the forbidden instructions ----
echo "3. IDL"
if [[ ! -f "$IDL" ]]; then
  # A missing IDL is a FAILURE, not a skip: an unverifiable IDL is not a pass.
  echo "   FAIL: IDL not found at $IDL"
  echo "   regenerate: (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)"
  fail=1
else
  # The IDL address is ASSERTED against declare_id!, not merely printed: an IDL describing a
  # different program is the drift that ships a console pointed at the wrong deployment.
  ( python3 - "$IDL" "$LIB_RS" "${FORBIDDEN_IX[@]}" <<'PY'
import json, re, sys
idl = json.load(open(sys.argv[1]))
src = open(sys.argv[2]).read()
names = [i["name"] for i in idl.get("instructions", [])]
bad = [n for n in sys.argv[3:] if n in names]
for n in bad:
    print(f"   FAIL: '{n}' is present in the IDL")
if not bad:
    print(f"   ok: {len(names)} instructions, none forbidden")

m = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', src)
if not m:
    print("   FAIL: could not find declare_id! in the program source")
    sys.exit(1)
declared, addr = m.group(1), idl.get("address")
if addr != declared:
    print(f"   FAIL: idl address {addr} != declare_id! {declared}")
    bad.append("address-mismatch")
else:
    print(f"   ok: idl address == declare_id! ({declared})")
sys.exit(1 if bad else 0)
PY
  ) || fail=1
fi

echo "4. Release record"
echo "   sha256: $(shasum -a 256 "$SO" | awk '{print $1}')"
echo "   bytes:  $(wc -c < "$SO" | tr -d ' ')"
echo
# THE ORDER OF THESE THREE BLOCKS IS THE CONTRACT (round 5 P0-02). Every path out of this script ends
# in exactly one of them, each prints a DIFFERENT last line, and each exits a DIFFERENT code. The
# defect this replaces was a fall-through: a branch printed EXPECTED MISMATCH and then reached the
# OK line anyway, so the last line and the exit code both said something the script had just denied.
if [[ "$fail" -ne 0 ]]; then
  # THE VERDICT IS THE LAST LINE, on this path as on every other. It used to be followed by two lines
  # of build hints, so `... | tail -1` on a rejected run returned an anchor command. The whole reason
  # this script cares about its final line is that the final line is what gets pasted into a launch
  # checklist, and a build hint pasted there reads like a next step rather than a stop.
  echo "To rebuild with the default feature set:"
  echo "  cargo build-sbf --manifest-path $MANIFEST"
  echo "  (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)"
  echo "ARTIFACT REJECTED: at least one check above failed. DO NOT DEPLOY THIS FILE."
  exit 1
fi
# Skipping the rebuild exits 2, never 0: the LAST line is what gets pasted into a checklist.
if [[ "$SKIP_REBUILD" -eq 1 ]]; then
  echo "The reproducible rebuild was SKIPPED, so this is NOT a release attestation. A binary built"
  echo "with a feature flag can pass everything above. Re-run without --skip-rebuild before any deploy."
  # Verdict LAST. This was the one path the contract above did not hold for, and the self-test had
  # pinned the violation by asserting the trailing explanation as the expected final line.
  echo "ARTIFACT PARTIALLY CHECKED: secondary scans only. DO NOT DEPLOY THIS FILE."
  exit 2
fi
if [[ "$not_attested" -ne 0 ]]; then
  echo "ARTIFACT NOT ATTESTED: it is a clean default-feature build of this tree, and that is ALL"
  echo "this run establishes. It does NOT match, and could not be compared against, the release"
  echo "artifact that ships."
  echo "  reason: $not_attested_why"
  echo "  the deployable bytes come from the reproducible-build CI job."
  # REVIEW PASS ON 3bf3097: the DO-NOT-DEPLOY sentence used to be the last line here, so this was
  # the one path where `tail -1` did not start with ARTIFACT. The header promises uniformity.
  echo "ARTIFACT NOT ATTESTED. DO NOT DEPLOY THIS FILE."
  exit 3
fi

if [[ "$LOCAL_ONLY" -eq 1 ]]; then
  echo "The release pin was not checked (--local-only), so this is NOT a release attestation."
  echo "LOCAL BUILD OK: matches a clean default rebuild, no forbidden instruction."
  exit 0
fi
echo "ARTIFACT OK: reproduces the pinned release artifact, no forbidden instruction."
