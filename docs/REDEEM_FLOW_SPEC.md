# Redeem and fee-routing specification

Status: SPEC. Redeem design fixed by Thomas 2026-08-05. Fee routing has one open decision.
Supersedes: the D8/D9 dual-route design, and the 7-day queued draft of 2026-08-04.
Target: the single bundled program upgrade before the mainnet deploy.

## 1. Redeem: instant, three steps

```
1. The user redeems any amount. The only limit is current treasury solvency.
2. The user submits one transaction.
3. Their SILV is burned and they receive USDC from the treasury in the same transaction.
```

No queue, no delay, no escrow, no cancellation, no expiry, no size tiers. This is the whole
flow.

### What gets deleted

| Deleted | Why |
|---|---|
| `redeem_queued.rs` (455 lines) | No queue |
| `redeem_silv_queued`, `claim_redemption` | No queue |
| `admin_settle_redemption_offchain`, `close_settled_redemption` | No IOU to settle |
| `RedemptionRequest`, `RedemptionStatus` | No request state |
| `large_redeem_threshold_usdc` check | Thomas: no discrimination by amount |
| `redeem_queue_delay_seconds` | No delay |

Removing `admin_settle_redemption_offchain` removes **SolidProof MEDIUM #4** (the admin marks a
request settled with no on-chain proof, confiscating already-burned SILV) from the codebase
rather than justifying it in an audit response. That is the best security outcome of this
change and it should be stated in any audit follow-up.

### What gets kept, and why

The single global rolling budget (`instant_redeem_budget_usdc` over
`instant_redeem_window_seconds`) stays. Three reasons:

1. It is not the amount-based discrimination that was rejected. It is one global ceiling that
   applies identically to everyone, whatever the size of their redemption.
2. It is the only brake against the entire USDC treasury leaving in a single transaction. The
   oracle guards (staleness, minimum publishers, the `check_price_delta` circuit breaker) are
   the real defence against a manipulated price, but they are a filter, not a limiter. If they
   ever let a bad price through, an uncapped instant redeem converts that into a total drain
   with no human in the loop.
3. **It already exists**, in the program and in the admin panel. Keeping it is strictly less
   work than removing it.

The only change: exceeding the budget now REVERTS (`RedeemLimitExceeded`) instead of routing to
a queue, because there is no queue to route to.

### Enabling it

`set_redemptions_enabled(true)` is currently hard-blocked in the bytecode
(`require!(!enabled, RedemptionsEnableBlocked)`), which is the reason redeem at launch needs a
program upgrade at all. Enabling is a LOOSENING, so it moves behind the 24h propose/execute
timelock rather than becoming an instant setter. Disabling stays instant.

### Config fields that stop being read

`large_redeem_threshold_usdc` and `redeem_queue_delay_seconds` must STAY declared in
`ConfigAccount`, marked deprecated. Removing a field shifts every offset after it and forces a
realloc of every deployed config.

## 2. Fee routing

New requirement (Thomas, 2026-08-05): the premium collected on mint and redeem goes to a
separate destination, configurable from the admin panel.

This is not a cosmetic change, because the premium is currently baked into the price and the
two sides are asymmetric.

### Mint side: there is no fee to route today

The user pays `amount_usdc`, all of it goes to the treasury, and they receive
`floor(amount_usdc * 1e9 / (spot * 1.01))` in SILV. The fee exists as **under-issuance of
SILV**, not as a USDC amount sitting anywhere.

To route it, the incoming USDC must be split:

```
fee = ceil(amount_usdc * premium_bps / (10_000 + premium_bps))
net = amount_usdc - fee
silv_out = floor(net * 1e9 / spot)          // pure spot, no premium
```

`fee` goes to the fee destination, `net` to the treasury. CEIL on the fee, so the odd atomic
unit favours the protocol, matching the existing `ceil` on the effective mint price.

Worked check at 100 USDC, 1% premium, to confirm the user is unaffected:

