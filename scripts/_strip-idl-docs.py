#!/usr/bin/env python3
"""
Remove every `docs` field from an Anchor IDL, recursively, and print it deterministically.

WHY THIS EXISTS. Anchor lifts Rust doc comments (`///`) into the IDL as `docs` arrays, the apps bundle
their IDL copy, and Next inlines it. So internal engineering prose was being SERVED to every visitor of
the public site. Measured on 2026-08-21: 16 lines of internal review commentary reached the IDL, and
`https://app.dominion.market/_next/static/chunks/app/page-*.js` carried 13 matches for "ROUND <n>".
Anyone could read our own notes about the protocol's controls with view-source, no repository access
needed. The `docs` fields have no runtime purpose: no Anchor client reads them.

WHY IT NORMALISES BOTH SIDES INSTEAD OF EDITING ONE. The CI gate proves the committed IDL equals a
FRESH regeneration, and it does it with a textual `diff`. Editing only the committed copy would make
that diff fail forever, and re-serialising only one side would make it fail on formatting rather than
content. So both sides go through THIS script, and the diff compares two identically-normalised
documents. The guarantee is unchanged: the app still has to describe the program that ships.

Usage: python3 scripts/_strip-idl-docs.py <in.json> [out.json]   (stdout when out is omitted)
"""
import json
import sys


def strip(node):
    """Drop `docs` wherever it appears, preserving key order everywhere else."""
    if isinstance(node, dict):
        return {k: strip(v) for k, v in node.items() if k != "docs"}
    if isinstance(node, list):
        return [strip(v) for v in node]
    return node


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
    # indent=2 and a trailing newline match what anchor emits, so a stripped file stays readable and
    # diffable by hand rather than collapsing to one line.
    out = json.dumps(strip(data), indent=2, ensure_ascii=False) + "\n"
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as fh:
            fh.write(out)
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
