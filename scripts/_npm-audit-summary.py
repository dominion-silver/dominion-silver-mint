"""ROUND 6 R6-09. Summarise one `npm audit --omit=dev --json` report for the ratchet.

Reads the report on stdin, `ALLOWED` (newline-separated package names) and `WS` (the workspace key)
from the environment. Prints one line:

    <critical> <high> <moderate> <low> <unlisted-packages|-> <new-advisory-ids|->

THE DEFECT THIS EXISTS TO CLOSE. The ratchet compared per-severity COUNTS of vulnerable packages plus
an allowlist of package NAMES. A brand new high-severity advisory on `next`, `ws`, `sharp` or
`postcss` (all already vulnerable, all already allowlisted) changes neither the count nor the name, so
the gate stayed green while the graph genuinely got worse. The script's own header claimed it "fails on
anything worse: a new high, a new critical", which was false in exactly the case that matters most,
because a package that already has advisories is the likeliest place for the next one.

An advisory ID is an IDENTITY. `config/npm-advisory-baseline.json` records the accepted set per
workspace, and anything outside it is reported however the totals move. Counts stay as a second belt:
they catch a new vulnerable PACKAGE whose advisory id somehow already appears elsewhere.
"""

import json
import os
import pathlib
import sys


def main() -> None:
    report = json.load(sys.stdin)
    meta = report.get("metadata", {}).get("vulnerabilities", {})
    vulns = report.get("vulnerabilities", {})

    allowed = {x.strip() for x in os.environ.get("ALLOWED", "").splitlines() if x.strip()}
    unlisted = sorted(
        name
        for name, v in vulns.items()
        if v.get("severity") in ("high", "critical") and name not in allowed
    )

    # Every advisory id reachable from this report. `via` holds either a package name (a transitive
    # hop, no id) or an advisory object carrying `source`. Only the objects are identities.
    seen: set[int] = set()
    for v in vulns.values():
        for via in v.get("via", []):
            if isinstance(via, dict) and via.get("source") is not None:
                seen.add(int(via["source"]))

    baseline_path = pathlib.Path(__file__).resolve().parent.parent / "config/npm-advisory-baseline.json"
    ws = os.environ.get("WS", ".")
    try:
        baseline = set(json.load(open(baseline_path))["workspaces"].get(ws, []))
    except Exception:
        # A MISSING OR UNREADABLE BASELINE MUST NOT READ AS "nothing new". An empty set here would make
        # every id look new, which fails loudly and is the safe direction; silently treating it as
        # "everything accepted" is the failure mode this whole file exists to remove.
        baseline = set()

    new_ids = sorted(seen - baseline)

    print(
        meta.get("critical", 0),
        meta.get("high", 0),
        meta.get("moderate", 0),
        meta.get("low", 0),
        ",".join(unlisted) or "-",
        ",".join(str(i) for i in new_ids) or "-",
    )


if __name__ == "__main__":
    main()
