#!/usr/bin/env bash
# ROUND 8 T8-02. Does `scripts/verify-release-artifact.sh` know WHICH repository it belongs to?
#
# THE FINDING. The script derives ROOT from its own location:
#     ROOT="$(cd -P "$(dirname "$_self")/.." && pwd)"
# and ROOT then selects the manifest it reads, the sources it rebuilds and the target/ it attests.
# Round 7 R7-02 closed two of the three aliasing shapes: a SYMLINK is resolved by `realpath`, and a
# HARD LINK is refused because `st_nlink != 1`. The third shape was left open. A COPY, or a MOVE, of
# a byte-identical script into a foreign Git repository has `st_nlink == 1` and resolves to itself,
# so the guard sees nothing wrong and the verifier attests THAT tree, against THAT tree's manifest,
# and prints its verdict about it.
#
# That matters because this script's output is the release attestation. Somebody handed a copy, or a
# tarball with the script inside it, gets a green verdict about a repository nobody audited, produced
# by a file that is byte-identical to the audited one and therefore passes every review of the file
# itself.
#
# WHAT THIS RUNNER ASSERTS, and why a substring of the output would not be enough. It runs the real
# script under `bash -x` with a PS4 carrying `${BASH_SOURCE}:${LINENO}`, and reads the TRACE. The two
# things a foreign run must never reach are:
#     the manifest assignment   MANIFEST_JSON="$ROOT/config/mainnet-authorities.json"
#     the reference rebuild     cargo build-sbf --manifest-path "$MANIFEST"
# Both take ROOT. Seeing either one carrying a FOREIGN path is the defect, and not seeing them is the
# fix. Comparing the final line and the exit code would not distinguish "refused for the right
# reason" from "refused because a foreign tree happened to be incomplete", which is precisely how a
# test in this repo has already passed for the wrong reason three times.
#
#   bash scripts/test-verifier-root-identity.sh
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
VERIFY_REL="scripts/verify-release-artifact.sh"
VERIFY="$REPO/$VERIFY_REL"
SO_REL="target/deploy/dominion_silver_mint.so"

TMP="$(mktemp -d)"
# The hard-link case creates a second name for the REAL script's inode. If it survives the run, the
# ORIGINAL is left with st_nlink=2 and every later invocation of the verifier, in this suite and out
# of it, refuses to run. That happened once already and turned a correct guard into a red suite.
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

