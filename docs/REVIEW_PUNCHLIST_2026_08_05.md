# Triple-review punch list, 2026-08-05 batch

Source: three parallel reviewers (correctness, security, integration) over commits `98c0435`,
`5eb3d5f`, `8af4baa`. The two program P0s were fixed in `7db6e73`.

Working rule for this pass: fix ONE item, run the relevant tests, tick it, move on. Do not
batch unrelated edits into one commit, because a review-of-fixes has to be able to attribute a
regression to a single change.

## ALL 28 ITEMS CLOSED (2026-08-05)

Fixed across seven commits, one coherent group per commit so a review-of-fixes can attribute a
regression to a single change. Verification at the end of each: 130 program unit tests, admin 17,
public 25, both typechecks, both production builds, the constants gate, the NEW client/IDL parity
gate, and the mainnet readiness gate.

Two items grew during the fix because implementing the reviewer's remedy revealed the real bug:
A2 (no execute_* handler was bound to its config nonce, so every "clear the pending nonce" defence
in the program was cosmetic, tracked as A7) and A3 (the fixed window could not be made rolling by
renaming it, so it became a real sliding-window counter).

## Status legend

- `[ ]` open
- `[x]` fixed and verified
- `[-]` deliberately not fixing, with the reason recorded

---

## A. Program (Rust)

### [x] A1. `events.rs` — my own comment is FALSE and actively dangerous
`fee_usdc` is documented as "appended, so older decoders that stop after `timestamp` still
parse the prefix". It is inserted at index 4 of 6, BEFORE `timestamp`. A decoder on the
pre-upgrade IDL reads the 8 bytes of `fee_usdc` as `timestamp`: a $100 mint yields
`timestamp = 1000000`, i.e. 1970. No in-repo decoder exists, but the comment authorises a
stale off-chain indexer and that indexer will silently corrupt every mint and redeem timestamp.
Fix: correct the comment and state the real consequence. Do NOT move the field (that would
change the IDL for no benefit now that it is documented).

### [x] A2. Emergency close does not disarm a pending open
`execute_set_redeem_limits` deliberately skips the direction re-check, and neither
`set_redemptions_enabled(false)` nor `emergency_tighten_redeem_limits({redemptions_enabled:
false})` clears `pending_redeem_limits_nonce`. Incident: admin proposes open at T; at T+20h the
feed degrades and ops closes redemptions instantly; at T+24h the queued Squads execute, signed
hours earlier by people who do not know about the incident, RE-OPENS redemptions mid-incident.
`execute_set_redeem_limits` also lacks `require!(!config.paused)`, which
`execute_withdraw_usdc` has (D31), so the open lands even while paused and fires on unpause.
Fix: re-check the switch direction at execute against `config.redemptions_enabled` and refuse
`Some(true)` if redemptions were closed after the proposal was scheduled; add the paused check.
Note this is the ONE place a direction re-check is correct, and the existing comment explaining
why the numeric fields are NOT re-checked must be preserved and narrowed.

### [x] A3. The window is fixed, not rolling: the documented ceiling is 2x understated
`instant_window_start` re-anchors to `now` only on the first redemption after expiry. Drain the
remaining budget at `window_end - 1`, then drain the full budget again one slot later:
**2 x budget in ~one second**. At defaults that is $40k, not $20k, and it scales linearly with
any budget raise for market-maker flow. Both `config.rs` and `redeem_silv.rs` call it "rolling".
Fix: either implement a genuine sliding window, or clamp the burst, or rename it honestly to
"fixed window" everywhere and document the 2x. Cheapest honest option is the rename plus a
carry-forward clamp.

### [x] A4. The redeem premium leg bypasses `treasury_min_float_usdc`
`execute_withdraw_usdc` enforces `treasury_post >= treasury_min_float_usdc`. The redeem premium
leg (`treasury -> fee_vault`) enforces nothing, and once in the vault it is withdrawable
instantly. So the float is not the floor the panel and the docs present: 1.5% of every
redemption routes around it. The panel tooltip already warns the operator; the program does not
enforce it. Fix: gate `withdraw_fees` on `usdc_treasury.amount >= config.treasury_min_float_usdc`
(cheapest, keeps the redeem path untouched), or debit the float on the premium leg.

