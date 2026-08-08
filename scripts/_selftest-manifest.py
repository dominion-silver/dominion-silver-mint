"""ROUND 6 R6-03. Write a chosen `release_artifact` block into the SANDBOX copy's manifest.

This exists as a FILE rather than a heredoc inside scripts/test-verify-release-artifact.sh for one
reason: it is only ever pointed at a temporary copy of the repository, and that constraint should be
readable at a glance instead of buried in shell quoting.

The history matters. The self-test used to drive `DOMINION_RELEASE_MANIFEST`, an override that
`verify-release-artifact.sh` honoured in production. Round 6 R6-03: an environment variable that can
make an attestation tool exit 0 with `ARTIFACT OK` is a false-attestation channel, whatever warnings it
prints, because the machine contract is the exit code and the final line. The override is gone. The
test copies the repository and edits its copy, which exercises the same state machine and leaves no
door in the tool.

Usage: _selftest-manifest.py <status> <sha256|-> <bytes|-> <repo> <sandbox>

Refuses to write anywhere but a sandbox, so a mistyped argument cannot rewrite the committed manifest.
"""

import hashlib
import json
import os
import re
import sys


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(f"usage: {sys.argv[0]} <status> <sha256|-> <bytes|-> <repo> <sandbox>")
    status, sha, nbytes, repo, sandbox = sys.argv[1:6]

    repo = os.path.realpath(repo)
    sandbox = os.path.realpath(sandbox)
    # THE GUARD THAT MAKES THIS SAFE TO SHIP. Writing the committed manifest from a test helper would
    # be the same class of defect as the override it replaces: a path by which something other than a
    # deliberate human edit decides what the release pin says.
    if sandbox == repo or sandbox.startswith(repo + os.sep):
        raise SystemExit(
            f"REFUSING: the sandbox ({sandbox}) is inside the repository ({repo}).\n"
            "This helper only ever writes to a temporary copy."
        )

    src_manifest = os.path.join(repo, "config/mainnet-authorities.json")
    dst_manifest = os.path.join(sandbox, "config/mainnet-authorities.json")
    if not os.path.exists(dst_manifest):
        raise SystemExit(f"REFUSING: {dst_manifest} does not exist, so this is not a repo copy.")

    doc = json.load(open(src_manifest))
    rel = doc["release_artifact"]
    rel["status"] = status
    rel["sha256"] = None if sha == "-" else sha
    rel["bytes"] = None if nbytes == "-" else int(nbytes)

    if status == "pinned":
        # Fill every field the closed `pinned` schema requires (R6-07), from real measurements. A pin
        # that is complete-but-wrong and a pin that is incomplete are different tests; this helper
        # produces the first, and the self-test drives the second explicitly.
        so = os.path.join(repo, "target/deploy/dominion_silver_mint.so")
        idl = os.path.join(repo, "target/idl/dominion_silver_mint.json")
        lib = os.path.join(repo, "programs/dominion_silver_mint_v2/src/lib.rs")
        blob = open(so, "rb").read()
        rel["normalized_sha256"] = hashlib.sha256(blob.rstrip(b"\x00")).hexdigest()
        rel["program_id"] = re.search(
            r'declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)', open(lib).read()
        ).group(1)
        rel["source_commit"] = "0" * 40
        rel["ci_run_id"] = "0"
        rel["ci_repository"] = "dominion-silver/dominion-silver-mint"
        rel["idl_sha256"] = hashlib.sha256(open(idl, "rb").read()).hexdigest()

    with open(dst_manifest, "w") as fh:
        json.dump(doc, fh, indent=2)


if __name__ == "__main__":
    main()