pass=0
fail=0
ok()  { echo "ok: $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; fail=$((fail + 1)); }

if [[ ! -f "$REPO/$SO_REL" ]]; then
  echo "FAIL: $SO_REL does not exist, so no case here can reach the checks under test."
  echo "  Build it: cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked"
  echo "VERIFIER ROOT IDENTITY TEST FAILED"
  exit 1
fi

# The verifier must be a single-linked file before this suite starts, or the hard-link case cannot
# tell its own guard from a pre-existing condition.
start_nlink="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_nlink)' "$VERIFY")"
if [[ "$start_nlink" != "1" ]]; then
  echo "FAIL: $VERIFY_REL already has $start_nlink hard links before any case ran."
  echo "  Find and remove the extra names, then re-run:"
  echo "    find / -xdev -inum $(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_ino)' "$VERIFY") 2>/dev/null"
  echo "VERIFIER ROOT IDENTITY TEST FAILED"
  exit 1
fi

# ---------------------------------------------------------------- the foreign repository
#
# A real Git repository that is NOT this one. It carries everything the verifier needs to get past
# its early exits and reach the two ROOT-derived operations: a .so at the default path, a manifest,
# and a docs/ with no stray hashes. It deliberately carries NO program sources, so the reference
# rebuild fails in under a second: the defect is that the rebuild is ATTEMPTED against this tree, not
# that it succeeds, and paying 35 seconds to watch it succeed would prove the same thing slower.
make_foreign() {
  local dir="$1"
  mkdir -p "$dir/scripts" "$dir/config" "$dir/docs" "$dir/target/deploy" "$dir/target/idl"
  cp "$REPO/$SO_REL" "$dir/$SO_REL"
  cp "$REPO/target/idl/dominion_silver_mint.json" "$dir/target/idl/" 2>/dev/null || true
  # A manifest carrying a UNIQUE MARKER, so a trace that reads it is unambiguous about which file it
  # opened. Copied from the real one so the schema is realistic rather than a stub with the right keys.
  python3 - "$REPO/config/mainnet-authorities.json" "$dir/config/mainnet-authorities.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["_foreign_repository_marker"] = "THIS IS NOT THE AUDITED REPOSITORY"
json.dump(m, open(sys.argv[2], "w"), indent=2)
PY
  ( cd "$dir" \
    && git init -q \
    && git -c user.email=f@f -c user.name=f add -A >/dev/null 2>&1 \
    && git -c user.email=f@f -c user.name=f commit -qm "foreign tree" >/dev/null 2>&1 ) || return 1
}

# ---------------------------------------------------------------- the traced run
#
# Runs $1 (a path to some alias of the verifier) and writes the trace to $2. Returns the exit code.
# `--local-only` is NOT passed: it skips the pin comparison, which is half of what must not be
# reached. `--skip-rebuild` is not passed either, and that is a measured choice rather than a
# preference: it was verified on this tree that `--skip-rebuild` never reaches `MANIFEST_JSON` at
# all, because check 1b lives inside the `else` of the same `if`. A case built on it would assert
# that a line was not reached in a branch that never reaches it, which is the shape of false green
# that T8-05 exists to correct.
run_traced() {
  local script="$1" trace="$2"
  ( PS4='+${BASH_SOURCE}:${LINENO}: ' bash -x "$script" ) >"$trace" 2>&1
  return $?
}

# THE CANARY MUST COMPARE THE PATH THE SCRIPT ACTUALLY COMPUTED, not the one we handed it.
#
# The first version of this file grepped for the `mktemp -d` path and went GREEN on a tree that is
# demonstrably vulnerable, which is the exact false-green this suite exists to catch. On macOS
# `mktemp -d` answers /var/folders/..., `/var` is a symlink to `/private/var`, and the verifier
# derives ROOT with `cd -P`, so its trace says /private/var/folders/... . Two strings that can never
# match, and a canary that can never fire. Resolve first, and check BOTH spellings, because a Linux
# runner resolves to the same string it was given.
# The closed list the gate binds, mirrored here so the positive control asserts the SAME set the
# verifier checks rather than a set this test invented. If the two ever drift, the positive control
# is testing a property the product does not have.
POSITIVE_INPUTS="programs Cargo.toml Cargo.lock rust-toolchain.toml Anchor.toml scripts/verify-release-artifact.sh scripts/_read-release-pin.py scripts/_strict-build-sbf.sh"

# ================================================================ ROUND 8 FINAL-02
#
# DERIVE the set of repo scripts the verifier actually invokes, and require every one of them to be
# in its own BUILD_INPUTS. `_strict-build-sbf.sh` was missing: it is the script that runs the rebuild,
# so an edit to it changed the bytes being attested while the gate reported a clean tree.
#
# The point is not to add one path. A hand-written closed list is a list someone forgets to update,
# which is the same defect wearing a different name. This reads the production file and fails on the
# NEXT omission too.
derived_inputs_are_declared() {
  local missing="" declared invoked
  declared="$(grep -m1 '^BUILD_INPUTS=' "$VERIFY" | cut -d'"' -f2)"
  if [[ -z "$declared" ]]; then
    bad "could not read BUILD_INPUTS from the verifier, so this check proves nothing"
    return
  fi
  # Every `"$ROOT"/scripts/x` or `$ROOT/scripts/x` the verifier executes, comment lines excluded.
  invoked="$(grep -vE '^\s*#' "$VERIFY"     | grep -oE '\$\{?ROOT\}?"?/scripts/[A-Za-z0-9_.-]+'     | sed -E 's|.*/scripts/|scripts/|' | sort -u || true)"
  if [[ -z "$invoked" ]]; then
    bad "no invoked script was derived from the verifier, so this check is vacuous"
    return
  fi
  while read -r f; do
    [[ -z "$f" ]] && continue
    case " $declared " in
      *" $f "*) ;;
      *) missing="$missing $f" ;;
    esac
  done <<< "$invoked"
  if [[ -n "$missing" ]]; then
    bad "the verifier executes script(s) absent from its own BUILD_INPUTS:$missing"
    echo "     an edit to those changes the bytes attested while the gate reports a clean tree"
  else
    ok "every script the verifier executes is inside the inputs it binds to HEAD"
  fi
}