### [x] A5. No escape hatch if the fee vault becomes unusable
USDC carries a Circle freeze authority. A frozen fee-vault ATA permanently bricks mint and
redeem for every non-exempt wallet, recoverable only by a program upgrade: the vault cannot be
closed and there is no config field to point the premium elsewhere. Exempt wallets keep working,
which makes the failure asymmetric and confusing to diagnose. Low likelihood, unbounded blast
radius, zero on-chain remedy.
Fix options: route the premium to the treasury when the vault transfer fails, or add a
`fee_routing_enabled` flag that falls back to the old in-treasury behaviour.

### [x] A7. NEW, found while fixing A2: no `execute_*` handler is bound to its config nonce
Every `execute_*` in `admin/execute.rs` only ever WRITES its `pending_*_nonce` (to None at the
end) and never READS it. So clearing a pending nonce does not prevent execution.

That makes an existing, shipped protection cosmetic: `set_public_mint_enabled(false)` clears
`pending_public_mint_nonce` at `caps.rs:154`, and the comment at `caps.rs:152` states the
purpose as "leaving one pending after a deliberate emergency close would let the open land later
without a fresh decision." It does exactly that today. Same shape for
`pending_withdraw_nonce`, `pending_premium_*_nonce` and the rest.

Fixed for SetRedeemLimits in this pass (`require!(config.pending_redeem_limits_nonce ==
Some(nonce))`). The remaining handlers need the same one-line bind. `execute_set_public_mint` is
the urgent one, because opening the public mint is a launch step and its emergency close is
believed to disarm it.

This is NOT a finding from the three reviewers; it surfaced while implementing their A2. Worth
noting for the review-of-fixes: a fix can be the thing that reveals the real bug.

### [x] A6. Fee exemptions have no expiry and no rate limit
`FeeExemptAccount.reserved` was sized for an expiry that is not wired. Instant grant, no expiry,
no rate limit means a compromised admin self-exempts and runs the mint-side capture loop until a
human reads a `FeeExemptSet` event. Also quantified by the reviewer: a mint-exempt wallet has NO
budget at all (only the supply cap), so the entire remaining headroom (~34,335 oz, ~$2.0M) is
available at zero fee, capturing the DEX arb band from whoever provides SILV liquidity, likely
Dominion itself. Fix: wire the expiry, or accept and document with a monitoring requirement.

---

## B. Public app

### [x] B1. Every redemption at or above $5,000 is impossible from the UI
`anchor-client.ts:249` — `classifyRedeem` still returns `"queue"` on the dead
`largeRedeemThresholdUsdc` (still $5,000) and on budget exhaustion, and `MintRedeemCard.tsx:325`
then calls `buildRedeemQueuedTx`, which throws. The program would have settled instantly. The
"unreachable" claim in commit `5eb3d5f` is true of the Claim button and FALSE of the submit
path, which reads a live config value. Fix: delete the queue route entirely; classify as instant
or let the program reject.

### [x] B2. Client predicts on NET, program checks on GROSS
`classifyRedeem` and the solvency preview compare the user's leg against the budget and the
treasury balance; `redeem_silv` debits and requires the GROSS, because the treasury now pays
both legs. Understates by 1.5% at launch fees. Near either boundary the UI says "instant" and
the chain reverts with a raw code. Fix: compute gross, compare gross.

### [x] B3. "Max instant now" is capped at the dead threshold minus one
`computeMaxInstantRedeemableUsdc` clamps to `largeRedeemThresholdUsdc - 1`, so the site
advertises $4,999.99 against a $20,000 budget, and $0 if an operator ever zeroes the dead
field. Rendered by `ReservesPanel.tsx:48` and `MintRedeemCard.tsx:151`.

### [x] B4. Mint quote drifts from the new formula, and the drift scales with premium squared
`pyth.ts:35` quotes `amount / (spot * (1 + bps/1e4))`; the program computes
`floor((amount - ceil(amount * bps/1e4)) / spot)`. The user receives exactly `bps^2/1e8` less
than quoted: 1 bp at 1%, 25 bp at the 500 bps ceiling. The slippage selector's minimum is
10 bps, so **above ~317 bps mint premium every mint reverts `SlippageExceeded`**. The premium is
24h-timelock changeable, so this is one executed proposal away from breaking mint. Also: the fee
is still presented as a marked-up price rather than the explicit off-the-top fee now charged.

