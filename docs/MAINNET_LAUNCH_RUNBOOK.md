# Dominion SILV: mainnet launch runbook

Every step in order, with the exact command, what it proves, and what breaks if it is
skipped. Written against the six launch requirements Thomas confirmed on 2026-07-29.

**Read the two hard rules first, then the four things that are IRREVERSIBLE, then run
the steps in order. Do not reorder them: several steps only work in one sequence.**

---

## The two hard rules

**RULE 1. Nothing touches mainnet unless the command says so.** Every E2E script now
calls `requireSanctionedCluster()` from `scripts/_guard.ts` and refuses a non-devnet RPC unless
`DOMINION_ALLOW_MAINNET=i-understand` is set.

**RULE 2. No script takes an action whose undo is slow, unless you sanction it.**
`assertReversible()` classifies each action and throws by default. Sanction one with
`DOMINION_INTENT=<action>`.

Both rules exist because on 2026-07-29 a TEST closed the public mint that had just been
opened through a 24h timelock, and reopening cost another 24h. The direction of the
asymmetry is deliberate in the program (safety is instant, unsafe is slow), so a script
can always break something in one transaction and then need a day to fix it.

**The operational consequence you must internalise before mainnet:** closing is instant,
opening is 24h. `pause` is instant, `unpause` is instant. But **open public mint, loosen
a redeem limit, and change the oracle feed all cost 24h.** Plan the launch so nothing
needs to be reopened in a hurry.

---

## The four IRREVERSIBLE decisions

| Decision | Where it is fixed | Consequence of getting it wrong |
|---|---|---|
| SILV mint: decimals, extension set, **freeze authority**, **permanent delegate** | at mint creation, step 4 | No fix. A new mint means a new token, a new pool, and every holder re-onboarded. |
| `config.admin`, `permanent_delegate_expected`, `freeze_authority_expected`, feed id, premiums, timelock | at `initialize`, step 6, which runs ONCE per program id | **Mostly NOT irreversible, and this row said the opposite.** Audit finding D-02. There is no "upgrade that re-initialises": `initialize` refuses a second call for the same program id, so that escape does not exist. What DOES exist is a dedicated governed setter for most of these: admin via `propose_admin_transfer`, feed via `execute_set_pyth_feed`, both premiums via their own timelocked actions, timelock via its own. All 24h. The genuinely permanent pair is `permanent_delegate_expected` / `freeze_authority_expected`, because they mirror authorities fixed on the MINT at creation and no SPL authority can be restored once lost. Get those two right; the rest are a day of governance, not a new deployment. |
| `max_silv_supply` = **150,000 oz** | tighten-only, forever, and a ONE-WAY RATCHET | Raising it needs a program upgrade + re-audit. Lowering it is instant but makes the lower value the new permanent ceiling, so never lower it casually. |
| Upgrade authority transfer | step 12 | If the multisig is lost, the program can never be upgraded. It does **not** block opening redemptions: audit finding D-02 caught this claim, and step 11 plus the capability table below both describe the real path, the 24h-timelocked `SetRedeemLimits` action, which needs `config.admin` and no upgrade authority at all. What a lost upgrade authority really costs is every future CODE change: new instructions, bug fixes, and the redeem-side features that are not yet written. |

---

## Requirement check: what you asked for vs what the code does

| Your requirement | Status | What it needs |
|---|---|---|
| 1. SILV token deployed and live | ✅ ready | steps 3-6 |
| 2. Pre-mint freely, send to inventory, seed a ~100K USDC Sunrise pool | ✅ ready | the plan is $6.75M worth, ~115,705 oz at $58.34 spot, 77% of the 150,000 oz cap. Steps 7-9. |
| 3. Public mint, no KYC, KYC enableable later | ✅ **yes** | Public mint: yes, and opening it costs a 24h timelock (step 9). KYC: the gate SHIPPED DORMANT on 2026-08-05. `kyc_scope_flags = 0` at init and it IS read, by `mint_silv` and `redeem_silv`, so arming it later is a CONFIG CHANGE, not a program upgrade and not a second audit. Order matters: set the attestor, write the attestations, THEN arm the scope. Arming first locks out every existing holder. |
| 4. Redeem closed now, open later | ✅ ready, **NO upgrade needed** | `set_redemptions_enabled` still refuses `true`, but the 24h-timelocked `SetRedeemLimits` action carries the switch: `propose_set_redeem_limits({ redemptionsEnabled: true })`, wait, execute. This row said "open later BY UPGRADE" and "opening is a code change by construction" until 2026-08-06, contradicting section P4 on the same page (re-audit P2). An operator following the table would have omitted the timelocked action and waited for a release that was never coming. |
| 5. Admin portal live for admin wallet + guardians + multisig | ✅ ready | step 11. Needs `NEXT_PUBLIC_OPS_SQUADS` set, else the Squads-member path is inert. |
| 6. Revoke the deployer, upgrade authority to the multisig | ✅ ready, **ordering matters** | step 12, and it MUST be last: `initialize` requires the signer to BE the upgrade authority. |

**The one thing to decide before step 6:** what `config.admin` is.

- **Recommended: `admin = 65g5nNX` (Ops Squads) from `initialize`.** Every admin action
  is then a Squads ceremony from day one. Your deployer is a signer of that Squads, so
  you can propose, approve and execute yourself. No admin transfer needed later, no
  extra 24h, and the deployer never holds unilateral admin power.
- Alternative: `admin = deployer` for the setup, then `propose_admin_transfer` to the
  Squads. Faster clicks during setup, but it costs a 24h timelock plus an acceptance
  transaction signed by the Squads, and it leaves a window where one key is admin.

---

## Pre-flight (do these BEFORE touching mainnet)

```bash
# 0a. Authorities, funding, cluster constants. Must be 0 failures.
npx tsx scripts/verify-mainnet-authorities.ts

# 0b. The LOCAL build is a clean default-feature build with no dev hatch.
#     --local-only is not a shortcut: without it the script also compares against the release pin,
#     which this machine cannot reproduce (the release artifact is a linux/amd64 container build), so
#     it exits 3 "NOT ATTESTED" and ends on DO NOT DEPLOY THIS FILE. That is correct and it is not a
#     failure; it is simply not the question this pre-flight is asking. See step 2a.
bash scripts/verify-release-artifact.sh --local-only

# 0c. Every hand-copied address agrees with declare_id!.
scripts/verify-constants-consistency.sh

# 0d. The feed satisfies every on-chain guard, on MAINNET data.
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/probe-lazer-feed.ts
```

**Blockers to clear by hand:**

- [ ] Deployer `2Lp91Fy…` funded with **~9.2 SOL** on mainnet. Measured, not estimated:
      the devnet rehearsal of 2026-08-10 locked **8.62 SOL** of ProgramData rent for the
      1,237,728-byte artifact, plus fees.
      **This line used to add "rent is recoverable via `solana program close`". It was
      deleted on 2026-08-10 and must never come back.** It is true about the lamports and
      catastrophic as advice: closing a program id destroys it FOREVER, and this project
      has already done it once. `gc5TWUkmKpTfoL88HwsBduxbo2rZNEzhYinW7WqYaDc` answers
      "has been closed" to this day. Closing `3ucji6…` would lose the mainnet id, and with
      it `declare_id!`, the IDL, every PDA and the whole audited surface. There is no
      situation in this runbook where closing is the right answer: a bad deploy is fixed
      by `solana program deploy` again, which performs an upgrade in place.