real_path() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

reached_foreign_manifest() {
  local d r; d="$1"; r="$(real_path "$1")"
  grep -q "MANIFEST_JSON=$d/config/mainnet-authorities.json" "$2" \
    || grep -q "MANIFEST_JSON=$r/config/mainnet-authorities.json" "$2"
}
reached_foreign_rebuild() {
  local d r; d="$1"; r="$(real_path "$1")"
  grep -q -- "--manifest-path $d/programs/" "$2" \
    || grep -q -- "--manifest-path $r/programs/" "$2"
}

# One line naming exactly what was reached, so a failure says which door opened.
what_was_reached() {
  local dir="$1" trace="$2" out=""
  reached_foreign_manifest "$dir" "$trace" && out="the foreign manifest read"
  if reached_foreign_rebuild "$dir" "$trace"; then
    [[ -n "$out" ]] && out="$out and the foreign rebuild" || out="the foreign rebuild"
  fi
  echo "$out"
}

derived_inputs_are_declared

echo "Verifier root identity (round 8 T8-02)"
echo "  repository : $REPO"
echo

# ================================================================ 1. symlink alias
#
# Round 7 R7-01. `realpath` resolves the link, so ROOT comes from the REAL file's directory and the
# foreign tree is never selected. Kept here because it is one of the three shapes and a future
# refactor that replaced `realpath` with `$0` would reopen it silently.
sym_dir="$TMP/sym"
if make_foreign "$sym_dir"; then
  ln -s "$VERIFY" "$sym_dir/scripts/verify-release-artifact.sh"
  run_traced "$sym_dir/scripts/verify-release-artifact.sh" "$TMP/sym.trace"
  if [[ -n "$(what_was_reached "$sym_dir" "$TMP/sym.trace")" ]]; then
    bad "a symlinked verifier selected the foreign repository root"
    echo "     reached: $(what_was_reached "$sym_dir" "$TMP/sym.trace")"
  else
    ok "symlink alias rejected or resolved to the authenticated checkout"
  fi
else
  bad "could not build the foreign repository for the symlink case"
fi

# ================================================================ 2. hard-link alias
#
# Round 7 R7-02. `st_nlink != 1` refuses. The link is removed IMMEDIATELY after the run, in this
# block, and not left to the EXIT trap: while it exists the ORIGINAL verifier also has st_nlink=2, so
# any later case in this file would be refused for a reason that has nothing to do with what it tests.
hard_dir="$TMP/hard"
if make_foreign "$hard_dir"; then
  hard_alias="$hard_dir/scripts/verify-release-artifact.sh"
  if ln "$VERIFY" "$hard_alias" 2>/dev/null; then
    run_traced "$hard_alias" "$TMP/hard.trace"
    hard_code=$?
    rm -f "$hard_alias"
    if [[ -n "$(what_was_reached "$hard_dir" "$TMP/hard.trace")" ]]; then
      bad "a hard-linked verifier selected the foreign repository root"
      echo "     reached: $(what_was_reached "$hard_dir" "$TMP/hard.trace")"
    elif [[ "$hard_code" -ne 1 ]]; then
      bad "a hard-linked verifier did not refuse (exit $hard_code)"
    else
      ok "hard-link alias rejected"
    fi
  else
    # A cross-device temp directory cannot hold a hard link. That is an environment limitation and
    # not a pass: reporting it as ok would retire the case silently.
    bad "could not create a hard link into $TMP (cross-device?), so this case did not run"
  fi
