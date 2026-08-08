# Branch and tag protection, and how to check it

Round 5 P0-01. Until 2026-08-08 this repository had **no branch protection of any kind**. Every
`BLOCKING` label in `.github/workflows/build.yml` is a step NAME, a string, not an authorization
policy. The audited commit sat directly on `main` with a red CI run, and nothing had prevented that.
Codex put it bluntly: as long as this is true, no gate gates anything.

## Check it with the API, never by reading a settings page

```bash
R=dominion-silver/dominion-silver-mint

# THE check. Returns the rules that actually apply to main.
gh api "repos/$R/rules/branches/main" --jq '[.[] | {type, ruleset: .ruleset_id}]'

# The rulesets themselves, including who may bypass them.
gh api "repos/$R/rulesets" --jq '.[] | "\(.id)  \(.target)  \(.enforcement)  \(.name)"'
gh api "repos/$R/rulesets/<id>" --jq '{rules: [.rules[].type], bypass: (.bypass_actors|length)}'
```

**`GET /repos/.../branches/main/protection` returns 404 and that is CORRECT here.** Rulesets and
classic branch protection are two separate mechanisms, and only the second answers on that endpoint.
An auditor who checks only the legacy endpoint will conclude the branch is unprotected. It was the
right check to run in round 5, when both were empty; it is the wrong one now. Use
`rules/branches/main`, which reports the effective rules whichever mechanism produced them.

## What is live now (stage 1, applied 2026-08-08)

| Ruleset | Target | Rules |
|---|---|---|
| `main protected (round 5 P0-01, stage 1)` | `refs/heads/main` | deletion, non_fast_forward, required_signatures, pull_request |
| `release tags immutable (round 5 P0-01)` | all tags | deletion, non_fast_forward, update, required_signatures |

`bypass_actors` is **empty** on both, deliberately: Codex asked for no ordinary bypass, and an
organisation admin who is not listed does not get one either.

### What this changes for you, immediately

- **`git push origin main` is now rejected.** Everything goes through a pull request. The first push
  after this was applied will fail, and that is the ruleset working.
- Force-pushing and deleting `main` are refused.
- Unsigned commits are refused. Every commit on `main` since `15cd5c1` was already signed, which is
  why this rule could be turned on without breaking anything; that was checked before applying it.
- Tags cannot be moved or deleted once pushed. A release tag that can be repointed is not a release.

`required_approving_review_count` is **0**, and that is the one piece of Codex's remediation that is
not satisfied. GitHub does not let an author approve their own pull request, so requiring an approval
with a single maintainer would make `main` unmergeable. It is a governance gap, not a technical one:
raise it to 1 the day there is a second reviewer.

## Stage 2: make the checks actually required

Deliberately NOT applied yet. CI was red when stage 1 went on, and requiring these checks at that
moment would have blocked the very pull request that fixes them. Apply this once a run is green on
the remediation branch. Three checks, not two: `verifier-self-test` is the job that asserts
`verify-release-artifact.sh` exits the code it prints, which is the P0-02 defect, and it runs as its
own job so its seven full rebuilds do not sit on the critical path of `gate`.

```bash
R=dominion-silver/dominion-silver-mint
# `head -1` and the name filter: the day a second branch ruleset exists, an unfiltered query
# returns two ids and the URL below silently becomes nonsense. Match the one this page created.
ID=$(gh api "repos/$R/rulesets" --jq '.[] | select(.target=="branch") | select(.name|startswith("main protected")) | .id' | head -1)
test -n "$ID" || { echo "no branch ruleset named 'main protected...' found"; exit 1; }

# Read the ruleset, append the required-checks rule, write it back. Read-modify-write rather than a
# hand-written body: PUT replaces the whole rules array, so composing it by hand drops the other four.
gh api "repos/$R/rulesets/$ID" > /tmp/rs.json
python3 - <<'EOF' > /tmp/rs-new.json
import json
rs = json.load(open("/tmp/rs.json"))
# IDEMPOTENT: replace any existing required_status_checks rule rather than appending a second one.
# `append` alone makes a re-run produce a ruleset with the rule twice, which GitHub rejects, and the
# error names the rule rather than the re-run.
rs["rules"] = [r for r in rs["rules"] if r.get("type") != "required_status_checks"]
rs["rules"].append({
    "type": "required_status_checks",
    "parameters": {
        "strict_required_status_checks_policy": True,
        "required_status_checks": [
            {"context": "gate"},
            {"context": "verifier-self-test"},
            {"context": "reproducible-build"},
        ],
    },
})
print(json.dumps({k: rs[k] for k in ("name", "target", "enforcement", "bypass_actors", "conditions", "rules")}))
EOF
gh api -X PUT "repos/$R/rulesets/$ID" --input /tmp/rs-new.json --jq '[.rules[].type]'

# VERIFY, through the effective-rules API and not the response above.
gh api "repos/$R/rules/branches/main" --jq '[.[] | .type]'
```

`strict_required_status_checks_policy: true` is what forces a branch to be up to date with `main`
before merging, so a check that passed against an older base cannot carry a merge.

## What protection still does not give you

**It does NOT yet stop a red commit from becoming `main`, and an earlier version of this page said it
did.** With no required status checks (stage 2 is not applied) and `required_approving_review_count`
at 0, the `pull_request` rule forces the SHAPE of a change and nothing about its content: the same
person can open a pull request on a red run and merge it immediately. What stage 1 actually buys is
that every change to `main` is a pull request with a diff, is signed, cannot be force-pushed over, and
cannot be deleted. That is worth having and it is less than "red commits cannot land".

A second limit worth stating: `bypass_actors` being empty stops an admin from BYPASSING a ruleset, not
from editing or deleting one. A repository admin is one API call away from turning any of this off.
Rulesets are a guardrail against mistakes and drift, not a control against the person who owns the
repository.

It also does not stop a red commit from becoming a RELEASE:
that is the job of `release_artifact.status` in `config/mainnet-authorities.json` plus the
`reproducible-build` job, which publishes an artifact only after the tests, the scans and the pin
comparison have all run against that exact file, and only from a push to `main` or a tag. The two
mechanisms are independent on purpose; neither substitutes for the other.