### [x] B5. Three new error codes are mapped by no client
`RedeemLimitExceeded` (12103), `KycRequired` (12104), `InsufficientFeeVault` (12108). The user
gets `Simulation reverted: {"InstructionError":[5,{"Custom":12103}]}` plus raw program logs. The
program's own message is actionable and none of it reaches the user. Also remove the dead
`MustUseQueue` (12061) mapping and the copy it feeds.

### [x] B6. Two removed instructions are still called by shipped code
`buildClaimRedemptionTx` calls `.claimRedemption()` and `buildCloseSettledRedemptionTx` calls
`.closeSettledRedemption()`. Both are `undefined` on `program.methods` under the current IDL, so
the failure is a bare `TypeError`, not the explained error the other stubs give. The latter is
wired to a live onClick. Commit `5eb3d5f` claimed `claimRedemption` was "removed or stubbed";
it was neither. Correct that claim when fixing.

### [x] B7. The reachable half of the queued UI tells the user things that are false
`MintRedeemCard.tsx`: "This amount is above the instant limit -> T+3 QUEUE" (`:687`), the button
label "Queue redemption (T+3)" (`:802`), "Re-submit: it will route to the T+3 queue" (`:463`),
and the whole retry loop with its `nextRedeemRequestNonce` and `redeemQueueDelaySeconds` reads
and its nonce-race machinery guarding a burn that can no longer happen. Unreachable (gated on an
always-empty list): the pending and settled tables, Claim, handleCloseSettled, the IOU copy.

### [x] B8. The config type never declares `kycScopeFlags`
So if the gate is armed on redeem, the UI reports "instant" while every transaction reverts with
a raw `Custom:12104`. The public config interface also still declares the three dead fields as
live.

### [x] B9. Two apps derive the same three new PDAs from two different sources of truth
`apps/public` hardcodes the seed strings inline and its `SEEDS` still carries the dead
`redeemRequest`; `apps/admin` reads them from `SEEDS`. No gate compares them.

### [x] B10. The tests assert nothing about the account lists
`lazer-tx.test.ts` builds its own ix with 17 hand-written keys and never calls
`buildLazerMintTx` or `buildLazerRedeemTx`. `buildLazerMintTx` could lose `feeVault` tomorrow and
all 13 tests would still pass. This is the only mechanical guard available for an `as any` money
path. Assert: key count, name-to-index mapping, `fee_exempt === programId` when absent, and
`fee_vault === getAssociatedTokenAddressSync(USDC, feeVaultPda(), true)`.

---

## C. Admin app

### [x] C1. `fetchFeeVaultBalance` has zero call sites
Added specifically to surface the null-vault deploy blocker, and the panel never computes it.
No balance metric, no "vault missing" banner, no way for an operator to check the precondition
before executing the redemptions open. The only trace is prose in a tooltip.

### [x] C2. Dead config fields displayed as live metrics with false tips
`Dashboard.tsx:293-297,325-329` — "Any single redemption worth this much or more is
automatically sent to the delayed queue" and "How long a queued redemption must wait". Both
false, and they sit immediately above the panel that correctly says the queue was deleted. Two
contradictory answers on one screen, and the wrong one renders as live state.

### [x] C3. The panel still offers threshold and queue-delay inputs
Both write to config and change nothing on chain, BUT `largeRedeemThresholdUsdc` is exactly what
the public app's `classifyRedeem` reads, so an operator "tightening the threshold to $500" moves
the B1 cliff to $500 with no indication the effect is entirely client-side. Also `:137-145`
still offers "Set redemptions on/off" as a bool whose `true` reverts `RedemptionsEnableBlocked`
(unmapped), while the real open lives in a separate card.

### [x] C4. Dead code left behind
`fetchAllRedemptionRequests_DELETED` (still containing the `redemptionRequest.all()` call),
`statusKind`, `RedemptionStatusKind`, `RedemptionRequestView`, `StatusPill`, and in the public
app `statusKind` and `isQueuedNonceRaceError`. Plus the pre-Lazer legacy `buildMintTx` /
`buildRedeemTx` with a `priceUpdate` account that no longer exists: exported, unused, and a live
footgun for anyone grepping for a mint builder.

---

## D. Scripts and docs

