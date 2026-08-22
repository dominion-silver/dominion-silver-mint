"""INAL-06. The ONE place that turns `solana-verify --version` into the pinned field.

Called by BOTH `.github/workflows/build.yml` (the producer, when it writes release-manifest.json) and
`scripts/test-release-provenance.py` (the proof). That sharing is the whole point.

The previous proof hard-coded the three strings it tested, so a workflow regressing to
`.stdout.strip()` would start writing "solana-verify 0.5.1" again while the test stayed green on its
own literal "0.5.1". The operational defect A-04 was meant to prevent would then come back on the
first pin copied from the manifest: the install step feeds this field to `cargo install --version`,
which needs a bare semver constraint.

Usage:
    python3 scripts/_solana_verify_version.py            # runs the real solana-verify
    from _solana_verify_version import bare_semver       # pure, for the test
"""

import re
import subprocess
import sys

_BARE_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def bare_semver(raw: str) -> str:
    """Last whitespace token of `<tool> X.Y.Z`, refused unless it IS a bare semver.

    Refusing rather than best-effort parsing is deliberate: a version this cannot read is a version
    CI cannot install, and guessing one would pin a tool nobody chose.
    """
    tok = raw.strip().split()[-1] if raw.strip() else ""
    if not _BARE_SEMVER.match(tok):
        raise SystemExit(
            f"solana-verify --version is not a bare semver: {raw.strip()!r}. "
            "This value is passed verbatim to `cargo install solana-verify --version`."
        )
    return tok


def measured() -> str:
    """Run the real tool. Kept apart from `bare_semver` so the parse is testable without the tool."""
    r = subprocess.run(["solana-verify", "--version"], capture_output=True, text=True)
    # THE EXIT CODE IS PART OF THE MEASUREMENT. Reading stdout alone accepted a
    # tool that printed a plausible line and then failed: measured with a stub exiting 9, the
    # producer still returned "0.5.1" and exited 0. A version read from a failed process is not a
    # measurement, it is a leftover buffer.
    if r.returncode != 0:
        raise SystemExit(
            f"solana-verify --version exited {r.returncode}. Its stdout is not a measurement.\n"
            f"stderr: {r.stderr.strip()[:200]}"
        )
    return bare_semver(r.stdout)


if __name__ == "__main__":
    sys.stdout.write(measured())
