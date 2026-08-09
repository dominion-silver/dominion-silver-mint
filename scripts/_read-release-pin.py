"""ROUND 6 R6-07. Read `release_artifact` and VALIDATE the `pinned` state as a closed schema.

Prints one line: `<status> <sha256|-> <bytes|-> <problems|->`, with problems comma-separated.
Callers: scripts/verify-release-artifact.sh and the reproducible-build job. One implementation, so the
local gate and CI cannot disagree about what a valid pin is.

THE DEFECT THIS CLOSES. The CI generated eight fields (`sha256`, `normalized_sha256`, `bytes`,
`program_id`, `source_commit`, `ci_run_id`, `solana_verify_version`, `idl_sha256`) and every gate
compared three. `normalized_sha256` was read by nothing in the repository even though it is the
convention `solana-verify verify-from-repo` compares against the chain, and the runbook accepted a
null `idl_sha256` behind `assert pin is None or a == pin`, which passes for any local IDL when the pin
is null. So a pin typed by hand at step 2c could be incomplete, or internally inconsistent, and still
satisfy everything, while the manifest asserted "Every gate compares against them".

What "valid" means here is deliberately narrow: every field present and well-formed, and the fields
that can be recomputed locally agreeing with what is on disk. It does NOT prove provenance; only the
CI run that produced the artifact can do that, and `ci_run_id` is what lets a human go and look.
"""

import hashlib
import json
import os
import re
import subprocess
import sys

HEX64 = re.compile(r"^[0-9a-f]{64}$")
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
# ROUND 8 T8-04. The convention this project actually uses, MEASURED rather than invented: the
# manifest and the CI job both carry a bare semver ("0.5.1"). A first version of this rule demanded
# "solana-verify <semver>" and rejected the real fixture, which is the same mistake as asserting a
# format without looking at the one in use. A leading "solana-verify " is tolerated because it is the
# tool's own `--version` output and an operator may paste it.
APPROVED_VERIFY = re.compile(r"^(solana-verify )?\d+\.\d+\.\d+$")


def validate_pinned(rel: dict, root: str) -> list[str]:
    """Every way a `pinned` block can be wrong, collected rather than short-circuited: an operator
    fixing one field at a time is an operator making several round trips."""
    bad: list[str] = []

    for field, pattern, what in (
        ("sha256", HEX64, "64 lowercase hex chars"),
        ("normalized_sha256", HEX64, "64 lowercase hex chars"),
        ("program_id", B58, "a base58 pubkey"),
        ("idl_sha256", HEX64, "64 lowercase hex chars"),
        ("source_commit", re.compile(r"^[0-9a-f]{40}$"), "a 40-char git sha"),
    ):
        v = rel.get(field)
        if v is None:
            bad.append(f"{field} is null")
        elif not isinstance(v, str) or not pattern.match(v):
            bad.append(f"{field} is not {what}")

    n = rel.get("bytes")
    if not isinstance(n, int) or n <= 0:
        bad.append("bytes is not a positive integer")
    # ROUND 8 T8-04. SHAPE IS NOT PROVENANCE, and these three fields only had shapes.
    #
    # `ci_run_id` and `solana_verify_version` were checked non-empty, so "invented-run" and
    # "invented-tool" passed. `source_commit` was checked as 40 hex characters, so a string of forty
    # zeros passed while naming no commit. A pin can therefore have described a build that never
    # happened, on a runner that never ran, with a tool that does not exist, and satisfy every gate.
    run_id = rel.get("ci_run_id")
    if not run_id:
        bad.append("ci_run_id is missing")
    elif not (isinstance(run_id, (str, int)) and str(run_id).isdigit()):
        # A GitHub Actions run id is a decimal number, and it is the handle the live verifier uses to
        # fetch the run and its artifact. A non-numeric value is unfetchable by construction.
        bad.append(f"ci_run_id {run_id!r} is not a numeric GitHub run id")

    tool = rel.get("solana_verify_version")
    if not tool:
        bad.append("solana_verify_version is missing")
    elif not APPROVED_VERIFY.match(str(tool)):
        # An allowlist by SHAPE, not by exact string: the point is that the field names the tool and a
        # version, so a reader can tell which build convention produced the hashes. Free text could
        # say anything, and did.
        bad.append(
            f"solana_verify_version {tool!r} is not an approved solana-verify version "
            "(expected e.g. 'solana-verify 0.4.7')"
        )

    # THE ATTESTED COMMIT MUST EXIST IN THIS TREE. Forty hex characters is a shape; a commit is a
    # fact. `git cat-file -e` answers it without a network call, and a checkout that cannot see the
    # commit the pin attests cannot attest anything about it. Skipped only when git is unavailable,
    # and that is reported rather than passed over.
    commit = rel.get("source_commit")
    if commit and re.match(r"^[0-9a-f]{40}$", str(commit)):
        try:
            r = subprocess.run(
                ["git", "-C", root, "cat-file", "-e", f"{commit}^{{commit}}"],
                capture_output=True,
            )
            if r.returncode != 0:
                bad.append(
                    f"source_commit {commit} is not a commit in this repository, so the pin names a "
                    "build this tree cannot locate"
                )
        except FileNotFoundError:
            bad.append("git is unavailable, so source_commit could not be verified to exist")

    # THE TWO CROSS-CHECKS. Both are recomputable from this checkout, so a pin that disagrees with the
    # source it claims to describe is caught without a network call.
    lib = os.path.join(root, "programs/dominion_silver_mint_v2/src/lib.rs")
    if os.path.exists(lib):
        m = re.search(r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', open(lib).read())
        if m and rel.get("program_id") and rel["program_id"] != m.group(1):
            bad.append(f"program_id {rel['program_id']} != declare_id! {m.group(1)}")

    idl = os.path.join(root, "target/idl/dominion_silver_mint.json")
    if os.path.exists(idl) and rel.get("idl_sha256"):
        got = hashlib.sha256(open(idl, "rb").read()).hexdigest()
        if got != rel["idl_sha256"]:
            bad.append(f"idl_sha256 {rel['idl_sha256']} != the generated IDL {got}")

    # `normalized_sha256` is solana-verify's convention (trailing zeros stripped). It is only checkable
    # when the pinned bytes are the bytes on disk; on a host that cannot reproduce them, skip rather
    # than report a difference that means nothing.
    so = os.path.join(root, "target/deploy/dominion_silver_mint.so")
    if os.path.exists(so) and rel.get("sha256") and rel.get("normalized_sha256"):
        blob = open(so, "rb").read()
        if hashlib.sha256(blob).hexdigest() == rel["sha256"]:
            norm = hashlib.sha256(blob.rstrip(b"\x00")).hexdigest()
            if norm != rel["normalized_sha256"]:
                bad.append(
                    f"normalized_sha256 {rel['normalized_sha256']} != recomputed {norm} "
                    "(the two hash conventions were mixed up)"
                )
    return bad


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} <manifest.json> <repo-root>")
    manifest, root = sys.argv[1], sys.argv[2]
    rel = json.load(open(manifest))["release_artifact"]
    status = rel.get("status") or "MISSING"

    problems: list[str] = []
    if status == "pinned":
        problems = validate_pinned(rel, root)

    print(
        status,
        rel.get("sha256") or "-",
        rel.get("bytes") or "-",
        (",".join(problems) if problems else "-"),
    )


if __name__ == "__main__":
    main()
