// Dominion Silver Mint/Redeem - Attack test suite.
//
// Covers the 55-attack matrix from PLAN.md §11.4, plus invariants and happy paths.
// Runs against a local validator with mock Pyth + mock USDC (classic SPL) + SILV Token-2022.
//
// Structure:
//   - Section 1: Setup helpers (mint mock USDC, mint mock Pyth update, deploy program, initialize config)
//   - Section 2: Happy path (mint + redeem + deposit)
//   - Section 3: Oracle attacks (#1-9)
//   - Section 4: Account confusion (#10-14)
//   - Section 5: Timelock + propose semantics (#15, 51-52)
//   - Section 6: Auth (#16-17)
//   - Section 7: Bounds + overflow (#18-20)
//   - Section 8: Rounding (#21)
//   - Section 9: Treasury invariants (#22-23)
//   - Section 10: Pause (#24-27)
//   - Section 11: Day/hour (#28-31, 54)
//   - Section 12: Admin transfer (#32-34)
//   - Section 13: Premium bounds (#35-36)
//   - Section 14: Timelock bounds (#37-38)
//   - Section 15: Slippage (#39-40)
//   - Section 16: Token-2022 extensions (#41, 45, 55)
//   - Section 17: Flash-loan-ish scenarios (#42)
//   - Section 18: Brick reversibility (#43-44)
//   - Section 19: New v0.4 attacks (#51-55)

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  getAssociatedTokenAddressSync,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  getMintLen,
  TYPE_SIZE,
  LENGTH_SIZE,
} from "@solana/spl-token";
import { assert, expect } from "chai";
// Note: DominionSilverMint types will come from target/types after `anchor build`.
// For now this file uses `any` types as placeholders.

// ============================================================================
// Setup helpers
// ============================================================================

const SEEDS = {
  config: Buffer.from("config"),
  treasury: Buffer.from("treasury"),
  silvMintAuthority: Buffer.from("silv_mint_authority"),
  silvMetadataAuthority: Buffer.from("silv_metadata_authority"),
  daily: Buffer.from("daily"),
  hourly: Buffer.from("hourly"),
  timelock: Buffer.from("timelock"),
  guardian: Buffer.from("guardian"),
};

const PYTH_XAG_USD_FEED_ID = Buffer.from(
  "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
  "hex"
);

// Mock Pyth receiver program (devnet). Replace at test time.
const MOCK_PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

interface TestCtx {
  program: Program<any>;
  provider: anchor.AnchorProvider;
  connection: anchor.web3.Connection;
  deployer: Keypair;
  adminSquadsMock: Keypair; // stand-in for Squads vault PDA
  upgradeSquadsMock: Keypair;
  opsVaultPda: PublicKey; // the PermanentDelegate pubkey
  usdcMint: PublicKey;
  silvMint: PublicKey;
  treasuryPda: PublicKey;
  treasuryAta: PublicKey;
  configPda: PublicKey;
  silvMintAuthorityPda: PublicKey;
  user: Keypair;
  pythPriceUpdate: PublicKey; // mock Pyth account
}

async function setupTestCtx(): Promise<TestCtx> {
  // TODO: implement once IDL is available.
  throw new Error("setup not yet implemented; requires anchor build + mock Pyth");
}

function deriveConfigPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([SEEDS.config], programId)[0];
}

function deriveTreasuryPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([SEEDS.treasury], programId)[0];
}

function deriveSilvMintAuthorityPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([SEEDS.silvMintAuthority], programId)[0];
}

function deriveDailyPda(programId: PublicKey, dayEpoch: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(dayEpoch, 0);
  return PublicKey.findProgramAddressSync([SEEDS.daily, buf], programId)[0];
}

function deriveHourlyPda(programId: PublicKey, hourEpoch: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(hourEpoch, 0);
  return PublicKey.findProgramAddressSync([SEEDS.hourly, buf], programId)[0];
}

function deriveTimelockPda(programId: PublicKey, nonce: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(nonce, 0);
  return PublicKey.findProgramAddressSync([SEEDS.timelock, buf], programId)[0];
}

function deriveGuardianPda(programId: PublicKey, guardian: PublicKey) {
  return PublicKey.findProgramAddressSync([SEEDS.guardian, guardian.toBuffer()], programId)[0];
}

function currentDayEpoch() {
  return Math.floor(Date.now() / 1000 / 86400);
}

function currentHourEpoch() {
  return Math.floor(Date.now() / 1000 / 3600);
}

