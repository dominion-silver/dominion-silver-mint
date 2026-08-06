# Dominion SILV: mainnet launch runbook

Every step in order, with the exact command, what it proves, and what breaks if it is
skipped. Written against the six launch requirements Thomas confirmed on 2026-07-29.

**Read the two hard rules first, then the four things that are IRREVERSIBLE, then run
the steps in order. Do not reorder them: several steps only work in one sequence.**

---

## The two hard rules

**RULE 1. Nothing touches mainnet unless the command says so.** Every E2E script now
calls `requireDevnet()` from `scripts/_guard.ts` and refuses a non-devnet RPC unless
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
| 4. Redeem closed now, open later by upgrade | ✅ exactly this | `set_redemptions_enabled` refuses `true` in the deployed bytecode. Opening is a code change by construction. |
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

# 0b. The build is reproducible and carries no dev hatch.
scripts/verify-release-artifact.sh

# 0c. Every hand-copied address agrees with declare_id!.
scripts/verify-constants-consistency.sh

# 0d. The feed satisfies every on-chain guard, on MAINNET data.
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/probe-lazer-feed.ts
```

**Blockers to clear by hand:**

- [ ] Deployer `2Lp91Fy…` funded with **~9.2 SOL** on mainnet (rent is recoverable via
      `solana program close`; measured, not estimated).
- [ ] The Pyth key in Vercel Production has the **`pyth-indices` entitlement** for feed
      3154. Test: `curl -X POST https://<app>/api/lazer -d '{}'` must return a price,
      not a 403.
- [ ] Sunrise has confirmed they accept a Token-2022 mint carrying **freeze authority +
      permanent delegate**. If not, there is no venue and the launch model fails.
- [ ] `https://dominion.market/silv-metadata.json` resolves (it is baked into the mint
      permanently).
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

### 2. Point the source at the new id, rebuild, verify

Update `declare_id!` in `programs/dominion_silver_mint_v2/src/lib.rs`, add
`[programs.mainnet]` to `Anchor.toml`, and set `PROGRAM_ID` in both apps' `constants.ts`.
Then:

**THE AUTHORITATIVE BUILD TOOLCHAIN** (audit finding S-07). Three generations of tooling were
circulating under one "reproducible" label: the Dockerfile header said Solana 1.18.26 / Anchor 0.30.1
/ Rust 1.79 while its own ARGs said 2.1.20 / 0.31.1 / 1.79, and CI declares 3.1.14 / platform-tools
1.52 / rustc 1.89.0. None of those is what produced the artifact.