### [x] D1. The on-chain E2E proof script reverts for a reason unrelated to the program
`scripts/e2e-lazer-mint.ts` omits `feeVaultPda`, `feeVault`, `feeExempt`, `kyc`. Because
`.accounts()` is NOT strict in Anchor 0.31.1 (it delegates to `accountsPartial`), the resolver
DERIVES the `fee_exempt` and `kyc` PDAs and passes real addresses instead of the program id. The
program then runs `Account::try_from` on an uninitialised account and reverts
`AccountNotInitialized`. The deploy checklist treats this script as the evidence that the priced
mint works.

### [x] D2. The mainnet-readiness gate hard-fails on a requirement this batch satisfied
`scripts/verify-mainnet-readiness.ts:191-194` records "kyc_enforced is read by ZERO
instructions: this needs a PROGRAM UPGRADE" as BLOCKED, and any blocked item exits 1 with
"Do NOT start the ceremony". `kyc_scope_flags` is now read by both mint and redeem. Line 197 on
redeem is also now false.

### [x] D3. The runbook denies capabilities the program now has, and omits the fee vault
`docs/MAINNET_LAUNCH_RUNBOOK.md:50,298` still say enabling KYC needs a program upgrade. Nothing
in the runbook or `private/DEPLOY_CHECKLIST.md` mentions the fee vault, the whitelist, or
`withdraw_fees`. The fee vault is a hard prerequisite: runbook step 10 opens the public mint, and
then every mint reverts `AccountNotInitialized`.

### [x] D4. `scripts/create-fee-vault.ts` cannot run on mainnet
`requireDevnet` throws unless the operator happens to know to set
`DOMINION_ALLOW_MAINNET=i-understand`. It is a mandatory mainnet step. Needs an explicit,
documented mainnet path.

### [x] D5. Named deploy-gate scripts call removed instructions
`test-v2-lifecycle.ts` calls `redeemSilvQueued`, `claimRedemption`,
`adminSettleRedemptionOffchain` and fetches `redemptionRequest`: it throws.
`test-v2-devnet.ts:222` asserts `redeemQueueDelaySeconds === 0`, which the ceiling validator
refuses. `t1-hostile-bootstrap.ts:359` asserts on the dead delay: it passes, but it is a false
assurance. `private/DEPLOY_CHECKLIST.md` names these as gates.

### [x] D6. No CI gate catches client-vs-IDL drift
The existing gate checks IDL byte-identity and address consistency but nothing cross-references
the instruction names, account names and error codes the clients use against the IDL. A short
script walking every `.methods.<name>(` and `.accounts({` key in both apps against the committed
IDL would have caught D1, B6 and D5 mechanically. This is the single highest-leverage item on
the list, because it prevents the whole class rather than these instances.

### [x] D7. Stale comment
`apps/public/src/lib/anchor-client.ts` claims "mainnet init value: 60s" for `max_staleness`,
which `MAX_STALENESS_CEILING_SECONDS = 30` makes impossible.

---

## Notes for the review-of-fixes

Two premises were WRONG in my original commits and must not be reintroduced:

1. **`.accounts()` is not strict in Anchor 0.31.1.** It delegates to `accountsPartial()`. There
   is no client-side safety net on account lists. This is why D6 matters.
2. **The "dead" config fields are still decoded and carry real values.** Leaving them declared
   was correct for offset stability, but the clients read them, so "dead" only means "no
   on-chain instruction reads them".

---

## Second triple review, P2/P3 closure (2026-08-06)

The P0s and P1s of the second review closed on 2026-08-05. These are the rest, all closed now.
Where the honest close was "record it" rather than "fix it", that is stated as such.

### [x] E1. Batch A, program side (commit 440d20f)
Closed in that commit. Listed here so this file is the single index.

### [x] E2. `resolveWalletFlags` swallowed RPC failure and returned "no exemption"
A failed RPC read is not the same fact as "this wallet has no exemption", but the resolver returned
the same value for both, so a flaky endpoint silently quoted a fee-exempt wallet the full premium.
It now THROWS, and the transaction builders call `resolveWalletFlagsOrDefault`, which is the one
place allowed to choose a fallback. The SWR call site surfaces the error instead of hiding it.

### [x] E3. `pyth-posting.ts` was dead
Deleted. Nothing imported it.

### [x] E4. The `"kyc"` route named no contact, and two routes let the user submit anyway
The route copy now names `OTC_EMAIL`, and the submit button is disabled for `"limit"` and `"kyc"`
instead of letting the user pay for a transaction the program will revert.

