# Triple-review punch list, 2026-08-05 batch

Source: three parallel reviewers (correctness, security, integration) over commits `98c0435`,
`5eb3d5f`, `8af4baa`. The two program P0s were fixed in `7db6e73`.

Working rule for this pass: fix ONE item, run the relevant tests, tick it, move on. Do not
batch unrelated edits into one commit, because a review-of-fixes has to be able to attribute a
regression to a single change.

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

### [ ] A3. The window is fixed, not rolling: the documented ceiling is 2x understated
`instant_window_start` re-anchors to `now` only on the first redemption after expiry. Drain the
remaining budget at `window_end - 1`, then drain the full budget again one slot later:
**2 x budget in ~one second**. At defaults that is $40k, not $20k, and it scales linearly with
any budget raise for market-maker flow. Both `config.rs` and `redeem_silv.rs` call it "rolling".
Fix: either implement a genuine sliding window, or clamp the burst, or rename it honestly to
"fixed window" everywhere and document the 2x. Cheapest honest option is the rename plus a
carry-forward clamp.

### [ ] A4. The redeem premium leg bypasses `treasury_min_float_usdc`
`execute_withdraw_usdc` enforces `treasury_post >= treasury_min_float_usdc`. The redeem premium
leg (`treasury -> fee_vault`) enforces nothing, and once in the vault it is withdrawable
instantly. So the float is not the floor the panel and the docs present: 1.5% of every
redemption routes around it. The panel tooltip already warns the operator; the program does not
enforce it. Fix: gate `withdraw_fees` on `usdc_treasury.amount >= config.treasury_min_float_usdc`
(cheapest, keeps the redeem path untouched), or debit the float on the premium leg.

### [ ] A5. No escape hatch if the fee vault becomes unusable
USDC carries a Circle freeze authority. A frozen fee-vault ATA permanently bricks mint and
redeem for every non-exempt wallet, recoverable only by a program upgrade: the vault cannot be
closed and there is no config field to point the premium elsewhere. Exempt wallets keep working,
which makes the failure asymmetric and confusing to diagnose. Low likelihood, unbounded blast
radius, zero on-chain remedy.
Fix options: route the premium to the treasury when the vault transfer fails, or add a
`fee_routing_enabled` flag that falls back to the old in-treasury behaviour.

### [ ] A7. NEW, found while fixing A2: no `execute_*` handler is bound to its config nonce
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

### [ ] A6. Fee exemptions have no expiry and no rate limit
`FeeExemptAccount.reserved` was sized for an expiry that is not wired. Instant grant, no expiry,
no rate limit means a compromised admin self-exempts and runs the mint-side capture loop until a
human reads a `FeeExemptSet` event. Also quantified by the reviewer: a mint-exempt wallet has NO
budget at all (only the supply cap), so the entire remaining headroom (~34,335 oz, ~$2.0M) is
available at zero fee, capturing the DEX arb band from whoever provides SILV liquidity, likely
Dominion itself. Fix: wire the expiry, or accept and document with a monitoring requirement.

---

## B. Public app

### [ ] B1. Every redemption at or above $5,000 is impossible from the UI
`anchor-client.ts:249` — `classifyRedeem` still returns `"queue"` on the dead
`largeRedeemThresholdUsdc` (still $5,000) and on budget exhaustion, and `MintRedeemCard.tsx:325`
then calls `buildRedeemQueuedTx`, which throws. The program would have settled instantly. The
"unreachable" claim in commit `5eb3d5f` is true of the Claim button and FALSE of the submit
path, which reads a live config value. Fix: delete the queue route entirely; classify as instant
or let the program reject.

### [ ] B2. Client predicts on NET, program checks on GROSS
`classifyRedeem` and the solvency preview compare the user's leg against the budget and the
treasury balance; `redeem_silv` debits and requires the GROSS, because the treasury now pays
both legs. Understates by 1.5% at launch fees. Near either boundary the UI says "instant" and
the chain reverts with a raw code. Fix: compute gross, compare gross.