else
  bad "could not build the foreign repository for the hard-link case"
fi

# Whatever happened above, the original must be single-linked again before the cases below.
now_nlink="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_nlink)' "$VERIFY")"
if [[ "$now_nlink" != "1" ]]; then
  bad "the hard-link case left $VERIFY_REL with st_nlink=$now_nlink; later cases cannot be trusted"
fi

# ================================================================ 3. a COPY in a foreign repository
#
# THE OPEN SHAPE. Byte-identical to the audited script, st_nlink=1, resolves to itself.
copy_dir="$TMP/copied"
if make_foreign "$copy_dir"; then
  cp "$VERIFY" "$copy_dir/scripts/verify-release-artifact.sh"
  chmod +x "$copy_dir/scripts/verify-release-artifact.sh"
  # Identical bytes, asserted rather than assumed: the whole point is that review of the FILE cannot
  # distinguish this from the audited one.
  if ! cmp -s "$VERIFY" "$copy_dir/scripts/verify-release-artifact.sh"; then
    bad "the copy is not byte-identical, so this case is not the one under test"
  fi
  run_traced "$copy_dir/scripts/verify-release-artifact.sh" "$TMP/copy.trace"
  copy_reached="$(what_was_reached "$copy_dir" "$TMP/copy.trace")"
  if [[ -n "$copy_reached" ]]; then
    bad "a byte-identical copied verifier selected the foreign repository root"
    echo "     reached: $copy_reached"
    echo "     trace  : $TMP/copy.trace"
  fi
else
  bad "could not build the foreign repository for the copy case"
  copy_reached="unknown"
fi

# ================================================================ 4. a MOVE into a foreign repository
#
# Same shape, arrived at differently, and stated separately because the guard that exists today keys
# on st_nlink: a MOVED file has exactly one link, so "one link" cannot be what makes a file canonical.
move_dir="$TMP/moved"
if make_foreign "$move_dir"; then
  cp "$VERIFY" "$TMP/staged-verifier.sh"
  mv "$TMP/staged-verifier.sh" "$move_dir/scripts/verify-release-artifact.sh"
  chmod +x "$move_dir/scripts/verify-release-artifact.sh"
  moved_nlink="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_nlink)' "$move_dir/scripts/verify-release-artifact.sh")"
  if [[ "$moved_nlink" != "1" ]]; then
    bad "the moved verifier has st_nlink=$moved_nlink, so this case is not the one under test"
  fi
  run_traced "$move_dir/scripts/verify-release-artifact.sh" "$TMP/move.trace"
  move_reached="$(what_was_reached "$move_dir" "$TMP/move.trace")"
  if [[ -n "$move_reached" ]]; then
    bad "a moved verifier selected the foreign repository root with st_nlink=1"
    echo "     reached: $move_reached"
    echo "     trace  : $TMP/move.trace"
  fi
else
  bad "could not build the foreign repository for the move case"
  move_reached="unknown"
fi

if [[ -z "${copy_reached:-}" && -z "${move_reached:-}" ]]; then
  ok "copied/moved verifier in a foreign Git repository rejected before manifest read"
fi

