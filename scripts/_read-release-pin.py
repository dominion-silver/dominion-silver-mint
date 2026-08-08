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
import sys

HEX64 = re.compile(r"^[0-9a-f]{64}$")
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


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
    for field in ("ci_run_id", "solana_verify_version"):
        if not rel.get(field):
            bad.append(f"{field} is missing")

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
