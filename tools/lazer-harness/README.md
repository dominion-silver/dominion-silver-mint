# Lazer oracle behavioral harness

This is the only test that
exercises the dominion Lazer oracle read path END TO END against a real (mock)
callee program: `dominion probe_oracle_price` -> `verify_and_get_payload`
(fund the fee-payer PDA, `invoke_signed` the Lazer `verify_message`, read +
parse the return data) -> mock Lazer -> dominion parser -> 5.4-5.6 policy.

## What it proves

- **The CPI chain works**: a fresh in-band print flows through the real
  `invoke_signed` + `get_return_data` + parser + policy and the normalized
  9-decimal price comes back via return-data.
- **Fee-payer isolation under a hostile callee**: the mock Lazer drains the
  fee-payer PDA's FULL balance (the maximum a malicious upgraded Lazer could
  take). The treasury gains EXACTLY the funded fee and the PDA ends at zero -
  the user wallet is never in the CPI account list, so it is structurally
  unreachable. Verified at fee = 0, 1, and the ceiling.
- **The fee corners**: fee = 0 (no transfer, still works), fee = ceiling
  (works), fee > ceiling (rejected, `LazerFeeTooHigh`).
- **The policy rejections**: carried-forward (`feed_ts != payload_ts`),
  too-few-publishers.

It also CAUGHT a real runtime subtlety: invoking the system program inside the
callee clears return-data, so `set_return_data` must be the callee's last op
(the real Lazer necessarily does the same).

## Run

```bash
./tools/lazer-harness/run.sh
```

The wrapper builds BOTH `.so` with the correct features, asserts the probe is
present in the harness build, runs the suite, then REBUILDS the default
(no-feature) dominion `.so` so `target/deploy/` is never left holding a
probe-contaminated "deploy" artifact. Run it manually only if you understand
that ordering:

```bash
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml --features test-harness
cargo build-sbf --manifest-path tools/mock-lazer/Cargo.toml
cargo +1.89.0 test --manifest-path tools/lazer-harness/Cargo.toml
# IMPORTANT: rebuild the default .so afterwards (a feature build overwrites the
# same target/deploy path). The deploy gate must grep for the PascalCase
# `ProbeOraclePrice` ix-name (the snake_case fn name is optimized out), NOT
# `probe_oracle_price`, when asserting the deploy .so is probe-free.
cargo build-sbf --manifest-path programs/dominion_silver_mint_v2/Cargo.toml
```

## Design notes

- The dominion `probe_oracle_price` instruction is gated behind the
  `test-harness` Cargo feature (NOT in `default`, like `dev-hatch`), so it is
  ABSENT from the deploy build + the generated IDL. It is read-only (returns the
  price via return-data, changes no state).
- `tools/mock-lazer` is a tiny native program implementing the `verify_message`
  CPI contract. It is a workspace member ONLY so it shares the SBF-parseable dep
  lock; it is never deployed (the deploy build targets `programs/...`).
- The harness does NOT depend on the dominion crate (its anchor/spl tree
  conflicts with litesvm on bytemuck_derive). The `ConfigAccount` is crafted by
  hand (sequential field append in struct order) and the constants are pinned
  literals; both are validated by the program actually deserializing + reading
  them at runtime.