### [x] E5. Admin: the withdraw-amount label did not say which panel it belonged to
Relabelled to point at the fee-vault panel. The fee-routing card also sat under the KYC section
header, which read as though routing were part of the KYC gate. Moved out.

### [x] E6. The admin app asserted nothing about its account lists
`apps/admin/src/lib/__tests__/account-parity.test.ts`, 5 tests. Mutation-verified: deleting
`usdcTreasury` from the list makes it fail. A gate that cannot fail is not a gate.

### [x] E7. The readiness gate reproduced the exact failure it had just fixed (D2)
It exited 1 with "Do NOT start the ceremony" on five BLOCKED items, four of which can ONLY be
resolved during that ceremony (both apps' `USDC_MINT`, `LAZER_TREASURY`, the mainnet fee vault).
Split into BLOCKING (cannot be fixed by any runbook step) versus AT STEP (expected red, re-run
after). Now: 17 ready / 4 at step / 9 by hand / **1 BLOCKING**, the unfunded deployer wallet.
Exit code verified DIRECTLY (`>/dev/null; echo $?`) rather than through a pipe, because the earlier
reading of `exit=$?` had captured `tail`'s status, not the script's.

### [x] E8. RECORDED, NOT FIXED: `isOnCurve` is necessary but not sufficient
`PublicKey.isOnCurve` failing proves only that 32 bytes are not a valid ed25519 point, which every
PDA of every program satisfies, including one an attacker controls. Nothing in the gate checks that
the account is a Squads vault, that its multisig exists, or what its threshold is. Reading a Squads
multisig properly is a real integration, not an assertion, so the gate now labels these lines as a
shape check and says to verify the multisig by hand in the Squads UI.

### [x] E9. RECORDED, NOT FIXED: the parity gate validates against a generated, gitignored artifact
It reads `target/idl/...json`. Nothing derives that from `programs/**`. Change a Rust account list,
skip `anchor idl build`, and all three copies still agree, both gates go green, and both apps are
broken. What actually closes it is CI job ORDER: "Regenerate the IDL" runs BEFORE the gate and a
separate step diffs the regenerated IDL against both committed copies, so on CI the artifact is
always fresh. Locally it is only as fresh as your last build. Documented at the top of the script.

### [x] E10. A stale second IDL artifact carried a RETIRED program id
`target/idl/dominion_silver_mint_v2.json`, dated 10 June, `address` =
`GDN5ktEm88MjuTXpcWStUPjSKQmbNxJiK1XknvNaWAzX`. Deleted. The live artifact is
`dominion_silver_mint.json` at `6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh`, and the parity gate
still exits 0 after the deletion, which confirms it was reading the right one all along.

### [x] E11. `private/` docs sent auditors after scripts deleted in 42a502f
Only the three INSTRUCTIONAL docs got a banner naming the replacements that exist today
(`AUDIT_BRIEF.md`, `CODEX_FULLSTACK_AUDIT_GUIDE.md`, `FABLE_FULLSTACK_AUDIT_BRIEF.md`). The
historical reports (`BATTLE_TEST_REPORT.md`, the `CODEX_*_REPORT`s, `SESSION_STATE.md`,
`SAFETY_DOSSIER.md`, `LAUNCH_BUILD_BATCH1_2026_07.md`) keep their original text: they record what
was run on a given date, and editing them would falsify a record rather than fix a bug.

### [x] E12. Unused bindings
`isLoading` in `Dashboard` (the FeeVault one IS used, kept), the orphaned comment above the
guardians SWR describing a deleted redemptions SWR, and `redeemUsdcOutBn` in `MintRedeemCard`.
The last one needed a decision rather than a delete: the memo produced both `gross` and `net`, and
once the dead binding went, `net` was dead too. Kept the float `preview` path as the displayed
"You receive (est.)" and reduced the memo to `redeemGross`, which is what every limit comparison
must use. `redeemUsdcOut` stays exported and is still exercised by `contract-parity.test.ts`.

### [x] E13. The next-steps doc still carried my refuted 1.5x window bound
`docs/NEXT_STEPS_2026_08_05.md` told a future reader to size `instant_redeem_budget_usdc` against a
1.5x worst case. The real supremum is just under **2x**. Left uncorrected it would have caused a
budget to be set at 1.33x the intended outflow. Corrected, with the derivation and the practical
rule: to cap a true 24h outflow at $X, set the budget to $X/2.
