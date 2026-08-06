# Next steps, paused 2026-08-05

State at pause: working tree CLEAN, **24 commits local and NOT pushed**, punch list 28/28 closed,
second triple review closed (P0/P1 on 2026-08-05, P2/P3 on 2026-08-06).

Verification that passes right now, re-runnable at any time:

```bash
cargo test --lib                              # 141 pass
cargo build-sbf -- --locked                   # clean, no stack-frame overflow
npx tsx scripts/verify-client-idl-parity.ts   # PARITY OK, exit 0
bash scripts/verify-constants-consistency.sh  # CONSTANTS OK
npx tsx scripts/verify-mainnet-readiness.ts   # 17 ready / 4 at step / 9 by hand / 1 BLOCKING, exit 1
cd apps/admin && npx vitest run && npm run build   # 22 pass
cd apps/public && npx vitest run && npm run build  # 33 pass
```

The readiness gate exits **1 on purpose** and will keep doing so until the mainnet deployer wallet
holds the ~6 SOL of rent for the bytecode. That is its only remaining BLOCKING item. The four
"at step" items (both apps' `USDC_MINT`, `LAZER_TREASURY`, the mainnet fee vault) can only be
satisfied DURING the ceremony, so they are supposed to be red beforehand and must be re-run after.

Note `anchor build` is BROKEN in this repo. Use `cargo build-sbf -- --locked`, and run
`anchor idl build -- --locked` from inside `programs/dominion_silver_mint_v2`, redirecting stdout.
See the memory note `anchor-build-needs-locked`.

---

## 1. Retry the three-reviewer fan-out. THE REAL GAP.

Highest priority, because it is the one thing that did not happen. All three agents died on API
529 Overloaded, repeatedly, including after relaunch. The review was done MANUALLY instead, which
found three real bugs but is not equivalent: it was me re-reading my own code with my own blind
spots, and this pass produced two false comments and two wrong tests, so those blind spots are
demonstrably there.

The briefs are worth reusing verbatim. Their three angles:

- **Regressions**: did any fix break what it was fixing, or break something else? Emphasis on the
  A2/A7 nonce bind (can a legitimate propose-wait-execute still complete for all eleven actions?)
  and the A3 sliding window (can it ratchet shut?).
- **New logic, adversarially**: the sliding window's real bound, the `fee_routing` escape hatch,
  the exemption expiry, the three `withdraw_fees` gates, and whether the nonce bind creates a new
  denial of service.
- **Client integration**: did the rewrites introduce new drift? Includes auditing the NEW parity
  gate itself for false negatives, and the `classifyRedeem` route/copy mapping.

What I already checked myself, so the reviewers can skip or double-check rather than start cold:
all eleven bound nonces ARE set by a propose handler; `cancel_timelocked_action` reads no config
nonce so nothing becomes uncancellable; the limiter does not ratchet shut (300 redemptions at 50%
utilisation, zero refused); `fee_routing_disabled` arithmetic is correct on both sides; the float
gate cannot strand revenue permanently (two exits).

## 2. Deploy to devnet and run the E2E.

Deliberately deferred until after the review, so as not to spend ~6 SOL of bytecode that the
reviewers might invalidate.

Order matters:

1. Upgrade the devnet program `6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh` in place.
   The `ConfigAccount` layout is compatible: both new fields were carved from `reserved` and
   declared after `version`, and `SIZE` is still 800. Nothing needs a realloc.
2. Confirm the fee vault still exists: `npx tsx scripts/create-fee-vault.ts` (idempotent).
   Devnet vault is `9BYFMUWarXeuy9ejNVsV63M2t63xFJyUUbhFoutxB7b7`.
3. **CHECK `fee_routing_disabled` after the upgrade.** It should decode FALSE (routing ON) from the
   zeroed `reserved` byte. That is the whole point of the polarity inversion, so verify the
   inversion actually landed rather than assuming it.
4. `npx tsx scripts/e2e-lazer-mint.ts` for the priced mint. It now passes the four new accounts;
   before the fix it reverted `AccountNotInitialized` on the derived `fee_exempt` PDA.
   Verify the SPLIT on chain: treasury receives net, fee vault receives the premium.
5. Whitelist E2E: `set_fee_exempt` with a mint-only scope AND a real expiry, then mint and confirm
   `fee_usdc == 0` and `premium_bps_used == 0` in the event.
6. Redeem needs `redemptions_enabled = true`, which is a 24h timelocked action:
   `propose_set_redeem_limits({ redemptionsEnabled: true })`, wait, then execute. Start the clock
   early. The treasury also needs USDC (`deposit_usdc`) and a non-zero
   `treasury_min_float_usdc` before the redeem path means anything.

## 3. Push (only when asked).

17 commits. Pushing redeploys both Vercel apps.

---

## Decisions still owed to Mark, from the 2026-08-05 scope

- **Whitelist scope per wallet.** The recommendation is MINT-ONLY. A both-sides exemption trades at
  exact spot each way, which hands that wallet a free option on oracle movement paid by the
  treasury. The security reviewer quantified the mint-only residual too: a mint-exempt wallet has
  no budget at all, only the supply cap, so the remaining ~$2.0M of headroom is available at zero
  fee and captures the DEX arbitrage band from whoever provides SILV liquidity, likely Dominion.
  Grant it alongside a liquidity plan, not as an open-ended favour, and always with an expiry.
- **The redeem delay.** Thomas said 7 days, Mark said he wants "the t+3 brought to zero eventually".
  Moot for now: redemption is instant and `redeem_queue_delay_seconds` is dead on chain. Worth
  closing the loop with Mark so nobody is working from the old model.
- **KYC scope when armed.** Redeem-only (`flags = 2`) is the likely first step, keeping public mint
  open so DEX arbitrage still works.
- **Mark's KYC provider must produce three things**: the wallet address, a hash of the provider's
  record id, and A SIGNATURE PROVING THE PERSON CONTROLS THAT WALLET. The third is the one
  everyone forgets and without it the gate is decorative. Never put PII on chain, not even hashed.

## Open items NOT from the punch list

- **`treasury_min_float_usdc` is still 0.** Cosmetic while redeem is closed. Becomes a hard
  blocker before opening it, and more so now that premium revenue no longer accumulates in the
  treasury to cushion it.
- **GitHub branch protection** making the CI `gate` job a required check. Needs Thomas's admin
  rights; never done.
- **The sliding window's 2x bound** is documented, not eliminated. Size
  `instant_redeem_budget_usdc` knowing the worst-case alignment allows just under **2x** the budget
  inside one trailing window, NOT the 1.5x this line claimed until 2026-08-06. 1.5x came from
  evaluating only the midpoint alignment (`into = w/2`); the supremum is at `into -> w`, where the
  previous window's contribution tends to its full value while the current window is already fully
  spent. Test: `two_spends_one_second_short_of_a_window_reach_almost_2x` in `redeem_window.rs`.
  Practical consequence: to cap a true 24h outflow at $X, set the budget to **$X/2**, not $X/1.5.
- **Before deploying the upgrade, check for a live `SetRedeemLimits` proposal on each cluster and
  cancel it.** `RedeemLimitsArgs` gained a borsh field, so a proposal queued under the old layout
  cannot execute (it is still cancellable).