### [ ] B3. "Max instant now" is capped at the dead threshold minus one
`computeMaxInstantRedeemableUsdc` clamps to `largeRedeemThresholdUsdc - 1`, so the site
advertises $4,999.99 against a $20,000 budget, and $0 if an operator ever zeroes the dead
field. Rendered by `ReservesPanel.tsx:48` and `MintRedeemCard.tsx:151`.

### [ ] B4. Mint quote drifts from the new formula, and the drift scales with premium squared
`pyth.ts:35` quotes `amount / (spot * (1 + bps/1e4))`; the program computes
`floor((amount - ceil(amount * bps/1e4)) / spot)`. The user receives exactly `bps^2/1e8` less
than quoted: 1 bp at 1%, 25 bp at the 500 bps ceiling. The slippage selector's minimum is
10 bps, so **above ~317 bps mint premium every mint reverts `SlippageExceeded`**. The premium is
24h-timelock changeable, so this is one executed proposal away from breaking mint. Also: the fee
is still presented as a marked-up price rather than the explicit off-the-top fee now charged.

### [ ] B5. Three new error codes are mapped by no client
`RedeemLimitExceeded` (12103), `KycRequired` (12104), `InsufficientFeeVault` (12108). The user
gets `Simulation reverted: {"InstructionError":[5,{"Custom":12103}]}` plus raw program logs. The
program's own message is actionable and none of it reaches the user. Also remove the dead
`MustUseQueue` (12061) mapping and the copy it feeds.

### [ ] B6. Two removed instructions are still called by shipped code
`buildClaimRedemptionTx` calls `.claimRedemption()` and `buildCloseSettledRedemptionTx` calls
`.closeSettledRedemption()`. Both are `undefined` on `program.methods` under the current IDL, so
the failure is a bare `TypeError`, not the explained error the other stubs give. The latter is
wired to a live onClick. Commit `5eb3d5f` claimed `claimRedemption` was "removed or stubbed";
it was neither. Correct that claim when fixing.

### [ ] B7. The reachable half of the queued UI tells the user things that are false
`MintRedeemCard.tsx`: "This amount is above the instant limit -> T+3 QUEUE" (`:687`), the button
label "Queue redemption (T+3)" (`:802`), "Re-submit: it will route to the T+3 queue" (`:463`),
and the whole retry loop with its `nextRedeemRequestNonce` and `redeemQueueDelaySeconds` reads
and its nonce-race machinery guarding a burn that can no longer happen. Unreachable (gated on an
always-empty list): the pending and settled tables, Claim, handleCloseSettled, the IOU copy.

### [ ] B8. The config type never declares `kycScopeFlags`
So if the gate is armed on redeem, the UI reports "instant" while every transaction reverts with
a raw `Custom:12104`. The public config interface also still declares the three dead fields as
live.

### [ ] B9. Two apps derive the same three new PDAs from two different sources of truth
`apps/public` hardcodes the seed strings inline and its `SEEDS` still carries the dead
`redeemRequest`; `apps/admin` reads them from `SEEDS`. No gate compares them.

### [ ] B10. The tests assert nothing about the account lists
`lazer-tx.test.ts` builds its own ix with 17 hand-written keys and never calls
`buildLazerMintTx` or `buildLazerRedeemTx`. `buildLazerMintTx` could lose `feeVault` tomorrow and
all 13 tests would still pass. This is the only mechanical guard available for an `as any` money
path. Assert: key count, name-to-index mapping, `fee_exempt === programId` when absent, and
`fee_vault === getAssociatedTokenAddressSync(USDC, feeVaultPda(), true)`.

---

## C. Admin app

### [ ] C1. `fetchFeeVaultBalance` has zero call sites
Added specifically to surface the null-vault deploy blocker, and the panel never computes it.
No balance metric, no "vault missing" banner, no way for an operator to check the precondition
before executing the redemptions open. The only trace is prose in a tooltip.

