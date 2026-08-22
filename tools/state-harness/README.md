# On-chain state harness

The 158 Rust unit tests all call PURE FUNCTIONS in `src/state/`. None of them can
see a handler that computed the right value and never persisted it. Mutation
testing measured 192 handler-level mutations (a dropped Anchor `mut`, a deleted
`has_one`, a deleted `validate_*` call, an inverted derived field) that each left
all 158 tests AND every repo gate green. This suite loads the real `.so` into
litesvm, sends real transactions, and reads the accounts back to assert FIELD
VALUES ON CHAIN, which is the only thing that catches that class.

It loads `target/deploy/dominion_silver_mint.so`, the DEFAULT-feature artifact
that ships: nothing here needs `probe_oracle_price`, so these tests exercise the
exact bytes that go to mainnet. `run.sh` asserts that artifact is probe-free and
dev-hatch-free before running.

## Run

```bash
./tools/state-harness/run.sh              # build default-feature .so, scan it, run
./tools/state-harness/run.sh --no-build    # test an artifact already at target/deploy
./tools/state-harness/run.sh attest_incr   # trailing args filter by TEST FUNCTION name, not by file
                                           # a filter matching nothing now FAILS rather than printing OK
```

Manually (the toolchain matters: `rust-toolchain.toml` pins 1.89 but the machine
default is 1.85, and litesvm 0.7 needs >= 1.86):

```bash
cargo +1.89.0 test --manifest-path tools/state-harness/Cargo.toml
```

## Coverage

`tests/kyc.rs` covers all 26 measured KYC mutations: each one was applied, the
`.so` rebuilt, and at least one test confirmed RED. `tests/common/mod.rs` holds
the fixture (`initialize` through the program's own instruction, not a
hand-crafted ConfigAccount), the account decoders, and `expect_error`, which
asserts a SPECIFIC error code: Anchor deserializes every account before
evaluating any constraint, so a test that accepts any error passes for the wrong
reason.