| | Today | With routing |
|---|---|---|
| User receives | `100 / (spot * 1.01)` = `99.0099 / spot` SILV | `99.009901 / spot` SILV |
| Treasury receives | 100 USDC | 99.009901 USDC |
| Fee destination | nothing | 0.990099 USDC |

Same SILV to the user, to within one atomic unit. The difference is that the treasury is now
left holding exactly the backing instead of backing plus surplus.

### Redeem side: the treasury outflow increases

The user burns SILV worth `V` at spot and currently receives `V * 0.985`, with the `V * 0.015`
remaining in the treasury. With routing, the treasury pays out the **full** `V`, split:

```
gross    = amount_silv * spot / 1e9
fee      = gross * premium_bps / 10_000
to_user  = gross - fee
```

`to_user` goes to the user, `fee` to the fee destination, and the treasury pays `gross`.

Two consequences that must be handled:

- The solvency check must cover **both legs**: `treasury_balance >= gross`, not
  `>= to_user`. Checking only the user's leg lets the fee transfer overdraw.
- The treasury drains 1.5% faster per redemption than it does today.

### Net effect on the treasury

The treasury ends up holding exactly the spot-value backing of outstanding SILV, with all
premium revenue held elsewhere. That is an improvement: it resolves the problem that fee
revenue and redemption collateral are currently the same pot, so withdrawing revenue silently
reduces redemption capacity.

One thing it does not change: the pre-minted SILV was issued with no USDC paid in, so the USDC
treasury is a redemption buffer funded manually via `deposit_usdc`, not full on-chain backing.
The physical silver is the backing. Routing fees out does not alter that, it just stops the
buffer from quietly growing by 1% of mint volume.

### OPEN DECISION: vault plus sweep, or direct transfer

**Direct transfer** to `config.fee_wallet`'s USDC associated token account on every mint and
redeem is the literal reading of the requirement. It carries a serious failure mode: if that
ATA does not exist, or is later closed, **every mint and every redeem reverts**. One wrong
address in the admin panel bricks the product until it is corrected.

**Program-owned fee vault plus sweep** is the recommendation. Fees accumulate in a token
account owned by a `fee_vault` PDA, which cannot be closed and always exists after
initialisation. A separate admin instruction `withdraw_fees(destination, amount)` sweeps it out.
The configurable wallet becomes the sweep destination, so the admin panel requirement is met,
and a wrong address can no longer touch the user path. Identical economics.

If direct transfer is chosen anyway, then `set_fee_wallet` must verify the destination ATA
exists at set time, and it must be understood that the fee wallet's owner can brick mint and
redeem by closing that ATA.

## 3. Whitelist interaction

Per-side flags, so the admin panel can exempt the mint fee, the redeem fee, or both
(Thomas, 2026-08-05).

- Mint, exempt: `fee = 0`, all of `amount_usdc` goes to the treasury, `silv_out` computed at
  pure spot. No transfer to the fee destination.
- Redeem, exempt: `to_user = gross`, the treasury pays `gross` to the user and nothing to the
  fee destination.

Skip the fee CPI entirely when `fee == 0` rather than transferring zero.

## 4. Initialisation and the existing devnet program

If the fee vault is a PDA token account, it has to be created. `initialize` is a one-shot per
program id, and the live devnet program has already been initialised, so the vault cannot be
added to `initialize` alone.

Plan: create it in `initialize` for the fresh mainnet program id, and add a separate idempotent
`init_fee_vault` instruction so the already-initialised devnet program can be brought up to the
new layout without a fresh deploy.

## 5. Still open

1. Fee destination: vault plus sweep (recommended) or direct transfer.
2. Keep the single global rolling redeem budget (recommended) or remove it too.
3. Is the dormant KYC gate still in this upgrade? It was agreed on 2026-08-04 but is absent from
   the 2026-08-05 scope list.
4. Confirm both premium ceilings move to 5%.