- [ ] The Pyth key in Vercel Production has the **`pyth-indices` entitlement** for feed
      3154. Test: `curl -X POST https://<app>/api/lazer -d '{}'` must return a price,
      not a 403.
- [ ] Sunrise has confirmed they accept a Token-2022 mint carrying **freeze authority +
      permanent delegate**. If not, there is no venue and the launch model fails.
- [ ] `https://app.dominion.market/silv-metadata.json` serves the JSON. **The host changed on
      2026-08-11 and the reason matters: `dominion.market` is a separate property (Mark's, on
      GCP, Namecheap DNS) that we cannot publish to, so the file now lives in THIS repo at
      `apps/public/public/silv-metadata.json` and is served by our own app on the `app.`
      subdomain.** Verify with the readiness gate, not by eye: it fetches the URI AND a path
      that cannot exist and demands they differ, because the old apex answers 200 with
      identical HTML for every path and made a status-code check incapable of failing. The URI
      is baked into the mint permanently: changing it afterwards costs a 24h timelock
      (`propose_update_metadata` / `execute_update_metadata`).
- [ ] Site copy discloses the **freeze and seize** powers (SolidProof MEDIUM #2, and the
      head-dev's requirement). Fix the over-claimed Chainlink PoR while you are there.
- [ ] At least 2 guardian keys exist, held independently, on hardware.

---

## The launch sequence

### 1. Generate the mainnet program keypair

```bash
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/dominion-mainnet-program.json
solana-keygen pubkey ~/.config/solana/dominion-mainnet-program.json
```

Back this file up before continuing. Losing it before step 3 costs nothing; losing it
after means you cannot upgrade the program ever.

### 2. Point the source at the new id, let CI build it, pin it

**MEASURED STATE, 2026-08-08.** The program id `3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ` is
CREATED and committed: `declare_id!`, `Anchor.toml` (all three clusters), both apps' `PROGRAM_ID` and
the three IDL copies all carry it. The keypair is at `~/.config/solana/dominion-mainnet-program.json`,
mode 600, outside the repository.

What is NOT done, and this is the whole of step 2: **the candidate has not been BUILT by CI and not
been PINNED.** `release_artifact.status` reads `no-candidate`, and until a green run publishes an
artifact there is nothing to deploy. The remaining halves of 2a are the cluster constants (USDC and
the Lazer treasury), which the batch that created the id did not touch.

The step is split into 2a (finish the constants and commit), 2b (CI builds it), 2c (pin it), below.

### Run the readiness gate BEFORE each numbered step, with `--stage`

```bash
npx tsx scripts/verify-mainnet-readiness.ts --stage=<the step you are about to do>
```

**ROUND 3 P1: this instruction was missing entirely.** The gate existed, `--stage` existed, and no step of
this runbook ever called it, so an operator following the page never ran it. Worse, the mandatory fee-vault
creation sat outside the numbered sequence (in the PREREQUISITES section), so step 10 could open the public
mint with no vault and make every mint and every redeem revert `AccountNotInitialized`. Round 8 moved that
deadline earlier still, to step 8's unpause, and `ceremony-step8.ts` now enforces it in code.

`--stage=N` reports anything due before N as OVERDUE and exits 1. Without it the gate cannot tell "not yet"
from "skipped", so a mid-ceremony run reads falsely reassuring.

**The fee vault is now step 9b below, inside the sequence.** A prerequisite nobody numbers is a prerequisite
somebody skips.

**THE DEPLOYABLE BYTES COME FROM CI, NOT FROM THIS MACHINE** (audit S-07, and round 5 P0-02).

This section used to tell you to run `cargo build-sbf` and deploy `target/deploy/...`. That is the
one thing the release doctrine forbids, and it had been forbidden for a commit already when the round
5 audit found the instruction still here.

Why, measured rather than asserted: **the SBF build is not deterministic across host platforms.** The
`.so` embeds `/Users/runner/work/platform-tools/...`, the paths of the macOS machine that compiled the
platform-tools tarball, baked into its prebuilt std. The linux tarball carries `/home/runner/...`, a
string of different length, which shifts every rodata offset after it. macOS and Linux disagree at
v1.51 AND at v1.52. Solana's own docs say it outright: *"Solana program builds are not deterministic
across different systems"*, and *"make sure that you actually deploy the verified build and don't
accidentally overwrite it with anchor build or cargo build-sbf"*.

So: **the `reproducible-build` CI job produces the bytes that ship.** It builds in the `solana-verify`
container, takes ownership of the file, runs the 154 on-chain tests against THAT file, scans it,
hashes it, writes `release-manifest.json`, and only then publishes it. A local build is for devnet and
for the local gates. It is never a mainnet artifact.

**THE RELEASE HASH IS NOT WRITTEN HERE.** It lives in exactly one place,
`config/mainnet-authorities.json` under `release_artifact`. This paragraph used to carry the hash
inline and it went stale three times, each one blessing a binary that no longer existed. A number
maintained by hand in two places is a number that will disagree with itself, and a gate now refuses to
let a bare sha256 reappear in this file.

Toolchain of record (`release_artifact.toolchain`, and `[workspace.metadata.cli] solana = "3.0.0"` in
the root `Cargo.toml` is what selects the container image):

| Component | Version |
|---|---|
| solana-cli / solana-cargo-build-sbf | 3.0.0 |
| platform-tools | v1.51 |
| SBF rustc | 1.84.1 |
| host rustc (for `anchor idl build`) | 1.89.0 |
| anchor-cli | 0.31.1 |
| solana-verify | pinned in `release_artifact.solana_verify_version` |

### 2a. Point the source at the new id and commit it

`declare_id!`, `[programs.mainnet]` and both apps' `PROGRAM_ID` are ALREADY DONE (see above). What
remains are the two cluster-specific constants that the id change did not touch, and that round 6
R6-05 found still on devnet values:

- `USDC_MINT` → `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` in **both** apps
- `LAZER_TREASURY` → `Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak` in `apps/public`

Regenerate the IDL and copy it to both apps. **NEVER redirect `anchor idl build` stdout into the IDL
file.** Use `-o`. Anything else cargo writes to stdout lands in the file, and on a registry cache MISS
that is `  Downloaded <crate>`, so the JSON is corrupt while the command still exits 0. That is the CI
P0 of 2026-08-06: the `gate` job had never passed in its entire history.

```bash
# REBUILD FIRST. Changing declare_id! changes the binary, so the .so on disk is now stale and the
# verifier below (which compares it against a fresh rebuild) would reject it. This local build is for
# the LOCAL gates only; it is never the artifact that ships.
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked

mkdir -p target/idl
(cd programs/dominion_silver_mint_v2 && anchor idl build -o ../../target/idl/dominion_silver_mint.json -- --locked)
printf '\n' >> target/idl/dominion_silver_mint.json   # -o omits it; keeps the committed copies byte-identical
python3 -c "import json;json.load(open('target/idl/dominion_silver_mint.json'))"  # MUST parse before copying
cp target/idl/dominion_silver_mint.json apps/admin/src/lib/idl/
cp target/idl/dominion_silver_mint.json apps/public/src/lib/idl/
bash scripts/verify-constants-consistency.sh   # must pass
bash scripts/verify-release-artifact.sh --local-only   # must print LOCAL BUILD OK
```

`--local-only` is not a shortcut. It asks the one question a local build can answer: is this a clean
default-feature build of this tree, with no dev hatch and no probe. Without it the script exits **3**
and says `ARTIFACT NOT ATTESTED`, because this host cannot reproduce the container build. **Exit 3 is
not a failure and it is not an approval.** Deploying on a 3 is the thing that code exists to stop.

Commit everything. **The commit you push is the commit the artifact is built from**, so nothing may be
uncommitted at this point.

### 2b. Let CI build the candidate, and take the artifact from it

Push, wait for the run to go green, then from the `reproducible-build` job of THAT run:

- download `dominion_silver_mint-verifiable-so` (it contains the `.so` and `release-manifest.json`);
- check `release-manifest.json`: `program_id` must be your new mainnet id and `source_commit` must be
  the commit you just pushed.

If the run is red, there is no candidate. Do not deploy from a red run; that was round 5 P1-01, and
the artifact upload now happens after every check for exactly this reason.

### 2c. Pin the candidate

Copy `sha256`, `normalized_sha256`, `bytes`, `source_commit`, `ci_run_id`, `program_id` and
`idl_sha256` from `release-manifest.json` into `config/mainnet-authorities.json` under
`release_artifact`, and set `"status": "pinned"`. Commit that.

**Two hash conventions coexist and mixing them produces a false pin.** `sha256` is `sha256sum` of the
file. `normalized_sha256` is solana-verify's own hash (trailing zeros stripped, `get_binary_hash`),
and that is what `verify-from-repo` compares against the chain. On the same file the two numbers
differ. The manifest carries both, labelled, so neither has to be recomputed by hand.

CI will now compare every future build against this pin and fail on a mismatch. That is the point:
after 2c, the candidate is immutable.

### 3. Deploy THAT file, without rebuilding

```bash
# The artifact downloaded in 2b, not a local build.
ARTIFACT=~/Downloads/dominion_silver_mint.so

# Refuse to continue unless it IS the pinned candidate.
python3 - "$ARTIFACT" <<'EOF'
import hashlib, json, sys
blob = open(sys.argv[1], "rb").read()
pin = json.load(open("config/mainnet-authorities.json"))["release_artifact"]
got, want = hashlib.sha256(blob).hexdigest(), pin["sha256"]
assert pin["status"] == "pinned", f"status is {pin['status']}, there is no candidate to deploy"
assert got == want, f"NOT the pinned artifact:\n  file  {got}\n  pin   {want}"
assert len(blob) == pin["bytes"], f"size {len(blob)} != pinned {pin['bytes']}"
print(f"OK: this file IS the pinned release artifact ({got}, {len(blob)} bytes)")
EOF

solana program deploy "$ARTIFACT" \
  --program-id ~/.config/solana/dominion-mainnet-program.json \
  -k ~/.config/solana/dominion-dev.json -u mainnet-beta
```

Then verify the bytes actually on chain, which is not optional:

```bash
solana program dump <PROGRAM_ID> /tmp/onchain.so -u mainnet-beta
LEN=$(stat -f%z "$ARTIFACT")
head -c "$LEN" /tmp/onchain.so > /tmp/onchain-trim.so
shasum -a 256 "$ARTIFACT" /tmp/onchain-trim.so   # must match
solana program show <PROGRAM_ID> -u mainnet-beta # Authority = deployer
```

### 3b. Initialise the on-chain IDL account. Do it now, not later.

**Round 5 P2-03.** Nothing else in this sequence created it. `anchor idl upgrade` cannot replace an
`init` when the account does not exist, so the upgrade script's IDL step would fail on the first
mainnet upgrade with nothing to fall back on.

```bash
anchor idl init --provider.cluster mainnet \
  --filepath target/idl/dominion_silver_mint.json <PROGRAM_ID>

# Read it back and compare it to the attested file, byte for byte.
anchor idl fetch --provider.cluster mainnet <PROGRAM_ID> > /tmp/onchain-idl.json
python3 - <<'EOF'
import hashlib, json
a = hashlib.sha256(open("target/idl/dominion_silver_mint.json","rb").read()).hexdigest()
pin = json.load(open("config/mainnet-authorities.json"))["release_artifact"].get("idl_sha256")
print("local idl :", a)
print("pinned idl:", pin)
# ROUND 6 R6-07: this used to read `assert pin is None or a == pin`, which passes for ANY local IDL
# whenever the pin is null, and the pin was structurally always null because the job that writes it
# never built an IDL. Both halves are fixed: the job builds one, and a null pin is now a failure here.
assert pin is not None, "release_artifact.idl_sha256 is null: step 2c did not record it"
assert a == pin, "the local IDL is not the one CI attested"
EOF
# --sort-keys IS REQUIRED, measured on the devnet rehearsal 2026-08-10. `anchor idl fetch` returns
# the SAME bytes count and the same content, but with the top-level keys in a different ORDER than
# the file on disk (it leads with `accounts`, the file leads with `address`). Without --sort-keys
# this diff reports a 67-line mismatch on a perfectly correct upload, and the ceremony stops on a
# false alarm at the step right after the irreversible deploy. Content equality is what is being
# asserted here; byte-for-byte equality of the serialised form is not a property anchor offers.
diff <(python3 -m json.tool --sort-keys /tmp/onchain-idl.json) \
     <(python3 -m json.tool --sort-keys target/idl/dominion_silver_mint.json) \
  && echo "on-chain IDL matches the attested file"
```

Record the IDL account address. Later versions use `anchor idl upgrade`, never a second `init`.

### 4 + 5 + 6. T1 hostile bootstrap, which CREATES THE MINT and INITIALISES

**This is the step people get wrong.** `initialize` succeeds exactly once per program
id, so the window between step 3 and initialisation is the ONLY chance to prove the
DOM-001 P0 fix. T1's case 5 performs the real `initialize`, so **a passing T1 IS your
initialisation.** Run it BEFORE any init script.

```bash
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_RPC=https://api.mainnet-beta.solana.com \
DOMINION_INTENT=initialize \
DOMINION_PROGRAM_ID=<PROGRAM_ID> \
DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
npx tsx scripts/t1-hostile-bootstrap.ts
```

**`DOMINION_INTENT=initialize` is on that list because RULE 2 demands it and this page did not have it.**
`initialize` is classified irreversible, and T1's case 5 performs it. The guard now fires BEFORE the mint is
created rather than after, so a missing token costs you nothing; without both changes an operator following
this page would have created the real mainnet mint and then been refused, losing the mint keypair.

**`DOMINION_RPC` is on that list because it was missing, and its absence reproduced the audit's P0
verbatim.** Every other mainnet command in this runbook sets it; this one did not, so `resolveCluster()`
defaulted to devnet, `requireDevnet` returned on its first line, and the ceremony ran entirely on devnet
after the mainnet deploy had been paid for. The script now REFUSES that combination outright
(`DOMINION_ALLOW_MAINNET` set with `DOMINION_RPC` unset is a contradiction, not a default), so the old
command no longer runs silently, but set it anyway and read the `cluster=` line the script prints first.

**DO NOT EDIT `args()`.** That instruction lived here until 2026-08-06 and it was audit finding
D-01, a P1. It told the operator to type `premiumBpsMint: 150` and `premiumBpsRedeem: 500` while
`config/mainnet-authorities.json` says 100 / 150 and page 354 of this same runbook says 100 / 150
too. The script itself contained a third pair, 150 / 200. Following this page would have opened
mainnet at **1.5% mint / 5% redeem** instead of 1% / 1.5%: on a 100 USDC mint that is 1.50 taken
instead of 1.00, and on a 100 USDC gross redeem the user receives 95.00 instead of 98.50. Correcting
either number afterwards costs one 24h timelocked proposal each, so the launch would have run on the
wrong tariff for at least a day.

T1 now READS these values, from `config/mainnet-authorities.json`:

- `launch_posture.premium_bps_mint`, `premium_bps_redeem`, `admin_timelock_seconds`,
  `max_guardian_count`, `pyth_lazer_feed_id`
- `authorities.compliance.pubkey`, used for BOTH `permanentDelegateExpected` and
  `freezeAuthorityExpected` on any non-devnet cluster (on devnet it stays the dev keypair, which is
  what makes T1 runnable there at all)

So the only thing to check before running is that file. Print what T1 resolved and compare:

```bash
python3 -c "import json;d=json.load(open('config/mainnet-authorities.json'));\
print(d['launch_posture']['premium_bps_mint'], d['launch_posture']['premium_bps_redeem'], \
d['launch_posture']['max_guardian_count'], d['authorities']['compliance']['pubkey'])"
```

T1 echoes the same values on its second line of output. If they disagree with what you expect, fix
the JSON, not the TypeScript.

**`admin` is the OPS SQUADS VAULT, read from `authorities.ops_admin.pubkey`. It is NOT the signer.**

The sentence here until 2026-08-06 said `admin` was "still the signer, by design: `initialize` binds them
to the deploying upgrade authority (audit DOM-001)". That was FALSE and it was a P0. DOM-001 binds the
SIGNER to the current BPF upgrade authority; it says nothing about `args.admin`, which `initialize` writes
verbatim with only a non-zero check. Following this page would have written the deployer into
`config.admin`, so step 7's Ops-vault proposal would fail `has_one = admin`, and the deployer would keep
unilateral admin authority over the protocol with no transfer step anywhere in the path.

`upgradeAuthorityInfo` IS the signer, and is informational only: it records who initialised. The real
upgrade authority is whatever the BPF loader says, moved to the upgrade vault at step 12.

**Do NOT edit `scripts/_t1-mint-helper.ts` either.** That instruction was here until 2026-08-06 and it
was a P0 waiting to happen: the helper hardcoded the mint's freeze authority and permanent delegate to
the payer, `initialize` had been changed to expect the compliance vault, and the two can never agree on
mainnet. Forgetting the edit meant reverting `SilvFreezeAuthorityMismatch` at the initialisation step,
after the deploy was paid for and after the mint keypair (deliberately never persisted) had been used.

The helper now takes the compliance authority as an argument and T1 reads it from
`authorities.compliance.pubkey`, resolved and validated BEFORE the first lamport moves. Neither authority
has to sign to be set, so there was never a reason to hand-edit this.

**Those two are still permanent**, fixed at mint creation, and no program upgrade can restore an external
SPL authority once it is wrong. Check the printed value before confirming.

**Expect ZERO FAIL lines.** The count is deliberately not written here: this page said `17/17` while
the audit brief said `18/18` and the script produced its own number, so an operator had two wrong
targets and no way to tell which. The script prints its own `PASS`/`FAIL` totals on the last line. Any
`FAIL` stops the ceremony; the total is whatever the script says it is.

T1 also refuses BEFORE the first lamport if the IDL, `declare_id!` and `DOMINION_PROGRAM_ID` disagree,
or if the loaded keypair is not the on-chain upgrade authority (round 5 P1-07). Those refusals are
free; the same problems discovered at case 5 cost the funded attacker account and the one-shot mint.

Then record everything:

```bash
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/read-config.ts
spl-token display <SILV_MINT> -u mainnet-beta
```

Check by eye: decimals 6, mint authority = the `silv_mint_authority` PDA, freeze
authority = compliance vault, extensions exactly {PermanentDelegate, MetadataPointer,
TokenMetadata}, `paused = true`, **`public_mint_enabled = true`**,
**`redemptions_enabled = true`**, `max_silv_supply = 150000000000` (150,000 oz).

**Those two flags read `false` on this page until 2026-08-10 and that was wrong.** Round 8
inverted the launch posture: `initialize` writes both TRUE, `config/mainnet-authorities.json`
`launch_posture` says true, and the devnet rehearsal confirmed the chain writes true. An
operator checking this list verbatim would have seen a mismatch on the one step designed to
catch a botched `initialize`, and the only available conclusion would have been to re-run a
one-shot instruction. What holds the launch is the PAUSE, not these flags.

### 6c. Write the REAL mint into both apps. BLOCKING for 6b.

**Round 6 R6-05.** T1 just created the mainnet SILV mint. Until this step runs, both apps carry the
DEVNET mint `G5zez3JW...` while already carrying the mainnet program id, and nothing catches it: the
offline gate only proves the two apps agree with each other and that the value is not on a three-entry
retired list, and the devnet mint passes both. With a mainnet RPC those addresses name accounts that do
not exist, so the panel and the public card build ATAs and instructions against the wrong mint. The
program's constraints protect the money; the product simply does not work, and it stops working exactly
at the ceremony steps that need the panel.

```bash
# The mint T1 created, read off the chain rather than off the terminal scrollback.
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/read-config.ts | grep -i silvMint
```

Then, in BOTH `apps/public/src/lib/constants.ts` and `apps/admin/src/lib/constants.ts`:

- set `SILV_MINT` to that address;
- add the devnet mint `G5zez3JWETJMfG3hnCQbdPm7usXMnmKUpajdGJYB5JFF` to `RETIRED_MINTS` in
  `scripts/verify-constants-consistency.sh`, so it can never come back.

Commit, then prove it against the chain rather than against yourself:

```bash
bash scripts/verify-constants-consistency.sh
npx tsx scripts/verify-mainnet-readiness.ts --stage=7   # must NOT report SILV_MINT as due at 6c
(cd apps/public && npx tsc --noEmit && npx vitest run && npm run build)
(cd apps/admin  && npx tsc --noEmit && npx vitest run && npm run build)
```

`--stage=7` is the point: readiness reads the on-chain `config.silv_mint` and requires both apps to
equal it exactly. Before T1 there is nothing to compare and it says so; from step 7 it blocks.

### 6b. Deploy the admin panel. BLOCKING for step 8.

**Round 5 P0-03, decision D3.** This used to be step 11, after the two steps that need it. `config.admin`
is the Ops Squads vault `65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS`, which is OFF-CURVE: no private
key exists for it, so `has_one = admin` can never be satisfied by a keypair. The panel is the only
thing in this repo that wraps a dominion instruction into a Squads vault transaction, collects
approvals and executes it. Deploying it after step 8 left that step with no executable path and forced
improvisation on exactly the actions that set the launch posture.

```bash
# Vercel env for apps/admin:
#   NEXT_PUBLIC_HELIUS_RPC     = a mainnet RPC
#   NEXT_PUBLIC_OPS_SQUADS     = 65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS
#   NEXT_PUBLIC_UPGRADE_SQUADS = FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3
(cd apps/admin && vercel --prod --yes)
```

`NEXT_PUBLIC_OPS_SQUADS` is what makes the console admit Squads members. Without it the portal only
admits `config.admin` (a PDA that cannot connect a wallet) and active guardians (none yet at this
point), so the panel is inert.

**Confirm before continuing:** connect a Squads member wallet, and check the panel reports the Ops
multisig as configured and you as an active member. A panel that loads is not a panel that can propose.

### 7. RETIRED in round 8. Nothing to do. Go to step 8.

**This step used to propose the public-mint open so its 24h ran during setup. There is no longer
anything to open.** The round-8 launch posture (owner, 2026-08-09) has `initialize` write
`public_mint_enabled = true` and `redemptions_enabled = true`, so no base setting costs a 24h wait
during the ceremony. `scripts/ceremony-step7.ts` is deleted with the step: run against the new
posture it would propose a value the config already holds and revert `PublicMintUnchanged`.

**The redeem switch is asymmetric on purpose, and the asymmetry survives the open posture.**
Closing redemptions is instant on two lanes; opening them is refused on both and can only
happen through the 24h timelock, which a guardian can cancel. The two closing lanes are
`set_redemptions_enabled(false)`, which the admin signs alone, and the emergency tighten lane, which
also disarms any queued open so a pending loosening cannot land moments after an incident response.
Neither lane can set the switch back to true: the program refuses it in bytecode from BOTH states, so
there is no sequence of instant calls that reopens payouts. The only path back is
`propose_set_redeem_limits({ redemptionsEnabled: true })`, the 24h wait, then execute, and during
that window any active guardian can cancel it alone. Operationally: closing is a decision you can
take in one signature at 3am, reopening is a decision the whole quorum sees coming for a day.
`scripts/test-security-posture-docs.ts` runs the on-chain tests that demonstrate each half of this
paragraph and fails if this text and those tests ever stop agreeing.

**What holds the launch instead is THE PAUSE, and the pause is now guarded.** `unpause` requires an
ACTIVE guardian distinct from the admin, so the transition to live cannot happen before an
independent party can pause and can cancel a timelocked action. That is why step 8 registers the
guardians BEFORE it unpauses, in that order.

**ROUND 8 REVIEW: THIS IS NO LONGER ONE STEP, AND RUNNING IT AS ONE PRODUCES A REVERT.**
`add_guardian` increments `config.guardian_count`, and the unpause commits to a digest that includes
it, so a batch carrying both builds an unpause the chain refuses with `StaleReadinessDigest`, after
the registrations have already landed. Step 8 therefore registers the guardians and STOPS, printing
why. **Re-run step 8**: the registrations then read as already done, the config is re-read, and the
unpause is emitted with a digest that matches the state it will meet. Do NOT run `--verify` between
the two runs: the protocol is still paused, which is correct, and `--verify` would report that
correct state as a failure.

**The number is kept deliberately.** `verify-mainnet-readiness.ts --stage=N` and several checks in
this page are keyed to these numbers; renumbering would silently move every `dueStep` deadline. A
retired step that says so is safer than a renumbered sequence.

**`treasury_min_float_usdc` is NOT proposed at launch, by decision.** D5 (owner, 2026-08-07) sets it to 0
in full knowledge: no floor opposes an admin withdrawal, so one can drain the whole USDC treasury,
the balance that backs user redemptions. That is SolidProof LOW #4, open by choice. What still defends
it: `withdraw_usdc` is 24h-timelocked and a guardian can cancel it inside that window, so a withdrawal
is announced a day ahead and vetoable. The float was a second belt, not the first. It stays changeable
at any time via `propose_set_treasury_min_float`.

This page previously called a non-zero float a BLOCKER while the decision said zero, and the retired
`ceremony-step7.ts` refused to run without one. Round 5 P1-06: two sources of truth giving
incompatible orders. To propose a float, use `propose_set_treasury_min_float` from the admin panel.

### 8. Register the guardians, then unpause

```
add_guardian(<guardian 1>)                 # instant
add_guardian(<guardian 2>)                 # instant
unpause                                    # instant, and REFUSED until a guardian above exists
```

**DO STEP 9b (the fee vault) BEFORE THE UNPAUSE.** The numbers no longer match the order, and this is
the one place it matters. Under the old posture the unpause did not make the priced path usable: the
public mint stayed closed until step 10, so the vault only had to exist before THAT. Round 8 opens
both switches at `initialize`, so the unpause IS the go-live, and `mint_silv` and `redeem_silv` both
take the fee vault as a REQUIRED account. The real order is:

```
8   add_guardian x N          (instant, no side effect on users)
9b  create the fee vault      (one ATA, permanent, no program instruction)
8   unpause                   (THE GO-LIVE: mint and redeem are already open)
9   admin_premint             (requires !paused, so it comes after the unpause)
10  prove the priced path with real money
```

`ceremony-step8.ts` ENFORCES this rather than trusting the reader: it refuses to emit the unpause
while the fee vault is missing, and says which script to run. The numbers are kept because
`verify-mainnet-readiness.ts --stage=N` is keyed to them.

**THE GUARDIAN ORDER IS ALSO THE POINT, not a convenience.** `unpause` now takes a `GuardianAccount` and refuses
both an empty guardian set (`NoActiveGuardian`) and a guardian that is the current admin
(`GuardianNotIndependent`). With mint and redeem already open in the initialized config, an unpause
before that brake exists would switch on every flow with nobody able to stop it. `ceremony-step8.ts`
emits the instructions in this order and points the unpause at the first guardian it registers.

**`set_inventory_wallet` is GONE from this step, and from the program.** Round 8 T8-03: the pre-mint
destination is an argument of `initialize` (step 5), bound atomically and validated non-default, and
the only writer afterwards is `propose_set_inventory_wallet` plus the 24h timelock. Step 8 now
CHECKS it instead of setting it: if `config.inventory_wallet` is not the address in
`config/mainnet-authorities.json`, the script REFUSES the whole step rather than unpausing over a
destination this ceremony did not choose.

Same three-phase shape as the other ceremony steps:

```bash
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/ceremony-step8.ts
#    -> ceremony-out/step8.json; execute each through the panel (Squads); then:
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/ceremony-step8.ts --verify
```

`--verify` compares the EXACT set of registered guardians, not a count and not a floor. Round 5 P2-04:
the old check was `guardian_count >= guardians.length`, which passes with a guardian nobody chose
registered alongside the ones you did.

**`set_treasury_min_float_usdc` DOES NOT EXIST** as an instant call; the devnet rehearsal of
2026-08-07 found no such instruction in the IDL. The real pair is `propose_set_treasury_min_float` /
`execute_set_treasury_min_float`, 24h-timelocked. See step 7 for why it is not part of the launch lot.

**After this step the protocol is LIVE.** There is no later step that opens anything: the unpause
above is the last gate. Do not run it until steps 9 and 9b are ready to follow immediately.

### 9. Pre-mint and seed the pool

The plan is **$6.75M worth of SILV** (Thomas 2026-07-29). Do NOT reuse a figure agreed
days earlier: the budget is in dollars and the cap is in ounces, so the ounce count moves
with the silver price. Compute it at ceremony time:

```bash
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/premint-sizing.ts
```

At $58.34 spot that is **~115,705 oz**, i.e. `admin_premint(115705029311)`, and 77% of the
150,000 oz cap. The script prints the atomic value (an off-by-1e6 there is a 1,000,000x
error) and refuses if the cap could not absorb it. That figure is an EXAMPLE at one spot
price: re-run the sizing and use what it prints. On 2026-08-10 spot was $63.61 and the same
budget was ~106,115 oz.

Then SEND it with the tranche script, which takes the atomic figure the sizing printed:

```bash
DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet> \
  DOMINION_KEYPAIR=<the key that IS config.admin> DOMINION_INTENT=admin_premint \
  npx tsx scripts/premint.ts --atomic <tranche1> --dry-run   # resolve, send nothing
DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet> \
  DOMINION_KEYPAIR=<the key that IS config.admin> DOMINION_INTENT=admin_premint \
  npx tsx scripts/premint.ts --atomic <tranche1>
```

**`DOMINION_INTENT=admin_premint` is required** since 2026-08-10, when `admin_premint` was
reclassified `irreversible` in `_guard.ts`. It had been `reversible` on the grounds that
"the cap bounds it". The cap bounds the TOTAL and is not an undo: there is no admin burn in
this program at all, the only burn needs the holder's signature and runs inside
`redeem_silv`, which pays out treasury USDC. An over-mint has no undo.

**READ THIS BEFORE YOU RUN IT IF `config.admin` IS THE SQUADS VAULT.** `premint.ts` is a
DIRECT sender: it signs with a local keypair. The recommended `initialize` binds
`config.admin` to the Ops Squads vault `65g5nNX…`, which is OFF-CURVE, so no private key
exists for it and `has_one = admin` can never be satisfied by any keypair. The script now
calls `assertSendable` and refuses up front with that explanation, but **it has no emit
mode**, so on that configuration this step has no tooling and the pre-mint must go through
the admin panel like the other Squads actions. The 2026-08-10 devnet rehearsal could not
surface this: devnet's admin is a single key. Decide before the ceremony which shape you
are in, and if it is the vault, budget for the panel path.

**Run `--dry-run` first, every time.** It prints the resolved destination, the cap, the
headroom that would be left, refuses the whole plan if the tranches do not fit, and
cross-checks `config.inventory_wallet` against `config/mainnet-authorities.json` the same
way step 8 does.

**If a run stops part-way**, it keeps a record at `ceremony-out/premint-state.json`, names
the tranches that landed and the ones that did not, and a plain re-run REFUSES. Finish it
with `--resume`. Never re-issue the original command: the cap catches a duplicated 106,115
oz plan, but it does NOT catch a duplicated ~1,750 oz operational tranche, which would
silently double-mint into the hot wallet.

Three things about that record an operator meets at the worst moment, so read them now:

- **A tranche can be IN FLIGHT**, if the process died between sending and recording the
  signature. `--resume` reconciles it against the inventory ATA balance before sending
  anything: `before + amount` means it landed, `before` exactly means it did not.
- **Any other balance REFUSES and asks you to decide.** Something else moved the account
  (an inbound transfer, or the permanent delegate). Find the transaction, then hand-edit
  `ceremony-out/premint-state.json`: move the tranche into `landed` if it landed, or delete
  `inFlight` if it did not. The script will not guess, because one guess double-mints and
  the other silently skips a tranche.
- **A completed run is ARCHIVED, not deleted**, to `premint-<timestamp>.done.json`, and
  re-running the SAME plan within 30 minutes refuses. That is the up-arrow-enter guard. A
  deliberate second pre-mint passes `--again`.

The script exists because this step had NO tooling until the devnet rehearsal of
2026-08-10: the runbook said "run admin_premint" and the only senders in the repo were a
test pinned at 1000 oz and the admin panel. It takes tranches, repeatable, because that is
the shape of D11 below, and it asserts both the supply delta AND the inventory ATA delta
after each one, since a mint that lands in the wrong account still moves supply.

**D11, 2026-08-09: PRE-MINT THE OPERATIONAL TRANCHE ONLY. This is now a rule, not advice.**

The paragraph below used to say "consider pre-minting in tranches instead". Opening
redemptions at launch turned that suggestion into a requirement, because it changed what
the inventory key is worth.

While `redemptions_enabled` was false, whoever held `EkDhR65J...` held SILV and nothing
else. With redemptions open they hold a **direct claim on treasury USDC**: they sign
`redeem_silv` themselves, with no admin instruction, no redirection of the inventory
wallet, and **no timelock**. Fixing the binding at `initialize` closes the Ops path to
that wallet; it does nothing about the tokens once they are in it. Blocking the inventory
address inside `redeem_silv` would not help either: SILV is fungible and can be moved to
another address first.

The only code bound on the drain is the rolling window, and cite the REAL one:
`redeem_window.rs` documents and tests that an adversarial alignment lets nearly **2x the
budget** out in one window-length slice, i.e. about **40,000 USDC in 24h** at the default,
then about 20,000 per day for as long as nobody pauses. Pause is a human reaction, not an
automatic stop.

**So:**

- Pre-mint **only what the pool needs now**, and re-run `admin_premint` later when there
  is a new use. It is callable as often as you like, and the cap is a ceiling rather than
  a target.
- The **reserve does not go to the hot key**. It goes to a Squads vault, or it is not
  minted at all.
- The size of the operational tranche must be compatible with the maximum loss you accept
  over your detection-and-reaction SLA, computed with the **2x** bound. **That number is
  Thomas's input and is not fixed yet.** The natural starting point is the pool
  requirement itself, ~1,750 oz (~$100k) below, which is 1.5% of what the old plan would
  have left exposed.

Full rationale, including what this decision does NOT close, is recorded in
`config/mainnet-authorities.json` under `launch_posture._premint_custody_note`.

**One consequence to hold in mind either way:**

- The full plan leaves ~34,300 oz of headroom, and `mint_silv` draws on the SAME cap. So
  site sales are hard-capped at roughly **$2.03M** before `SupplyCapExceeded`, and raising
  the cap then needs a program upgrade.

Then from the inventory wallet, create the Sunrise SILV/USDC pool with the SILV and your
100,000 USDC. The inventory wallet is a **plain single-signer wallet** and will hold the
entire pre-minted supply, so treat its key as equal in value to the pool.

### 9b. Create the fee vault. BLOCKING for step 8's UNPAUSE, so do it BEFORE that.

```bash
DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet> DOMINION_INTENT=create_fee_vault \
  npx tsx scripts/create-fee-vault.ts
npx tsx scripts/verify-mainnet-readiness.ts --stage=10   # must not report the vault as OVERDUE
```

`mint_silv` and `redeem_silv` both take the fee vault as a REQUIRED account, so if it does not exist EVERY
mint and EVERY redeem reverts `AccountNotInitialized`, which reads like a broken program. This used to live
in the PREREQUISITES section outside the numbered steps, which is round 3's P1: the operator following the
sequence never reached it and step 10 could open the mint on top of a missing vault.

**ROUND 8 MOVED THE DEADLINE EARLIER, and the number stayed.** With mint and redeem open from
`initialize`, the go-live is step 8's unpause, not step 10, so the vault must exist before the
unpause. `ceremony-step8.ts` refuses to emit the unpause without it rather than leaving that to the
order of two headings, because a prerequisite nobody numbers is a prerequisite somebody skips and
this exact vault is the one that proved it.

### 10. Prove the priced path with real money

**No `execute_set_public_mint` here any more.** This step used to execute the proposal step 7 queued
24 hours earlier; round 8 opens both switches at `initialize`, so by the time step 8's unpause lands
the priced path is already live. What remains is the part that always mattered: proving it works
against the real feed, with real funds, at the smallest amount the program accepts.

The launch lot went from three proposals to one to none. The redeem open left it in round 4 (P0-04),
the treasury float was never in it (D5), and the public-mint open left it in round 8 with the posture
change. Round 5 P3-01 recorded the middle state; this is the end of that line.

Prove the priced path works with real money, smallest possible amount:

```bash
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_RPC=https://api.mainnet-beta.solana.com \
E2E_ALLOW_MINT_ONLY=1 npx tsx scripts/e2e-lazer-mint.ts
```

It simulates before sending, so a failure names the guard that rejected it instead of an
opaque revert. **Confirm the implied premium comes out at 1.000%**, which is
`launch_posture.premium_bps_mint = 100`. This page said 1.500% until round 5 P3-01: that was the
premium from a spec superseded on 2026-07-30, and an operator confirming it would have accepted a
launch running on the wrong tariff, or rejected a correct one.

**Any priced operation must be worth at least `config.min_operation_usdc`** (round 5 P1-04, shipped at $10). Below it
the program reverts `OperationBelowMinimum`. The E2E's 10 USDC sits exactly at that floor. The floor
exists because D2 made one signed Lazer print price exactly ONE operation, and without it a
60 micro-USDC mint, or a 1-atomic-SILV redeem, could capture every print for essentially nothing. It applies to BOTH sides: `amount_usdc` on mint, the gross USDC value on redeem. Read the live value rather than
trusting this page:

```bash
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/read-config.ts | grep -i minOperation
```

**ROUND 4 P1-05, lisez ceci avant de lancer le smoke test.** `e2e-lazer-mint.ts` soumet un mint REEL de
10 USDC, puis sort en code 2 si `redemptions_enabled == false`, ce qui est la posture de lancement. Donc sans
`E2E_ALLOW_MINT_ONLY=1` il depense 10 USDC reels puis echoue, et chaque relance pour obtenir un vert depense
10 USDC de plus. La variable est ajoutee aux commandes ci-dessus.

Le code de sortie 2 existe pour qu une demi-preuve ne passe pas pour un succes. En mainnet au lancement la
moitie redeem est fermee PAR CONCEPTION, donc l override est la bonne reponse, pas l ouverture du redeem.
N ouvrez jamais le redeem pour faire verdir un test.

Il faut aussi `PYTH_LAZER_KEY` dans l environnement (pour recuperer l enveloppe) et un `DOMINION_KEYPAIR`
mainnet finance en SOL et en USDC.

### 11. Deploy the PUBLIC app, pointed at mainnet

The admin panel went live at step 6b, because step 8 cannot be executed without it. Only the
public app is left.

```bash
# Vercel env for apps/public:
#   NEXT_PUBLIC_HELIUS_RPC   = a mainnet RPC (the public endpoint will rate-limit you)
#   NEXT_PUBLIC_OPS_SQUADS   = 65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS
#   NEXT_PUBLIC_UPGRADE_SQUADS = FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3
#   PYTH_LAZER_API_KEY       = the entitled key (public app only)
(cd apps/public && vercel --prod --yes)

DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/verify-oracle-sync.ts
```

**Then exercise `/api/lazer` with `fresh: true` twice in a row against production.** BOTH must return
**200**. The first carries `"contended": false`, the second `"contended": true`, because D2 lets one
signed print price exactly one operation and the proxy marks everyone after the first claimant.

A 409, or anything other than 200, means a build predating the round 5 review pass is deployed. An
earlier version of this fix REFUSED the contended caller, and refusing turns an unauthenticated
endpoint into a free denial of the whole mint and redeem UI: one request per second from anywhere
claims every print. Contention is advisory now, and two 200s is the correct result.

```bash
curl -s -X POST https://<app>/api/lazer -d '{"fresh":true}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("contended:", d.get("contended"))'
curl -s -X POST https://<app>/api/lazer -d '{"fresh":true}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("contended:", d.get("contended"))'
```

### 12. LAST: move the upgrade authority to the multisig

Only after everything above works. `initialize` needed the deployer to be the upgrade
authority, so this cannot come earlier.

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3 \
  -k ~/.config/solana/dominion-dev.json -u mainnet-beta

solana program show <PROGRAM_ID> -u mainnet-beta   # Authority must now be FqFNX
```

**Do NOT use `--final`.** That makes the program immutable and PERMANENTLY forecloses every future
code change: bug fixes, new instructions, and the redeem-side features that are still unwritten.

The reason given here until 2026-08-06 was that "redemptions can only ever be opened by an upgrade".
That was false (audit D-02): opening redemptions is a `config` change through the 24h-timelocked
`SetRedeemLimits` action and needs no upgrade authority. The correct reason to avoid `--final` is
simply that the code is not finished. Immutability is a decision for after the redeem flow ships.

**Read this before you run it: it changes how every future upgrade works.** Once the authority is the
off-curve vault `FqFNX...`, no private key can sign an upgrade, so `scripts/upgrade-program.ts` REFUSES
(round 5 P1-08; it used to require `solana address` to BE the authority, which nothing can satisfy
after this step). The path from here on is:

1. take the `.so` published by the `reproducible-build` job for the target commit, and verify its
   sha256, size and `program_id` against `release-manifest.json` from that same run;
2. `solana program write-buffer <that .so>` with any funded keypair;
3. `solana program set-buffer-authority <buffer> --new-buffer-authority FqFNX...`;
4. propose `BpfLoaderUpgradeable::Upgrade` from the Upgrade Squads with that buffer;
5. approve to threshold and execute;
6. `solana program dump`, truncate to the artifact length, compare sha256 to step 1;
7. `anchor idl upgrade`, then re-read the IDL account and compare it to the attested file.

Steps 1 and 6 are what make it an upgrade to a KNOWN binary rather than to whatever was on the machine
that ran it. **This flow has never been rehearsed.** Rehearse it on devnet with a Squads vault as the
upgrade authority before it is the only way to ship a fix.

---

## What is still NOT possible after this launch, and why

| Thing | Why not | Cost to change |
|---|---|---|
| Enable KYC | The gate ships DORMANT and IS read by mint and redeem. Arm with `set_kyc_operator` then attestations then `set_kyc_scope` (bit 0 mint, bit 1 redeem). | config change, instant |
| Open redemptions | The 24h-timelocked SetRedeemLimits action carries the switch: `propose_set_redeem_limits` with `redemptionsEnabled = true`, wait, execute. See the PREREQUISITES section. | config change, 24h |
| Raise the 150,000 oz cap | tighten-only, by design | program upgrade |
| A minimum redemption size (Mark's 5,000 oz) | does not exist; only `amount > 0` | program upgrade, same batch as redeem |
| ~~Lower the redeem queue delay~~ | REMOVED 2026-08-05: `redeem_queue_delay_seconds` is dead on chain, the queued path is gone. | n/a |
| `min_publishers` below 2 | `MIN_PUBLISHERS_FLOOR_HARD` | program upgrade |
| Mint premium above 5% | `PREMIUM_BPS_MINT_CEILING = 500` (raised 2026-08-05) | program upgrade |
| Redeem premium above 5% | `PREMIUM_BPS_REDEEM_CEILING = 500`, and Mark's 5% is AT it | program upgrade |

All of these are deliberate. They exist so a compromised admin cannot do them either.
Group them into one Phase 1 upgrade rather than shipping several.

## REAL RESIDUAL, added 2026-08-05

The redemption rate limiter is a SLIDING WINDOW COUNTER, which is an approximation. Its worst case
over a trailing window is **2x `instant_redeem_budget_usdc`**, not 1x, reachable by draining the
budget near the end of one bucket and again near the end of the next (the two spends land nearly a
full window apart, so both fall inside one trailing window).

What the sliding counter fixed was the RATE, not the bound: the fixed window it replaced allowed the
same 2x in about ONE SECOND, by waiting for a reset. Now it takes nearly a full window, which is the
difference between an unobservable event and one a guardian can pause during.

**So size `instant_redeem_budget_usdc` at HALF the maximum daily outflow you are willing to see.**
The derivation and the concrete construction are in `state/redeem_window.rs`. This was documented as
1.5x until the review-of-fixes maximised it properly.

## PREREQUISITES ADDED 2026-08-05 (the bundled pre-mainnet upgrade)

These are new and none of them existed when the numbered steps below were written. Two of them
are hard blockers.

### P1. Create the fee vault. BLOCKER, before step 9 or 10.

`mint_silv` and `redeem_silv` both take the premium fee vault as a REQUIRED account. If it does
not exist, EVERY mint and EVERY redeem reverts `AccountNotInitialized`, which reads like a broken
product rather than a missing setup step. Nothing creates it automatically: `initialize` does not
touch it.

```
DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet> DOMINION_INTENT=create_fee_vault npx tsx scripts/create-fee-vault.ts
```

Idempotent, one-way and permanent: the vault is a PDA-owned associated token account, so once it
exists it can never be closed. The admin panel shows a red banner while it is missing, so check
the dashboard before opening anything.

### P2. `treasury_min_float_usdc` stays 0. ACCEPTED RISK, not a blocker.

**Round 5 P1-06.** This section called a non-zero float a BLOCKER before opening redeem, while D5
(owner, 2026-08-07) sets it to 0 deliberately. `ceremony-step7.ts` refused to run without one and
`verify-mainnet-readiness.ts` reported it as an unmet human blocker. Following the decision made the
tools fail; following the tools annulled the decision. The decision wins, and the tools now agree.

**The risk, stated plainly.** No floor opposes an admin withdrawal, so one can drain the whole USDC
treasury, the same balance that backs user redemptions. That is SolidProof LOW #4, and it is open by
choice. Premium revenue no longer accumulates inside the treasury to cushion it either: mint and
redeem route the premium OUT to the fee vault.

**What defends it instead.** `withdraw_usdc` is 24h-timelocked and a guardian can cancel it inside
that window, so a withdrawal is announced a day ahead and is vetoable. The float was a second belt.

**What that costs you operationally:** somebody has to be watching. The 24h announcement is only a
defence if a human sees it and a guardian acts. `verify-mainnet-readiness.ts` now asks for that by
name, in place of the old "set a non-zero float" item.

Reversible at any time with `propose_set_treasury_min_float` / `execute_set_treasury_min_float` (24h).
If redeem volume grows, set a floor then; nothing here is one-way.

### P3. Fees are `initialize` ARGUMENTS: 1% mint, 1.5% redeem.

`premium_bps_mint = 100`, `premium_bps_redeem = 150` (Mark, 2026-07-30). Both ceilings are 5%.
Both remain 24h-timelock changeable, so nothing is locked in. The fee is 1% OF WHAT FLOWS THROUGH,
taken off the top on both sides, not folded into a marked-up price.

### P4. Opening redemption no longer needs an upgrade.

`set_redemptions_enabled` still refuses `true`, but the 24h-timelocked `SetRedeemLimits` action now
carries the switch: `propose_set_redeem_limits` with `redemptionsEnabled = true`, wait 24h,
execute. The admin panel has a dedicated "OPEN redemptions (propose, 24h)" card. Closing is
instant and ALSO disarms any pending open.

### P5. The fee-exemption whitelist exists, and prefer mint-only.

Per-wallet, per-side, instant both ways. A wallet exempt on BOTH sides trades at exact spot each
way, which hands it a free option on oracle movement paid by the treasury. Exempt the MINT side
alone unless there is a specific reason not to.

### P6. Sweep the fee vault with `withdraw_fees`, not `withdraw_usdc`.

Two different accounts. `withdraw_usdc` moves the BACKING and is 24h-timelocked;
`withdraw_fees` moves earned revenue and is instant, but it refuses while paused and while the
treasury is below its float. Sweep on a cadence so the standing balance stays small.

## Known accepted risks at launch

1. **`FqFNX` holds upgrade authority AND compliance AND guardian.** SolidProof MEDIUM #1
   asks for these to be split. A compromise of that one vault can rewrite the program
   and freeze or seize any holder. Accepted by Thomas 2026-07-26; recorded in
   `config/mainnet-authorities.json`. What it still defends: the hot Ops key is separate.
2. **Pyth guarantees only 1 publisher on feed 3154; the contract requires 2.** It
   observes 3 today. A legitimate degradation to 1 halts every priced operation.
3. **The inventory wallet is a single-signer key holding the whole pre-mint.**
- ~~`admin_settle_redemption_offchain` can void a payable claim~~ RESOLVED 2026-08-05: the instruction was DELETED with the queued path, which removed SolidProof MEDIUM #4 from the codebase rather than accepting it. This was listed as "must be fixed before they open" and is now a phantom blocker: do not hold the launch on it.
   (The trailing line "Unreachable while redemptions are closed. Must be fixed before they open." survived
   the strike-through until 2026-08-06 and read as an ACTIVE blocker, re-audit P3. There is nothing to fix:
   neither the instruction nor the queue exists.)
- ~~The queued redeem path does no volume accounting~~ RESOLVED 2026-08-05: there is no queued path. Redemption is one instant route and it DOES debit a global sliding-window budget.
