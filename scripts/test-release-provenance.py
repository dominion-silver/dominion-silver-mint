#!/usr/bin/env python3
"""ROUND 8 T8-04, local half. The release pin must not accept INVENTED values.

`validate_pinned` checked shapes: 40 hex characters for the source commit, non-empty for the CI run
id and the solana-verify version. Shape is not provenance. `0000...0` is 40 hex characters and names
no commit; `invented-run` and `invented-tool` are non-empty and name nothing at all. A pin that
passes every check while describing a build nobody can find is the failure this closes.

It calls the REAL `validate_pinned` out of `_read-release-pin.py`, never a copy of its logic: a test
that reimplemented the rules would agree with whatever the rules currently are, which is the one
thing it must not do.

    python3 scripts/test-release-provenance.py
"""
import importlib.util
import json
import tempfile
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

spec = importlib.util.spec_from_file_location(
    "read_release_pin", os.path.join(ROOT, "scripts", "_read-release-pin.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
validate_pinned = mod.validate_pinned

failures = []


def ok(msg: str) -> None:
    print(f"ok: {msg}")


def bad(msg: str) -> None:
    print(f"FAIL: {msg}")
    failures.append(msg)


def head_commit() -> str:
    return subprocess.run(
        ["git", "-C", ROOT, "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()


def base_pin() -> dict:
    """A pin whose every OTHER field is coherent, so each case below isolates one invented value.

    The artifact fields are taken from the manifest when it carries them, so the cross-checks that
    recompute from this checkout do not fire and drown the field under test."""
    manifest = json.load(open(os.path.join(ROOT, "config", "mainnet-authorities.json")))
    rel = dict(manifest.get("release_artifact") or {})
    lib = open(os.path.join(ROOT, "programs/dominion_silver_mint_v2/src/lib.rs")).read()
    import re as _re

    program_id = _re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', lib).group(1)
    import hashlib

    idl_path = os.path.join(ROOT, "target/idl/dominion_silver_mint.json")
    idl_sha = (
        hashlib.sha256(open(idl_path, "rb").read()).hexdigest()
        if os.path.exists(idl_path)
        else "0" * 64
    )
    rel.update(
        status="pinned",
        sha256="a" * 64,
        normalized_sha256="b" * 64,
        program_id=program_id,
        idl_sha256=idl_sha,
        source_commit=head_commit(),
        bytes=1_234_567,
        ci_run_id="1234567890",
        solana_verify_version="0.5.1",  # the bare semver the manifest and CI actually carry
    )
    return rel


def rejects(label: str, field: str, value, needle: str) -> None:
    pin = base_pin()
    pin[field] = value
    bad_list = validate_pinned(pin, ROOT)
    hit = [b for b in bad_list if needle in b]
    if hit:
        ok(label)
    else:
        bad(f"{field}={value} was accepted")


def main() -> None:
    # The positive control FIRST. If a coherent pin is refused, every rejection below passes for the
    # wrong reason.
    base_bad = validate_pinned(base_pin(), ROOT)
    if base_bad:
        bad(f"a coherent pin was refused: {base_bad}")
    else:
        ok("a coherent pin is accepted, so the rejections below mean something")

    rejects(
        "nonexistent source commit rejected",
        "source_commit",
        "0" * 40,
        "source_commit",
    )
    rejects("non-numeric CI run id rejected", "ci_run_id", "invented-run", "ci_run_id")
    rejects(
        "unapproved solana-verify version rejected",
        "solana_verify_version",
        "invented-tool",
        "solana_verify_version",
    )

    # THE CASE THAT WAS DELETED, and why.
    # It was called "mismatched run/source/artifact tuples rejected" and it passed `"de" * 20`, which
    # is not a commit in this tree. So it re-ran the "nonexistent source commit" case above under a
    # name that promised something else entirely: that an EXISTING but INCOHERENT tuple is caught.
    # measured the real behaviour against `validate_pinned` with `1314be4` (a real commit), an
    # invented numeric run id and an invented semver, and got `invented_numeric_tuple_problems=[]`.
    # Accepted, silently, while the green line claimed the opposite.
    # The honest replacement is NOT another local case. Nothing local can catch it: coherence between
    # a commit, a CI run and a set of bytes is a fact about GitHub, and this validator says so in its
    # own docstring. So the case is replaced by an assertion that the validator does not PRETEND to
    # have caught it, plus the explicit record that the live check is the only thing that can.
    live_only = {
        "source_commit": "1314be417bfbdcea861bb75047964e722a8eada9",  # real, and unrelated to any run
        "ci_run_id": "99999999999",
        "solana_verify_version": "0.5.1",
    }
    pin = base_pin()
    pin.update(live_only)
    problems = validate_pinned(pin, ROOT)
    if problems:
        bad(
            "the local validator now claims to reject an incoherent-but-well-formed tuple.\n"
            f"      it reported {problems}\n"
            "      If that is a real new capability, replace this case with one that proves it.\n"
            "      If it is not, the message is over-claiming again, which is what A-04 was."
        )
    else:
        ok(
            "an incoherent but well-formed tuple is ACCEPTED locally, as documented: "
            "provenance is a live check, not a shape check"
        )

    # -06. THE PRODUCER IS EXECUTED, not restated.
    # The previous version wrote its own three strings and called them "the REAL produced string".
    # A workflow regressing to `.stdout.strip()` would start writing "solana-verify 0.5.1" again while
    # this test stayed green on its own literal. Both sides now call
    # `scripts/_solana_verify_version.py`, so a regression there turns THIS red.
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import _solana_verify_version as svv

    # A fake `solana-verify` on PATH emitting the line the real tool emits, so `measured()` runs the
    # whole production path (subprocess included) rather than just its parser.
    with tempfile.TemporaryDirectory() as fake_bin:
        stub = os.path.join(fake_bin, "solana-verify")
        with open(stub, "w") as fh:
            fh.write("#!/bin/sh\necho 'solana-verify 0.5.1'\n")
        os.chmod(stub, 0o755)
        prev = os.environ["PATH"]
        os.environ["PATH"] = fake_bin + os.pathsep + prev
        try:
            produced = svv.measured()
        finally:
            os.environ["PATH"] = prev
    if produced != "0.5.1":
        bad(
            f"the shared producer emitted {produced!r} from the real tool's line.\n"
            "      The installer feeds this to `cargo install --version`, which needs a bare semver."
        )
    else:
        ok("the shared producer turns the real --version line into the bare semver CI installs")

    # And the value it produces must be one the consumer accepts. This is the join the operational
    # defect lived in: producer and consumer were each internally consistent and disagreed.
    pin = base_pin()
    pin["solana_verify_version"] = produced
    if any("solana_verify_version" in p for p in validate_pinned(pin, ROOT)):
        bad(f"the consumer rejects {produced!r}, the exact value the producer writes")
    else:
        ok("the value the producer writes is the value the consumer accepts")

    # The refusals, driven through the same shared function.
    # NOT "solana-verify 0.5.1": extracting the token from that line is the function's JOB. What it
    # must refuse is a line whose last token is not a semver, because that is a version CI cannot
    # install and guessing one would pin a tool nobody chose.
    for raw in ("0.5", "", "solana-verify beta", "solana-verify"):
        try:
            svv.bare_semver(raw)
        except SystemExit:
            continue
        bad(f"the shared producer accepted {raw!r}, which cargo install cannot use")

    if failures:
        print(f"\nRELEASE PROVENANCE TEST FAILED: {len(failures)} invented values accepted")
        sys.exit(1)
    print("\nRELEASE PROVENANCE TEST OK")


main()