# ================================================================ 4b. a COMMITTED copy in a foreign repo
#
# THE CASE ROUND 8 FOUND, and the reason the tracked/blob heuristics were replaced by a history
# anchor. An attacker preparing a tree does not leave the script untracked: they `git init`, they
# `git add -A`, they commit. The copy is then tracked, its blob matches that tree's HEAD, and every
# check based on "is it tracked here" says yes. Only history separates the two, and history is the
# one thing a fabricated tree cannot produce.
committed_dir="$TMP/committed"
if make_foreign "$committed_dir"; then
  cp "$VERIFY" "$committed_dir/scripts/verify-release-artifact.sh"
  chmod +x "$committed_dir/scripts/verify-release-artifact.sh"
  ( cd "$committed_dir" \
    && git -c user.email=f@f -c user.name=f add -A >/dev/null 2>&1 \
    && git -c user.email=f@f -c user.name=f commit -qm "tracked here too" >/dev/null 2>&1 ) || true
  # Asserted, not assumed: if the copy is not actually tracked, this case is not the one under test.
  if ! ( cd "$committed_dir" && git ls-files --error-unmatch -- scripts/verify-release-artifact.sh >/dev/null 2>&1 ); then
    bad "the copy is not tracked in the foreign repository, so this case is not the one under test"
  fi
  run_traced "$committed_dir/scripts/verify-release-artifact.sh" "$TMP/committed.trace"
  committed_reached="$(what_was_reached "$committed_dir" "$TMP/committed.trace")"
  if [[ -n "$committed_reached" ]]; then
    bad "a COMMITTED copy in a foreign Git repository selected that repository's root"
    echo "     reached: $committed_reached"
    echo "     trace  : $TMP/committed.trace"
  else
    ok "committed copy in a prepared foreign repository rejected: it lacks our history"
  fi
else
  bad "could not build the foreign repository for the committed-copy case"
fi

# ================================================================ 4c. a clone that OWNS the anchor, HEAD on an orphan
#
# THE CASE ROUND 8 REPRODUCED, and the reason `git cat-file -e` was replaced by `merge-base
# --is-ancestor`. A commit hash is public. Any clone, fetch or object alternate hands an attacker the
# anchor OBJECT, and containment then says nothing about where HEAD is. Codex placed a clone on an
# orphan commit with no ancestry to the anchor and measured: is-ancestor exit 1, cat-file exit 0,
# root_refused=no, reached_verifier_body=yes.
#
# This case IS that measurement, kept in the suite so the class cannot silently reopen. The
# preconditions are ASSERTED rather than assumed: if the sandbox does not actually own the anchor, or
# if HEAD is accidentally a descendant of it, this is a different case wearing this one's name, which
# is the exact defect (a label promising more than the body runs) that reopened T8-02 and T8-04.
orphan_dir="$TMP/orphan-owns-anchor"
ANCHOR="1314be417bfbdcea861bb75047964e722a8eada9"
if git clone -q --no-local "$REPO" "$orphan_dir" >/dev/null 2>&1 \
   || git clone -q "$REPO" "$orphan_dir" >/dev/null 2>&1; then
  ( cd "$orphan_dir" \
    && git fetch -q origin "$ANCHOR" >/dev/null 2>&1 || true )
  # Build the orphan: no parent, so no path from it to the anchor.
  ( cd "$orphan_dir" \
    && git checkout -q --orphan foreign-prepared >/dev/null 2>&1 \
    && git rm -rq --cached . >/dev/null 2>&1 || true )
  rm -rf "$orphan_dir/programs" "$orphan_dir/apps" "$orphan_dir/tools" 2>/dev/null || true
  mkdir -p "$orphan_dir/scripts" "$orphan_dir/config" "$orphan_dir/docs" \
           "$orphan_dir/target/deploy" "$orphan_dir/target/idl"
  cp "$VERIFY" "$orphan_dir/scripts/verify-release-artifact.sh"
  cp "$REPO/scripts/_read-release-pin.py" "$orphan_dir/scripts/" 2>/dev/null || true
  chmod +x "$orphan_dir/scripts/verify-release-artifact.sh"
  cp "$REPO/$SO_REL" "$orphan_dir/$SO_REL"
  cp "$REPO/target/idl/dominion_silver_mint.json" "$orphan_dir/target/idl/" 2>/dev/null || true
  python3 - "$REPO/config/mainnet-authorities.json" "$orphan_dir/config/mainnet-authorities.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["_foreign_repository_marker"] = "THIS IS NOT THE AUDITED REPOSITORY"