async function expectAnchorError(promise: Promise<any>, errorName: string) {
  try {
    await promise;
    assert.fail(`Expected AnchorError ${errorName} but tx succeeded`);
  } catch (err: any) {
    if (err instanceof AnchorError) {
      assert.equal(err.error.errorCode.code, errorName);
    } else if (err.error?.errorCode?.code) {
      assert.equal(err.error.errorCode.code, errorName);
    } else {
      // Re-throw non-Anchor errors so we see them clearly.
      throw err;
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("dominion_silver_mint", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.DominionSilverMint as Program<any>;

  let ctx: TestCtx;

  before(async () => {
    // ctx = await setupTestCtx();
    // Commented until IDL is available.
  });

  // ==========================================================================
  // Section 2: Happy path
  // ==========================================================================

  describe("happy path", () => {
    it.skip("initialize sets config fields + creates treasury ATA", async () => {
      // TODO
    });

    it.skip("mint_silv 100 USDC gets ~3.03 SILV at oracle $30 + 10% premium", async () => {
      // TODO
    });

    it.skip("redeem_silv 3 SILV gets ~$87.30 USDC at oracle $30 - 2% redeem fee", async () => {
      // TODO
    });

    it.skip("deposit_usdc refills treasury + emits TreasuryDeposit with actual delta", async () => {
      // TODO
    });
  });

  // ==========================================================================
  // Section 3: Oracle attacks (#1-9)
  // ==========================================================================

  describe("oracle attacks", () => {
    it.skip("#1 stale Pyth price (t-600s) reverts with StaleOracle", async () => {
      // Craft mock Pyth update with publish_time = now - 600s.
      // Expected: mint_silv reverts with StaleOracle.
    });

    it.skip("#2 Pyth confidence > max_confidence_bps reverts with OracleLowConfidence", async () => {
      // conf=50e9 on price=30e9 with max_confidence_bps=100 -> rejects
    });

    it.skip("#3 Pyth price = 0 reverts with NegativeOraclePrice", async () => {});

    it.skip("#4 Pyth price < 0 (negative i64) reverts with NegativeOraclePrice", async () => {
      // Test the sign check before u128 cast.
    });

    it.skip("#5 Pyth price = i64::MAX reverts with PriceOutOfBounds", async () => {});

    it.skip("#6 wrong feed (BTC/USD) reverts via get_price_no_older_than", async () => {
      // Craft Pyth update with different feed_id; expect atomic check fails.
    });

    it.skip("#7 attacker-owned PriceUpdateV2 reverts on Anchor owner constraint", async () => {
      // Create an account with the right byte layout but owner = attacker.
    });

    it.skip("#8 Pyth VerificationLevel::Partial reverts with OracleNotFullyVerified", async () => {});

    it.skip("#9 Pyth exponent = -25 (combined_exp = -16) exceeds bound, reverts with OracleScalingOutOfBounds", async () => {});
  });

  // ==========================================================================
  // Section 4: Account confusion (#10-14)
  // ==========================================================================

  describe("account confusion", () => {
    it.skip("#10 wrong USDC mint reverts with WrongMint", async () => {});
    it.skip("#11 attacker's fake SILV mint reverts with WrongMint", async () => {});
    it.skip("#12 attacker's fake treasury reverts with WrongTreasury", async () => {});
    it.skip("#13 Token-2022 program passed as classic reverts with WrongTokenProgram", async () => {});
    it.skip("#14 classic Token program passed as Token-2022 reverts with WrongTokenProgram", async () => {});
  });

  // ==========================================================================
  // Section 5: Timelock + propose semantics (#15, 51-52)
  // ==========================================================================

  describe("timelock + propose", () => {
    it.skip("#15 execute_set_premium_mint before timelock elapsed reverts with TimelockNotElapsed", async () => {});

    it.skip("#51 propose_set_premium_mint when pending_premium_mint_nonce already Some reverts with ProposalAlreadyActive", async () => {});

    it.skip("#52 propose_set_premium_mint(current_value) (no-op) reverts with ProposalNoOp", async () => {});

    it.skip("propose when active_proposal_count >= 10 reverts with TooManyActiveProposals", async () => {});

    it.skip("execute_* re-validates args against current config at execute time", async () => {
      // Propose set_premium_mint(2000); between propose and execute, bump set_premium_redeem
      // such that combined spread goes below floor 500; execute should revert.
    });

    it.skip("cancel_timelocked_action admin-only path works", async () => {});
    it.skip("cancel_timelocked_action guardian-only path works", async () => {});

    it.skip("cancel of premium_mint proposal clears mint_paused_until", async () => {});

    it.skip("cancel closes TimelockQueueAccount + returns rent to proposer", async () => {});
  });

  // ==========================================================================
  // Section 6: Auth (#16-17)
  // ==========================================================================

  describe("auth", () => {
    it.skip("#16 admin-only ix called by guardian reverts with Unauthorized", async () => {});
    it.skip("#17 unpause called by guardian reverts with Unauthorized", async () => {});
  });

  // ==========================================================================
  // Section 7: Bounds + overflow (#18-20)
  // ==========================================================================

  describe("bounds + overflow", () => {
    it.skip("#18 mint amount = 0 reverts with ZeroAmount or BelowMinimum", async () => {});
    it.skip("#19 mint amount = u64::MAX reverts with AboveMaximum", async () => {});
    it.skip("#20 mint amount × price overflowing u64 reverts with ArithmeticOverflow", async () => {});
  });

  // ==========================================================================
  // Section 8: Rounding (#21)
  // ==========================================================================

  describe("rounding", () => {
    it.skip("#21 rounding loop: 10^6 mint-redeem cycles preserves invariant 5 (treasury >= reserve)", async () => {
      // Tight loop at min tx size. Assert final treasury - initial_deposit >= 0.
    });

    it.skip("mint-then-redeem roundtrip at same price: protocol gains spread, user loses spread", async () => {
      // Verify math ceiling direction.
    });
  });

  // ==========================================================================
  // Section 9: Treasury invariants (#22-23)
  // ==========================================================================

  describe("treasury invariants", () => {
    it.skip("#22 redeem > treasury reverts with InsufficientTreasury", async () => {});
    it.skip("#23 redeem that would breach min-reserve reverts with TreasuryBelowReserve", async () => {});
    it.skip("execute_withdraw_usdc that would breach min-reserve reverts", async () => {});
  });

  // ==========================================================================
  // Section 10: Pause (#24-27)
  // ==========================================================================

  describe("pause", () => {
    it.skip("#24 mint while paused reverts with Paused", async () => {});
    it.skip("#25 redeem while paused reverts with Paused", async () => {});
    it.skip("#26 execute_withdraw_usdc while paused reverts with WithdrawBlockedWhilePaused", async () => {});
    it.skip("#27 pause-to-exit: pause → propose_withdraw → wait 24h → execute reverts", async () => {});

    it.skip("mint while now < mint_paused_until reverts with MintPaused", async () => {});
    it.skip("deposit_usdc while paused reverts with Paused", async () => {});
  });

  // ==========================================================================
  // Section 11: Day/hour (#28-31, 54)
  // ==========================================================================

  describe("day/hour", () => {
    it.skip("#28 cross-day cap boundary: first succeeds, over-cap fails", async () => {});
    it.skip("#29 UTC midnight counter reset: new DailyCountersAccount, counter at 0", async () => {});
    it.skip("#30 wrong day_epoch (tomorrow's) reverts with DayEpochMismatch", async () => {});
    it.skip("#31 hourly redeem cap exceeded reverts with HourlyRedeemCapExceeded", async () => {});
    it.skip("#54 tiny mint ($100, below dust filter $1k) does NOT update last_recorded_price", async () => {
      // Verify D38 dust filter.
    });

    it.skip("hour-boundary double-dip attempt: snapshot bounded by prev_hour - prev_redeemed", async () => {
      // Pass prev_hour account in remaining_accounts. Verify snapshot capped.
    });
  });

  // ==========================================================================
  // Section 12: Admin transfer (#32-34)
  // ==========================================================================

  describe("admin transfer", () => {
    it.skip("#32 double-accept admin transfer reverts with InvalidPendingAdmin", async () => {});
    it.skip("#33 expired pending_admin reverts with PendingAdminExpired", async () => {});
    it.skip("propose_admin_transfer while one pending reverts with ProposalAlreadyActive", async () => {});
    it.skip("propose_admin_transfer to Pubkey::default reverts", async () => {});
    it.skip("propose_admin_transfer to current admin reverts with ProposalNoOp", async () => {});
  });

  // ==========================================================================
  // Section 13: Premium bounds (#35-36)
  // ==========================================================================

  describe("premium bounds", () => {
    it.skip("#35 set premium combined < 500 bps reverts with PremiumSpreadTooLow", async () => {});
    it.skip("#36 set premium > 3000 bps reverts with PremiumTooHigh", async () => {});
  });

  // ==========================================================================
  // Section 14: Timelock bounds (#37-38)
  // ==========================================================================

  describe("timelock bounds", () => {
    it.skip("#37 set_admin_timelock < 3600s reverts with TimelockTooShort", async () => {});
    it.skip("#38 set_admin_timelock > 30d reverts with TimelockTooLong", async () => {});
  });

  // ==========================================================================
  // Section 15: Slippage (#39-40)
  // ==========================================================================

  describe("slippage", () => {
    it.skip("#39 mint with min_silv_out > actual reverts with SlippageExceeded", async () => {});
    it.skip("#40 redeem with min_usdc_out > actual reverts with SlippageExceeded", async () => {});
  });

  // ==========================================================================
  // Section 16: Token-2022 extensions (#41, 45, 55)
  // ==========================================================================

  describe("token-2022 extensions", () => {
    it.skip("#41 burn SILV user doesn't have reverts (Token-2022 native)", async () => {});
    it.skip("#45 SILV mint with wrong PermanentDelegate reverts with PermanentDelegateMismatch", async () => {
      // Create a SILV mint with a different PermanentDelegate than config.permanent_delegate_expected.
    });
    it.skip("#55 add 4th guardian when max=3 reverts with GuardianCountExceeded", async () => {});
    it.skip("re-add guardian within 1h cooldown reverts with GuardianInCooldown", async () => {});
    it.skip("SILV mint with TransferHook enabled reverts with TransferHookUnexpected", async () => {});
    it.skip("SILV mint with TransferFee enabled reverts with TransferFeeUnexpected", async () => {});
  });

  // ==========================================================================
  // Section 17: Economic scenarios (#42)
  // ==========================================================================

  describe("economic scenarios", () => {
    it.skip("#42 simulate flash-loan-mint-dump-redeem: individually reverts as expected", async () => {
      // Orchestrate: borrow USDC (mock), mint SILV, redeem SILV; verify net loss to attacker > 0.
    });
  });

  // ==========================================================================
  // Section 18: Brick reversibility (#43-44)
  // ==========================================================================

  describe("brick reversibility", () => {
    it.skip("#43 set_daily_cap(0) bricks but is reversible by admin", async () => {});
    it.skip("#44 metadata URI change without timelock reverts with TimelockNotElapsed", async () => {});
  });

  // ==========================================================================
  // Section 19: v0.4 additions
  // ==========================================================================

  describe("v0.4 additions", () => {
    it.skip("price-delta circuit breaker rejects mint if current price differs > 500 bps from last", async () => {});
    it.skip("price-delta decay: after 1h of no updates, accepts new price + re-anchors", async () => {});
    it.skip("reserve_check_price slow-tracks oracle: max 10%/hr upward, instant downward", async () => {});
    it.skip("execute_withdraw_usdc refreshes reserve_check_price from live Pyth", async () => {});
    it.skip("execute_set_pyth_feed atomically pauses", async () => {});
    it.skip("execute_set_compliance_mode atomically pauses (M4)", async () => {});
    it.skip("thaw_account recovers user frozen during compliance-ON", async () => {});

    it.skip("close_daily_counter after 30-day retention returns rent to original payer", async () => {});
    it.skip("close_hourly_counter after 48h retention returns rent", async () => {});
    it.skip("close_timelock_account after execute/cancel returns rent", async () => {});
  });

  // ==========================================================================
  // Helpers
  // ==========================================================================

  it("placeholder: program loads", async () => {
    assert.isDefined(program.programId);
  });
});

// ============================================================================
// Notes for implementation
// ============================================================================
//
// Before filling in the TODOs, need:
// 1. `anchor build` to succeed (unblocks IDL generation at target/idl/ + target/types/).
// 2. Import `DominionSilverMint` type from `../target/types/dominion_silver_mint`.
// 3. Replace `any` with typed Program<DominionSilverMint>.
// 4. Mock Pyth update account creator: writes PriceUpdateV2-compatible account data
//    owned by MOCK_PYTH_RECEIVER program. Needed for oracle attacks.
// 5. Mock classic USDC mint creator: pick a test authority, mint to users for setup.
// 6. Mock SILV Token-2022 mint creator with PermanentDelegate + MetadataPointer + TokenMetadata.
// 7. Time-warp utility: push local validator clock forward (for timelock/day/hour tests).
//    Alternative: use LiteSVM with `set_sysvar` capability.
//
// Suggested test runner: `anchor test` uses mocha via ts-mocha. For faster iteration
// during development, use `LiteSVM` (from anchor-litesvm).
//
// Target: all skipped tests (it.skip → it) once env is ready.
// Coverage target: 55+ tests per PLAN.md §11.4 table.