### [ ] C2. Dead config fields displayed as live metrics with false tips
`Dashboard.tsx:293-297,325-329` — "Any single redemption worth this much or more is
automatically sent to the delayed queue" and "How long a queued redemption must wait". Both
false, and they sit immediately above the panel that correctly says the queue was deleted. Two
contradictory answers on one screen, and the wrong one renders as live state.

### [ ] C3. The panel still offers threshold and queue-delay inputs
Both write to config and change nothing on chain, BUT `largeRedeemThresholdUsdc` is exactly what
the public app's `classifyRedeem` reads, so an operator "tightening the threshold to $500" moves
the B1 cliff to $500 with no indication the effect is entirely client-side. Also `:137-145`
still offers "Set redemptions on/off" as a bool whose `true` reverts `RedemptionsEnableBlocked`
(unmapped), while the real open lives in a separate card.

### [ ] C4. Dead code left behind
`fetchAllRedemptionRequests_DELETED` (still containing the `redemptionRequest.all()` call),
`statusKind`, `RedemptionStatusKind`, `RedemptionRequestView`, `StatusPill`, and in the public
app `statusKind` and `isQueuedNonceRaceError`. Plus the pre-Lazer legacy `buildMintTx` /
`buildRedeemTx` with a `priceUpdate` account that no longer exists: exported, unused, and a live
footgun for anyone grepping for a mint builder.

---

## D. Scripts and docs

### [ ] D1. The on-chain E2E proof script reverts for a reason unrelated to the program
`scripts/e2e-lazer-mint.ts` omits `feeVaultPda`, `feeVault`, `feeExempt`, `kyc`. Because
`.accounts()` is NOT strict in Anchor 0.31.1 (it delegates to `accountsPartial`), the resolver
DERIVES the `fee_exempt` and `kyc` PDAs and passes real addresses instead of the program id. The
program then runs `Account::try_from` on an uninitialised account and reverts
`AccountNotInitialized`. The deploy checklist treats this script as the evidence that the priced
mint works.

### [ ] D2. The mainnet-readiness gate hard-fails on a requirement this batch satisfied
`scripts/verify-mainnet-readiness.ts:191-194` records "kyc_enforced is read by ZERO
instructions: this needs a PROGRAM UPGRADE" as BLOCKED, and any blocked item exits 1 with
"Do NOT start the ceremony". `kyc_scope_flags` is now read by both mint and redeem. Line 197 on
redeem is also now false.

### [ ] D3. The runbook denies capabilities the program now has, and omits the fee vault
`docs/MAINNET_LAUNCH_RUNBOOK.md:50,298` still say enabling KYC needs a program upgrade. Nothing
in the runbook or `private/DEPLOY_CHECKLIST.md` mentions the fee vault, the whitelist, or
`withdraw_fees`. The fee vault is a hard prerequisite: runbook step 10 opens the public mint, and
then every mint reverts `AccountNotInitialized`.

### [ ] D4. `scripts/create-fee-vault.ts` cannot run on mainnet
`requireDevnet` throws unless the operator happens to know to set
`DOMINION_ALLOW_MAINNET=i-understand`. It is a mandatory mainnet step. Needs an explicit,
documented mainnet path.

### [ ] D5. Named deploy-gate scripts call removed instructions
`test-v2-lifecycle.ts` calls `redeemSilvQueued`, `claimRedemption`,
`adminSettleRedemptionOffchain` and fetches `redemptionRequest`: it throws.
`test-v2-devnet.ts:222` asserts `redeemQueueDelaySeconds === 0`, which the ceiling validator
refuses. `t1-hostile-bootstrap.ts:359` asserts on the dead delay: it passes, but it is a false
assurance. `private/DEPLOY_CHECKLIST.md` names these as gates.

### [ ] D6. No CI gate catches client-vs-IDL drift
The existing gate checks IDL byte-identity and address consistency but nothing cross-references
the instruction names, account names and error codes the clients use against the IDL. A short
script walking every `.methods.<name>(` and `.accounts({` key in both apps against the committed
IDL would have caught D1, B6 and D5 mechanically. This is the single highest-leverage item on
the list, because it prevents the whole class rather than these instances.

### [ ] D7. Stale comment
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