json.dump(m, open(sys.argv[2], "w"), indent=2)
PY
  ( cd "$orphan_dir" \
    && git -c user.email=f@f -c user.name=f add -A >/dev/null 2>&1 \
    && git -c user.email=f@f -c user.name=f commit -qm "prepared tree" >/dev/null 2>&1 ) || true

  owns_anchor=no; is_desc=no
  ( cd "$orphan_dir" && git cat-file -e "${ANCHOR}^{commit}" 2>/dev/null ) && owns_anchor=yes
  ( cd "$orphan_dir" && git merge-base --is-ancestor "$ANCHOR" HEAD 2>/dev/null ) && is_desc=yes

  if [[ "$owns_anchor" != "yes" ]]; then
    bad "the orphan sandbox does not own the anchor object, so it does not exercise this class"
    echo "     this case only means something when cat-file SUCCEEDS and ancestry FAILS"
  elif [[ "$is_desc" != "yes" ]]; then
    run_traced "$orphan_dir/scripts/verify-release-artifact.sh" "$TMP/orphan.trace"
    orphan_reached="$(what_was_reached "$orphan_dir" "$TMP/orphan.trace")"
    if [[ -n "$orphan_reached" ]]; then
      bad "a clone OWNING the anchor with HEAD on an orphan selected that tree as canonical"
      echo "     owns anchor object: $owns_anchor, ancestor of HEAD: $is_desc"
      echo "     reached: $orphan_reached"
      echo "     trace  : $TMP/orphan.trace"
    elif ! grep -q "is not an ancestor of HEAD" "$TMP/orphan.trace"; then
      bad "the orphan clone was refused, but not by the ancestry gate"
      echo "     a refusal for an unrelated reason would move the moment this case is repaired"
      echo "     trace  : $TMP/orphan.trace"
    else
      ok "clone owning the anchor object with HEAD on an orphan refused by ancestry, before any read"
    fi
  else
    bad "the orphan sandbox HEAD descends from the anchor, so it is not the case under test"
  fi
else
  bad "could not clone the repository for the owns-anchor orphan case"
fi

# ================================================================ 4d. a genuine checkout with a DIRTY build input
#
# The realistic accident, and the cheapest way to attest bytes that were never committed. Every fact
# the gate establishes is about a COMMIT; none of them is about a file edited after it. Run in a
# throwaway worktree of this very repository, so the only thing separating it from the accepted case
# below is one uncommitted byte.
dirty_dir="$TMP/dirty"
if git -C "$REPO" worktree add --detach "$dirty_dir" HEAD >/dev/null 2>&1; then
  mkdir -p "$dirty_dir/target/deploy" "$dirty_dir/target/idl"
  cp "$REPO/$SO_REL" "$dirty_dir/$SO_REL"
  cp "$REPO/target/idl/dominion_silver_mint.json" "$dirty_dir/target/idl/" 2>/dev/null || true
  printf '\n# uncommitted edit, never reviewed, never signed\n' >> "$dirty_dir/Cargo.toml"
  ( cd "$dirty_dir" && PS4='+${BASH_SOURCE}:${LINENO}: ' bash -x scripts/verify-release-artifact.sh --skip-rebuild ) \
    >"$TMP/dirty.trace" 2>&1 || true
  git -C "$REPO" worktree remove --force "$dirty_dir" >/dev/null 2>&1
  git -C "$REPO" worktree prune >/dev/null 2>&1
  if ! grep -q "the build inputs differ from HEAD" "$TMP/dirty.trace"; then
    bad "a worktree with an uncommitted change to Cargo.toml was not refused"
    echo "     trace  : $TMP/dirty.trace"
  else
    ok "genuine checkout with an uncommitted build input refused before any read"
  fi