The toolchain that actually built `dominion_silver_mint.so` at sha256
`799945e416c8a71151a1656a8dc2ed1c272e1d5f2764b09963f8052ee856403f`, confirmed on two independent
machines (this one and the external auditor's, 2026-08-06):

| Component | Version |
|---|---|
| solana-cli / solana-cargo-build-sbf | 3.0.0 |
| platform-tools | v1.51 |
| SBF rustc | 1.84.1 |
| host rustc (for `anchor idl build`) | 1.89.0 |
| anchor-cli | 0.31.1 |

Build with `-- --locked`, always. Without it a build may RESOLVE `Cargo.lock` instead of failing when
a manifest and the lock disagree, which is the opposite of what a release build should do.

**Known open divergence, deliberately not papered over:** CI declares Solana 3.1.14 / platform-tools
1.52, so a CI-produced binary is not guaranteed to hash-match the table above. Aligning CI needs a CI
run to prove it, and the header comment at `.github/workflows/build.yml:15` records that an earlier
version-bump attempt broke the build (`edition2024` unparseable, `pyth-solana-receiver-sdk` E0782).
Until that is resolved, **the release artifact is the LOCALLY built one verified by
`scripts/verify-release-artifact.sh`**, and the `reproducible-build` CI job (now blocking, audit
S-05) is the independent third-party check via `solana-verify`.

```bash
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml -- --locked
(cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked > ../../target/idl/dominion_silver_mint.json)
cp target/idl/dominion_silver_mint.json apps/admin/src/lib/idl/
cp target/idl/dominion_silver_mint.json apps/public/src/lib/idl/
scripts/verify-constants-consistency.sh   # must pass
scripts/verify-release-artifact.sh        # must print ARTIFACT OK
```

Also swap the two cluster-specific constants that are easy to miss:

- `USDC_MINT` → `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` in **both** apps
- `LAZER_TREASURY` → `Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak` in `apps/public`

### 3. Deploy

```bash
solana program deploy target/deploy/dominion_silver_mint.so \
  --program-id ~/.config/solana/dominion-mainnet-program.json \
  -k ~/.config/solana/dominion-dev.json -u mainnet-beta
```

Then verify the bytes actually on chain, which is not optional:

```bash
solana program dump <PROGRAM_ID> /tmp/onchain.so -u mainnet-beta
LEN=$(stat -f%z target/deploy/dominion_silver_mint.so)
head -c "$LEN" /tmp/onchain.so > /tmp/onchain-trim.so
shasum -a 256 target/deploy/dominion_silver_mint.so /tmp/onchain-trim.so   # must match
solana program show <PROGRAM_ID> -u mainnet-beta                            # Authority = deployer
```

### 4 + 5 + 6. T1 hostile bootstrap, which CREATES THE MINT and INITIALISES

**This is the step people get wrong.** `initialize` succeeds exactly once per program
id, so the window between step 3 and initialisation is the ONLY chance to prove the
DOM-001 P0 fix. T1's case 5 performs the real `initialize`, so **a passing T1 IS your
initialisation.** Run it BEFORE any init script.

```bash
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_PROGRAM_ID=<PROGRAM_ID> \
DOMINION_KEYPAIR=~/.config/solana/dominion-dev.json \
npx tsx scripts/t1-hostile-bootstrap.ts
```

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

**`admin` and `upgradeAuthorityInfo`** are still the signer, by design: `initialize` binds them to
the deploying upgrade authority (audit DOM-001), so deploy from the Ops Squads vault or transfer the
upgrade authority to it AFTER initialize (step 12).

Still edit `scripts/_t1-mint-helper.ts` so the mint's freeze authority and permanent delegate are the
compliance vault rather than the payer. **Those two are permanent**, fixed at mint creation, and no
program upgrade can restore them.

Expect 17/17. Then record everything:

```bash
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/read-config.ts
spl-token display <SILV_MINT> -u mainnet-beta
```

Check by eye: decimals 6, mint authority = the `silv_mint_authority` PDA, freeze
authority = compliance vault, extensions exactly {PermanentDelegate, MetadataPointer,
TokenMetadata}, `paused = true`, `public_mint_enabled = false`,
`redemptions_enabled = false`, `max_silv_supply = 150000000000` (150,000 oz).

### 7. Propose the public-mint open NOW, so the 24h runs during setup

Do this immediately, not at the end. It costs nothing and saves a day.

```bash
# via Squads, since admin is the Ops vault: propose_set_public_mint(true)
```

### 8. Register the guardians, set the inventory wallet, unpause

```
add_guardian(<guardian 1>)
add_guardian(<guardian 2>)
set_inventory_wallet(EkDhR65JUL8tGhxRhnueaqri6zNzxMEJ82UU35pQ7V56)
set_treasury_min_float_usdc(<non-zero>)   # SolidProof LOW #4
unpause
```

`treasury_min_float_usdc` defaults to 0, which means a withdrawal can drain the whole
treasury. Set it before any USDC arrives.

### 9. Pre-mint and seed the pool

The plan is **$6.75M worth of SILV** (Thomas 2026-07-29). Do NOT reuse a figure agreed
days earlier: the budget is in dollars and the cap is in ounces, so the ounce count moves
with the silver price. Compute it at ceremony time:

```bash
DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/premint-sizing.ts
```

At $58.34 spot that is **~115,705 oz**, i.e. `admin_premint(115705029311)`, and 77% of the
150,000 oz cap. The script prints the atomic value (an off-by-1e6 there is a 1,000,000x
error) and refuses if the cap could not absorb it.

**Two consequences to hold in mind:**

- It leaves ~34,300 oz of headroom, and `mint_silv` draws on the SAME cap. So site sales
  are hard-capped at roughly **$2.03M** before `SupplyCapExceeded`, and raising the cap
  then needs a program upgrade.
- Only ~1,750 oz (~$100k) goes into the Sunrise pool. The other ~114,000 oz (~$6.65M)
  would sit in the inventory wallet, which is a **single-signer key**. Consider
  pre-minting in tranches instead: `admin_premint` is callable as often as you like, so
  there is no need to create supply before it has a use.

Then from the inventory wallet, create the Sunrise SILV/USDC pool with the SILV and your
100,000 USDC. The inventory wallet is a **plain single-signer wallet** and will hold the
entire pre-minted supply, so treat its key as equal in value to the pool.

### 10. Execute the public-mint open (24h after step 7)

```
execute_set_public_mint(<nonce>)
```

Then prove the priced path works with real money, smallest possible amount:

```bash
DOMINION_ALLOW_MAINNET=i-understand \
DOMINION_RPC=https://api.mainnet-beta.solana.com \
npx tsx scripts/e2e-lazer-mint.ts
```

It simulates before sending, so a failure names the guard that rejected it instead of an
opaque revert. Confirm the implied premium comes out at 1.500%.

### 11. Deploy both apps, pointed at mainnet

```bash
# Vercel env, per app:
#   NEXT_PUBLIC_HELIUS_RPC   = a mainnet RPC (the public endpoint will rate-limit you)
#   NEXT_PUBLIC_OPS_SQUADS   = 65g5nNXTtqtFz3jggKAqyvS6oCoVUXuXqAU9B8jHqPPS
#   NEXT_PUBLIC_UPGRADE_SQUADS = FqFNXCMeEYUD64tLPhvVzBAnovfYBAGsU8d6qdLnvzZ3
#   PYTH_LAZER_API_KEY       = the entitled key (public app only)
(cd apps/public && vercel --prod --yes)
(cd apps/admin && vercel --prod --yes)

DOMINION_RPC=https://api.mainnet-beta.solana.com npx tsx scripts/verify-oracle-sync.ts
```

`NEXT_PUBLIC_OPS_SQUADS` is what makes the console admit Squads members. Without it the
portal only admits `config.admin` and active guardians.

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
DOMINION_ALLOW_MAINNET=i-understand DOMINION_RPC=<mainnet> npx tsx scripts/create-fee-vault.ts
```

Idempotent, one-way and permanent: the vault is a PDA-owned associated token account, so once it
exists it can never be closed. The admin panel shows a red banner while it is missing, so check
the dashboard before opening anything.

### P2. Set `treasury_min_float_usdc` to a non-zero value. BLOCKER before opening redeem.

It was cosmetic while redeem was closed. It is not any more, and premium revenue no longer
accumulates inside the treasury to cushion it: mint and redeem now route the premium OUT to the
fee vault. The float is what stops `withdraw_usdc` from emptying the redemption buffer, and it now
also gates `withdraw_fees`.

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
   Unreachable while redemptions are closed. Must be fixed before they open.
- ~~The queued redeem path does no volume accounting~~ RESOLVED 2026-08-05: there is no queued path. Redemption is one instant route and it DOES debit a global sliding-window budget.
