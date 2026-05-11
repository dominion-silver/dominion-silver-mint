/**
 * Anchor client wrapper.
 * Provides typed access to the Dominion Silver mint/redeem program.
 *
 * Anchor 0.31 supports IDL-driven auto-resolution of PDAs and ATAs, so
 * we only pass the accounts that cannot be derived (user wallet, mints,
 * price_update). The resolver fills config, daily, hourly, user_usdc_ata,
 * user_silv_ata, silv_mint_authority, treasury_pda, usdc_treasury, and
 * the token/system programs from IDL seed metadata.
 *
 * Usage:
 *   const tx = await buildMintTx(connection, wallet, { amountUsdc, minSilvOut, priceUpdate });
 *   await wallet.sendTransaction(tx, connection);
 */
import { AnchorProvider, Program, BN, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl/dominion_silver_mint.json";
import {
  USDC_MINT,
  SILV_MINT,
  PYTH_XAG_USD_FEED_ID,
  CU_LIMIT,
} from "./constants";
import {
  configPda,
  treasuryPda,
  currentDayEpoch,
  currentHourEpoch,
} from "./pdas";

// ---- types ----

// Mirror state/config.rs. Keep in sync if the Rust struct changes.
export interface ConfigAccount {
  admin: PublicKey;
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  pythFeedId: number[];
  usdcMint: PublicKey;
  silvMint: PublicKey;
  treasury: PublicKey;
  pythReceiver: PublicKey;
  paused: boolean;
  mintPausedUntil: BN;
  mintCapPerTx: BN;
  redeemCapPerTx: BN;
  dailyMintCap: BN;
  dailyRedeemCap: BN;
  hourlyRedeemCap: BN;
  treasuryMinReserveBps: number;
  adminTimelockSeconds: BN;
  reserveCheckPriceScaled: BN;
  lastPriceScaled: BN;
  guardianCount: number;
  version: number;
}

// ---- provider / program ----

export function getAnchorProvider(
  connection: Connection,
  wallet: WalletContextState,
): AnchorProvider {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  const anchorWallet = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction.bind(wallet),
    signAllTransactions: wallet.signAllTransactions!.bind(wallet),
  };
  return new AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export function getProgram(
  connection: Connection,
  wallet: WalletContextState,
): Program {
  const provider = getAnchorProvider(connection, wallet);
  return new Program(idl as Idl, provider);
}

// Read-only provider for fetches that do not require a wallet.
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

// ---- read helpers ----

export async function fetchConfig(
  connection: Connection,
): Promise<ConfigAccount | null> {
  const program = getReadOnlyProgram(connection);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc = await (program.account as any).configAccount.fetchNullable(
      configPda(),
    );
    return acc as ConfigAccount | null;
  } catch (e) {
    console.error("fetchConfig error", e);
    return null;
  }
}

export async function fetchTreasuryBalance(connection: Connection): Promise<BN> {
  const treasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
  try {
    const info = await connection.getTokenAccountBalance(treasuryAta);
    return new BN(info.value.amount);
  } catch {
    return new BN(0);
  }
}

/**
 * Total circulating SILV (raw u64 with 6 decimals). Reads the Token-2022 mint supply.
 */
export async function fetchSilvSupply(connection: Connection): Promise<BN> {
  try {
    const info = await connection.getTokenSupply(SILV_MINT);
    return new BN(info.value.amount);
  } catch {
    return new BN(0);
  }
}

/**
 * Compute max redeemable SILV from on-chain treasury and config.
 *   reserve_required = total_silv * price / 1e6 * reserveBps / 10_000
 *   spendable = treasury_usdc - reserve_required
 *   max_silv = spendable * 1e6 / effective_redeem_price
 */
export function computeMaxRedeemable(
  treasuryBalanceUsdc: BN,
  totalSilvSupply: BN,
  cfg: Pick<ConfigAccount, "treasuryMinReserveBps" | "premiumBpsRedeem">,
  silverPriceScaled: BN,
): BN {
  const PRICE_DECIMALS = new BN(10).pow(new BN(6));
  const BPS_DENOM = new BN(10_000);
  const reserveBps = new BN(cfg.treasuryMinReserveBps);

  const totalUsdcValue = totalSilvSupply
    .mul(silverPriceScaled)
    .div(PRICE_DECIMALS);
  const reserveRequired = totalUsdcValue.mul(reserveBps).div(BPS_DENOM);

  const spendable = treasuryBalanceUsdc.sub(reserveRequired);
  if (spendable.ltn(0)) return new BN(0);

  const redeemMult = BPS_DENOM.sub(new BN(cfg.premiumBpsRedeem));
  const effectiveRedeemPrice = silverPriceScaled.mul(redeemMult).div(BPS_DENOM);

  return spendable.mul(PRICE_DECIMALS).div(effectiveRedeemPrice);
}

