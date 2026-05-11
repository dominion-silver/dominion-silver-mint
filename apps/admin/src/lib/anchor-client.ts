/**
 * Admin anchor client.
 * Read-only helpers for the Dominion Silver dashboard. Transaction construction
 * for admin actions routes through the Squads multisig proposer (see squads.ts).
 */
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./idl/dominion_silver_mint.json";
import { PROGRAM_ID, USDC_MINT, SILV_MINT, SEEDS } from "./constants";

/**
 * Mirror programs/dominion_silver_mint/src/state/config.rs ConfigAccount.
 *
 * CODEX 2nd-pass M-03: previous version had wrong field names (mintCapPerTx,
 * redeemCapPerTx, dailyMintCap, hourlyRedeemCap) which don't exist on chain.
 * Anchor returned 0/undefined for them. Now uses the actual snake_case_to_camelCase
 * names from the IDL.
 */
export interface ConfigAccount {
  admin: PublicKey;
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  pythFeedId: number[];
  usdcMint: PublicKey;
  silvMint: PublicKey;
  treasury: PublicKey;
  pythReceiverProgram: PublicKey;
  paused: boolean;
  mintPausedUntil: BN;
  // Caps
  minMintAmountUsdc: BN;
  maxMintAmountPerTxUsdc: BN;
  minRedeemAmountUsdc: BN;
  maxRedeemAmountPerTxUsdc: BN;
  dailyMintCapUsdc: BN;
  dailyRedeemCapUsdc: BN;
  hourlyRedeemCapBpsOfSnapshot: number;
  // Reserve + governance
  treasuryMinReserveBps: number;
  adminTimelockSeconds: number;
  reserveCheckPriceScaled: BN;
  lastRecordedPriceScaled: BN;
  lastPriceUpdateAt: BN;
  guardianCount: number;
  activeProposalCount: number;
  version: number;
}

export interface DashboardSnapshot {
  cfg: ConfigAccount;
  treasuryUsdc: BN;
  silvSupply: BN;
  // Derived:
  reserveRatioBps: number | null; // null if supply == 0
}

function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.config)], PROGRAM_ID)[0];
}

function treasuryPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.treasury)], PROGRAM_ID)[0];
}

function getReadOnlyProgram(connection: Connection): Program {
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: PublicKey.default,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    } as never,
    { commitment: "confirmed" },
  );
  return new Program(idl as Idl, provider);
}

/**
 * Snapshot fetch: config + treasury USDC + SILV supply in parallel.
 * Returns null if config not yet initialized.
 */
export async function fetchDashboardSnapshot(
  connection: Connection,
): Promise<DashboardSnapshot | null> {
  const program = getReadOnlyProgram(connection);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await (program.account as any).configAccount.fetchNullable(configPda());
  if (!cfg) return null;

  const treasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );

  const [balanceInfo, supplyInfo] = await Promise.allSettled([
    connection.getTokenAccountBalance(treasuryAta),
    connection.getTokenSupply(SILV_MINT),
  ]);

  const treasuryUsdc =
    balanceInfo.status === "fulfilled" ? new BN(balanceInfo.value.value.amount) : new BN(0);
  const silvSupply =
    supplyInfo.status === "fulfilled" ? new BN(supplyInfo.value.value.amount) : new BN(0);

  // CODEX 2nd-pass M-03: corrected decimal scales.
  //   SILV supply: 6 decimals (was incorrectly using 9 in this admin app).
  //   Price scale: 1e9 in oracle.rs::PRICE_SCALE (was incorrectly using 1e6 here).
  //   USDC: 6 decimals (correct).
  //
  // reserveRatioBps = treasuryUsdc_atoms / (silvSupply_atoms * priceScaled / 1e9) * 10_000
  //   numerator: treasuryUsdc with 6 decimals
  //   denominator: silvSupply (6dec) * priceScaled (1e9) / 1e9 = expected USDC backing in atomic 6-dec units.
  let reserveRatioBps: number | null = null;
  if (!silvSupply.isZero() && !cfg.reserveCheckPriceScaled.isZero()) {
    const PRICE_SCALE = new BN(10).pow(new BN(9)); // matches oracle.rs PRICE_SCALE
    const expectedBacking = silvSupply.mul(cfg.reserveCheckPriceScaled).div(PRICE_SCALE);
    if (!expectedBacking.isZero()) {
      reserveRatioBps = treasuryUsdc.mul(new BN(10_000)).div(expectedBacking).toNumber();
    }
  }

  return {
    cfg: cfg as ConfigAccount,
    treasuryUsdc,
    silvSupply,
    reserveRatioBps,
  };
}

/**
 * Convert a raw u64 BN (6 decimals) into a display-ready USD string.
 */
export function formatUsdc(raw: BN): string {
  const dollars = raw.div(new BN(1_000_000)).toNumber();
  return dollars.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Convert a raw u64 BN (6 decimals) into a display-ready SILV count string.
 * CODEX 2nd-pass M-03: was 9 decimals, corrected to 6 (matches on-chain Token-2022 mint).
 */
export function formatSilv(raw: BN): string {
  // Use float division to preserve fractional SILV.
  const silv = raw.toNumber() / 1_000_000;
  return silv.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Format a scaled price (1e9 = oracle.rs PRICE_SCALE) into "$/oz" display.
 * CODEX 2nd-pass M-03: was 1e6, corrected to 1e9 (matches on-chain oracle).
 */
export function formatPrice(scaled: BN): string {
  return (scaled.toNumber() / 1_000_000_000).toFixed(4);
}