else
  bad "could not create a worktree for the dirty-input case"
fi

# ================================================================ 5. the genuine checkout
#
# The negative control, and the reason the four cases above are not simply "refuse everything". A
# real, authenticated Git worktree of THIS repository must still be accepted as canonical. Without
# this case a fix that refused unconditionally would score 3/3 and brick every release attestation.
#
# `--skip-rebuild` here on purpose: the identity check belongs BEFORE the manifest read and before
# the rebuild, so it is exercised on this fast path, and the 35-second rebuild proves nothing about
# identity.
#
# THE ASSERTION IS DELIBERATELY NARROW, and the first version of it was wrong in a way worth keeping
# on the page. It also demanded exit 2, the code `--skip-rebuild` produces. Run against the round-7
# baseline that has no generated `target/idl`, the verifier failed the IDL check and exited 1, and
# this case reported "a genuine worktree was refused as non-canonical". It had not been refused at
# all: an unrelated check had failed. A negative control that moves with checks it does not test is
# a control that will one day accuse the wrong thing.
#
# So: two conditions, both about identity and nothing else. No refusal marker, and the trace shows
# ROOT resolved to THIS worktree, which is what proves the run identified its own tree as canonical
# and carried on rather than passing vacuously after dying early.
work_dir="$TMP/worktree"
if git -C "$REPO" worktree add --detach "$work_dir" HEAD >/dev/null 2>&1; then
  mkdir -p "$work_dir/target/deploy" "$work_dir/target/idl"
  cp "$REPO/$SO_REL" "$work_dir/$SO_REL"
  cp "$REPO/target/idl/dominion_silver_mint.json" "$work_dir/target/idl/" 2>/dev/null || true
  ( cd "$work_dir" && PS4='+${BASH_SOURCE}:${LINENO}: ' bash -x scripts/verify-release-artifact.sh --skip-rebuild ) \
    >"$TMP/genuine.trace" 2>&1
  git -C "$REPO" worktree remove --force "$work_dir" >/dev/null 2>&1
  git -C "$REPO" worktree prune >/dev/null 2>&1
  work_real="$(real_path "$work_dir")"
  if grep -qi "REFUSING TO RUN\|cannot establish which tree" "$TMP/genuine.trace"; then
    bad "a genuine authenticated worktree was refused as non-canonical"
    echo "     trace  : $TMP/genuine.trace"
  elif ! grep -q "ROOT=$work_real\$" "$TMP/genuine.trace" && ! grep -q "ROOT=$work_dir\$" "$TMP/genuine.trace"; then
    bad "the genuine worktree run never resolved ROOT to itself, so it proves nothing"
    echo "     trace  : $TMP/genuine.trace"
  elif ! ( cd "$REPO" && git diff --quiet HEAD -- $POSITIVE_INPUTS ) ; then
    bad "the positive control claims the build inputs match HEAD but they do not"
    echo "     the label of this case must never promise more than its body runs"
  else
    ok "genuine authenticated worktree whose build inputs match HEAD accepted as canonical"
  fi
else
  bad "could not create a Git worktree for the genuine case, so the negative control did not run"
fi

# ================================================================ verdict
total=$((pass + fail))
echo
if [[ "$total" -eq 0 ]]; then
  echo "VERIFIER ROOT IDENTITY TEST FAILED: zero cases ran, so nothing was proved"
  exit 1
fi
if [[ "$fail" -ne 0 ]]; then
  echo "VERIFIER ROOT IDENTITY TEST FAILED"
  exit 1
fi
echo "VERIFIER ROOT IDENTITY TEST OK: $pass/$total"