// ---- transaction builders ----

export interface BuildMintTxArgs {
  amountUsdc: BN; // 6 decimals (atomic USDC units)
  minSilvOut: BN; // 6 decimals (atomic SILV units; matches on-chain Token-2022 mint config)
  priceUpdate: PublicKey; // posted Pyth PriceUpdateV2 account
}

export async function buildMintTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildMintTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;
  const dayEpoch = currentDayEpoch();

  // Pre-compute every account ourselves. Anchor 0.31's IDL resolver doesn't
  // reliably resolve cross-PDA-derived accounts (e.g. usdc_treasury depends
  // on treasury_pda which itself is a PDA), and silently fails as
  // "Account `usdcTreasury` not provided".
  const cfgPda = configPda();
  const trPda = treasuryPda();
  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    trPda,
    true, // allowOwnerOffCurve = true (PDA can't be on the curve)
    TOKEN_PROGRAM_ID,
  );
  const userUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    user,
    false,
    TOKEN_PROGRAM_ID,
  );
  const userSilvAta = getAssociatedTokenAddressSync(
    SILV_MINT,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  // daily PDA: seeds = [b"daily", day_epoch_le_u32]
  const dayBuf = Buffer.alloc(4);
  dayBuf.writeUInt32LE(dayEpoch, 0);
  const [dailyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily"), dayBuf],
    program.programId,
  );
  const [silvMintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("silv_mint_authority")],
    program.programId,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .mintSilv(args.amountUsdc, args.minSilvOut, dayEpoch)
    .accounts({
      config: cfgPda,
      daily: dailyPda,
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      silvMintAuthority: silvMintAuthorityPda,
      priceUpdate: args.priceUpdate,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Pre-create the user's SILV ATA (token-2022) and USDC ATA idempotently.
  // Anchor won't auto-create these; init_if_needed is disabled on this program.
  // userSilvAta + userUsdcAta were already computed above for the .accounts() call.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userSilvAta,
      user,
      SILV_MINT,
      TOKEN_2022_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      USDC_MINT,
      TOKEN_PROGRAM_ID,
    ),
    ix,
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  return tx;
}

export interface BuildRedeemTxArgs {
  amountSilv: BN; // 6 decimals (atomic SILV units)
  minUsdcOut: BN; // 6 decimals (atomic USDC units)
  priceUpdate: PublicKey;
}

export async function buildRedeemTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildRedeemTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;
  const dayEpoch = currentDayEpoch();
  const hourEpoch = currentHourEpoch();

  // Pre-compute every account explicitly (same reasons as buildMintTx).
  const cfgPda = configPda();
  const trPda = treasuryPda();
  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    trPda,
    true,
    TOKEN_PROGRAM_ID,
  );
  const userUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    user,
    false,
    TOKEN_PROGRAM_ID,
  );
  const userSilvAta = getAssociatedTokenAddressSync(
    SILV_MINT,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const dayBuf = Buffer.alloc(4);
  dayBuf.writeUInt32LE(dayEpoch, 0);
  const [dailyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily"), dayBuf],
    program.programId,
  );
  const hourBuf = Buffer.alloc(4);
  hourBuf.writeUInt32LE(hourEpoch, 0);
  const [hourlyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("hourly"), hourBuf],
    program.programId,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut, dayEpoch, hourEpoch)
    .accounts({
      config: cfgPda,
      daily: dailyPda,
      hourly: hourlyPda,
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      treasuryPda: trPda,
      priceUpdate: args.priceUpdate,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdcAta,
      user,
      USDC_MINT,
      TOKEN_PROGRAM_ID,
    ),
    ix,
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  return tx;
}

// ---- parsing ----

export function parseUsdcAmount(input: string): BN {
  // USDC has 6 decimals
  const [whole = "0", frac = ""] = input.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return new BN(whole).mul(new BN(1_000_000)).add(new BN(fracPadded || "0"));
}

export function parseSilvAmount(input: string): BN {
  // SILV has 6 decimals (matches math.rs assumption + on-chain mint).
  const [whole = "0", frac = ""] = input.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return new BN(whole).mul(new BN(1_000_000)).add(new BN(fracPadded || "0"));
}

