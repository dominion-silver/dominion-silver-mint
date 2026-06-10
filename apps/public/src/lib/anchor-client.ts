/**
 * Anchor client wrapper - V2 (Option B).
 *
 * Mint: pay USDC -> receive SILV at Pyth XAG/USD * (1 + premium_mint). Bounded
 *   by a HARD supply cap (no daily/reserve).
 * Redeem (§4.3): `redeem_silv` is the INSTANT path only. It reverts
 *   `MustUseQueue` (amount >= large threshold OR fixed-window budget
 *   exhausted) or `InsufficientTreasury` (treasury can't cover). The client
 *   pre-flights via config to predict the path and routes:
 *     - instant      -> buildRedeemTx (Pyth-priced, pays now)
 *     - queue (T+3)   -> buildRedeemQueuedTx (burns SILV now, NO Pyth)
 *     - OTC           -> InsufficientTreasury -> contact support
 *   Queued requests are later claimed via buildClaimRedemptionTx (Pyth-priced
 *   at claim time, D9).
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
import { USDC_MINT, SILV_MINT, CU_LIMIT } from "./constants";
import {
  configPda,
  treasuryPda,
  silvMintAuthorityPda,
  redemptionRequestPda,
} from "./pdas";

// ---- types (mirror programs/dominion_silver_mint_v2/src/state/config.rs) ----

export interface ConfigAccount {
  admin: PublicKey;
  permanentDelegateExpected: PublicKey;
  complianceMode: boolean;
  premiumBpsMint: number;
  premiumBpsRedeem: number;
  usdcMint: PublicKey;
  silvMint: PublicKey;
  usdcTreasury: PublicKey;
  maxStalenessSeconds: number;
  // Option B economic params:
  maxSilvSupply: BN;
  treasuryMinFloatUsdc: BN;
  redemptionsEnabled: boolean;
  largeRedeemThresholdUsdc: BN;
  instantRedeemBudgetUsdc: BN;
  instantRedeemWindowSeconds: number;
  redeemQueueDelaySeconds: number;
  instantWindowStart: BN;
  instantUsedUsdc: BN;
  nextRedeemRequestNonce: BN;
  paused: boolean;
  mintPausedUntil: BN;
  pendingPremiumMintNonce: BN | null;
  version: number;
}

export type RedemptionStatusKind = "pending" | "claimed" | "settledOffchain";

export interface RedemptionRequestView {
  pubkey: PublicKey;
  owner: PublicKey;
  amountSilv: BN;
  requestedAt: number;
  claimableAt: number;
  nonce: BN;
  status: RedemptionStatusKind;
}

export type RedeemRoute = "instant" | "queue" | "otc" | "disabled";

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
  return new Program(idl as Idl, getAnchorProvider(connection, wallet));
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

export async function fetchSilvSupply(connection: Connection): Promise<BN> {
  try {
    const info = await connection.getTokenSupply(SILV_MINT);
    return new BN(info.value.amount);
  } catch {
    return new BN(0);
  }
}

/**
 * Option B "what can I redeem RIGHT NOW, and how" preview (replaces the
 * Option A reserve formula). Mirrors redeem_silv.rs §4.3:
 *   - refresh window client-side (if expired, used = 0);
 *   - instantBudgetRemaining = max(0, budget - usedThisWindow);
 *   - a redeem of `usdcOut` is instant iff usdcOut < largeThreshold AND
 *     usdcOut <= instantBudgetRemaining AND usdcOut <= treasuryBalance.
 * Returns the max instantly-redeemable USDC. Everything above routes to the
 * T+3 queue (or OTC if the treasury can't cover a small one).
 */
export function computeMaxInstantRedeemableUsdc(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  nowUnixSecs: number,
): BN {
  if (!cfg.redemptionsEnabled) return new BN(0);
  const windowEnd =
    cfg.instantWindowStart.toNumber() + cfg.instantRedeemWindowSeconds;
  const windowExpired = nowUnixSecs >= windowEnd;
  const usedThisWindow = windowExpired ? new BN(0) : cfg.instantUsedUsdc;
  let budgetRemaining = cfg.instantRedeemBudgetUsdc.sub(usedThisWindow);
  if (budgetRemaining.ltn(0)) budgetRemaining = new BN(0);
  // instant-eligible ceiling = min(threshold-1, budgetRemaining, treasury).
  const thresholdCeil = cfg.largeRedeemThresholdUsdc.gtn(0)
    ? cfg.largeRedeemThresholdUsdc.sub(new BN(1))
    : new BN(0);
  let m = thresholdCeil;
  if (budgetRemaining.lt(m)) m = budgetRemaining;
  if (treasuryBalanceUsdc.lt(m)) m = treasuryBalanceUsdc;
  return m.ltn(0) ? new BN(0) : m;
}

/** Effective redeem price scaled 1e9: oracle * (1 - premiumRedeem/1e4). */
function effectiveRedeemPriceScaled(
  silverPriceScaled: BN,
  premiumBpsRedeem: number,
): BN {
  return silverPriceScaled
    .mul(new BN(10_000 - premiumBpsRedeem))
    .div(new BN(10_000));
}

/** usdc_out (6dec) = amount_silv * eff_redeem_price / 1e9 (floor). */
export function redeemUsdcOut(
  amountSilv: BN,
  silverPriceScaled: BN,
  premiumBpsRedeem: number,
): BN {
  const eff = effectiveRedeemPriceScaled(silverPriceScaled, premiumBpsRedeem);
  return amountSilv.mul(eff).div(new BN(10).pow(new BN(9)));
}

/**
 * Predict which redeem path a given amount will take, so the UI can tell the
 * user up-front. The on-chain program is the source of truth (it re-checks);
 * the client must still gracefully handle an on-send revert (parseRedeemError).
 */
export function classifyRedeem(
  cfg: ConfigAccount,
  treasuryBalanceUsdc: BN,
  usdcOut: BN,
  nowUnixSecs: number,
): RedeemRoute {
  if (cfg.paused || !cfg.redemptionsEnabled) return "disabled";
  if (usdcOut.gte(cfg.largeRedeemThresholdUsdc)) return "queue";
  const windowEnd =
    cfg.instantWindowStart.toNumber() + cfg.instantRedeemWindowSeconds;
  const used = nowUnixSecs >= windowEnd ? new BN(0) : cfg.instantUsedUsdc;
  if (used.add(usdcOut).gt(cfg.instantRedeemBudgetUsdc)) return "queue";
  if (treasuryBalanceUsdc.lt(usdcOut)) return "otc";
  return "instant";
}

/**
 * Map an on-chain revert (logs/message/structured err) to the user-facing
 * route. Matches BOTH the symbolic Anchor error name (present in program
 * logs) AND the numeric code (Anchor `Custom:<dec>` / `custom program
 * error: 0x<hex>` / `number:<dec>`). The numeric forms matter because when
 * `getTransaction` returns null right after inclusion (common RPC lag at
 * "confirmed"), the only signal left is the structured `value.err`
 * (`{InstructionError:[i,{Custom:<code>}]}`) - no symbolic name. Codes from
 * the IDL: InsufficientTreasury=12014/0x2eee, MustUseQueue=12061/0x2f1d,
 * RedemptionsDisabled=12060/0x2f1c, Paused=12000/0x2ee0.
 */
function anchorErr(t: string, name: string, codeDec: number): boolean {
  const hex = "0x" + codeDec.toString(16);
  return (
    new RegExp("\\b" + name + "\\b").test(t) ||
    new RegExp("custom program error:\\s*" + hex + "\\b", "i").test(t) ||
    new RegExp('\\bCustom"?\\s*[:=(]\\s*' + codeDec + "\\b").test(t) ||
    new RegExp("\\bnumber:" + codeDec + "\\b").test(t)
  );
}
export function parseRedeemError(errText: string): RedeemRoute | null {
  if (anchorErr(errText, "MustUseQueue", 12061)) return "queue";
  if (anchorErr(errText, "InsufficientTreasury", 12014)) return "otc";
  if (
    anchorErr(errText, "RedemptionsDisabled", 12060) ||
    anchorErr(errText, "Paused", 12000)
  )
    return "disabled";
  return null;
}

/**
 * StaleOracle = 12004 / 0x2ee4 (oracle.rs: get_price_no_older_than vs
 * config.max_staleness_seconds). Hit on ANY Pyth-priced path (mint,
 * redeem, claim) when too much wall-clock passes between posting the
 * Pyth price and the consumer tx landing. max_staleness is 15s on the
 * deployed devnet program (mainnet init value: 60s), so a human slow to
 * approve the two wallet popups trips it. Detect it so the UI shows a
 * clear "be faster / retry" message instead of the raw
 * `Simulation reverted: {...Custom:12004...}` dump.
 */
export function isStaleOracleError(errText: string): boolean {
  return anchorErr(errText, "StaleOracle", 12004);
}

/** Canonical user-facing copy for the StaleOracle case (single source). */
// Action-first so the guidance survives the toast preview slice
// (~120 chars): the user must "be faster", that is the actionable part.
export const STALE_ORACLE_USER_MESSAGE =
  "Please retry and approve both wallet prompts quickly. " +
  "The oracle price expired before the transaction could confirm " +
  "(too much time passed between the two wallet approvals).";

/**
 * Flatten an unknown error into one searchable string, INCLUDING program
 * logs. Solana `SendTransactionError` carries the human-readable Anchor lines
 * (`Program log: AnchorError ... Error Code: NonceMismatch ...`) in `.logs`,
 * not always in `.message`. A nonce-race detector that only reads `.message`
 * would miss the signal on the preflight-simulation-failure path.
 */
export function errorToText(e: unknown): string {
  if (e == null) return "";
  const parts: string[] = [];
  if (e instanceof Error) parts.push(e.message);
  else if (typeof e === "string") parts.push(e);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyE = e as any;
  if (anyE && typeof anyE === "object") {
    if (Array.isArray(anyE.logs)) parts.push(anyE.logs.join("\n"));
    if (anyE.error?.errorCode?.code)
      parts.push(String(anyE.error.errorCode.code));
    if (anyE.error?.errorCode?.number != null)
      parts.push(`number:${anyE.error.errorCode.number}`);
    if (anyE.transactionMessage) parts.push(String(anyE.transactionMessage));
    // confirmTransaction's `value.err` (and our attached `onChainErr`) is the
    // structured `{ InstructionError: [idx, { Custom: <code> }] }` shape.
    if (anyE.onChainErr != null) {
      try {
        parts.push(JSON.stringify(anyE.onChainErr));
      } catch {
        parts.push(String(anyE.onChainErr));
      }
    }
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(e));
    } catch {
      parts.push(String(e));
    }
  }
  return parts.join(" | ");
}

/**
 * Codex P2-02 race detector. The global `next_redeem_request_nonce` is shared
 * by all users; if another user's `redeem_silv_queued` lands between our
 * config read and our send, our `request_nonce` is stale.
 *
 * IMPORTANT (fund-safety): the ONLY safe retry signal is the contract's own
 * `NonceMismatch`. In `redeem_queued.rs` the `require!(request_nonce ==
 * config.next_redeem_request_nonce, NonceMismatch)` (lines 99-101) runs BEFORE
 * the SILV burn (line 112), and `config` is `&mut` so Solana write-lock-
 * serializes any two queued txs (a same-nonce `init` collision can't precede
 * the nonce check). So a NonceMismatch revert PROVABLY means nothing was
 * burned -> a fresh-nonce retry cannot double-burn. `NonceMismatch` is also
 * this program's own error-variant NAME, so it cannot collide with a generic
 * `0x0` / "already in use" string emitted by a DIFFERENT program or by a tx
 * that actually landed+burned (those broad matches were removed: they could
 * match a landed tx's downstream error and trigger a double-burn retry).
 *
 * The three patterns below are the three faithful encodings of the SAME
 * specific program error (Anchor code 12042 = 0x2f0a = `NonceMismatch`):
 *  - the symbolic NAME (program logs / AnchorError.message / errorCode.code),
 *  - the hex `custom program error: 0x2f0a` (SendTransactionError.message on
 *    the preflight-simulation-failure path, when `.logs` is not attached),
 *  - the numeric `Custom: 12042` (confirmTransaction's structured `value.err`
 *    / our attached `onChainErr`, and Anchor `errorCode.number`).
 * 12042 is in Anchor's user-error range and is THIS program's unique code,
 * so it cannot collide with a generic `0x0` from another program. All three
 * denote the pre-burn nonce-check revert, so a fresh-nonce retry is safe.
 */
export function isQueuedNonceRaceError(err: unknown): boolean {
  const t = errorToText(err);
  return (
    /\bNonceMismatch\b/.test(t) ||
    /custom program error:\s*0x2f0a\b/i.test(t) ||
    /\bCustom"?\s*[:=(]\s*12042\b/.test(t) ||
    /\bnumber:12042\b/.test(t)
  );
}

// ---- transaction builders ----

export interface BuildMintTxArgs {
  amountUsdc: BN;
  minSilvOut: BN;
  priceUpdate: PublicKey;
}

export async function buildMintTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildMintTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .mintSilv(args.amountUsdc, args.minSilvOut)
    .accounts({
      config: configPda(),
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      silvMintAuthority: silvMintAuthorityPda(),
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
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  return tx;
}

export interface BuildRedeemTxArgs {
  amountSilv: BN;
  minUsdcOut: BN;
  priceUpdate: PublicKey;
}

/** INSTANT redeem path (§4.3). Reverts MustUseQueue / InsufficientTreasury. */
export async function buildRedeemTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildRedeemTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .redeemSilv(args.amountSilv, args.minUsdcOut)
    .accounts({
      config: configPda(),
      user,
      usdcMint: USDC_MINT,
      silvMint: SILV_MINT,
      usdcTreasury: usdcTreasuryAta,
      userUsdcAta,
      userSilvAta,
      treasuryPda: treasuryPda(),
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

export interface BuildRedeemQueuedTxArgs {
  amountSilv: BN;
  /** read from config.nextRedeemRequestNonce immediately before building */
  requestNonce: BN;
}

/**
 * QUEUED redeem: burns SILV NOW, creates a RedemptionRequest PDA. No Pyth
 * (priced at claim, D9). No USDC moves now. Single wallet popup.
 */
export async function buildRedeemQueuedTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildRedeemQueuedTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const user = wallet.publicKey;

  const userSilvAta = getAssociatedTokenAddressSync(
    SILV_MINT,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const reqPda = redemptionRequestPda(
    user,
    BigInt(args.requestNonce.toString()),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .redeemSilvQueued(args.amountSilv, args.requestNonce)
    .accounts({
      config: configPda(),
      user,
      silvMint: SILV_MINT,
      userSilvAta,
      redemptionRequest: reqPda,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ix,
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  return tx;
}

export interface BuildClaimRedemptionTxArgs {
  request: RedemptionRequestView;
  priceUpdate: PublicKey;
}

/**
 * Claim a matured queued request. Priced at the CLAIM oracle (D9). Reverts
 * InsufficientTreasury if the treasury can't cover (request stays Pending =
 * on-chain IOU, admin settles OTC).
 */
export async function buildClaimRedemptionTx(
  connection: Connection,
  wallet: WalletContextState,
  args: BuildClaimRedemptionTxArgs,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const owner = wallet.publicKey;

  const usdcTreasuryAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
  const ownerUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .claimRedemption()
    .accounts({
      config: configPda(),
      owner,
      redemptionRequest: args.request.pubkey,
      usdcMint: USDC_MINT,
      usdcTreasury: usdcTreasuryAta,
      ownerUsdcAta,
      treasuryPda: treasuryPda(),
      priceUpdate: args.priceUpdate,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerUsdcAta,
      owner,
      USDC_MINT,
      TOKEN_PROGRAM_ID,
    ),
    ix,
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner;
  return tx;
}

/**
 * P2-03: the OWNER closes a request the admin already settled OTC
 * (status == SettledOffchain) and reclaims the PDA rent. No funds move, no
 * oracle, no config. Only valid in the terminal SettledOffchain state.
 */
export async function buildCloseSettledRedemptionTx(
  connection: Connection,
  wallet: WalletContextState,
  request: RedemptionRequestView,
): Promise<Transaction> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const program = getProgram(connection, wallet);
  const owner = wallet.publicKey;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = await (program.methods as any)
    .closeSettledRedemption()
    .accounts({
      owner,
      redemptionRequest: request.pubkey,
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ix,
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = owner;
  return tx;
}

function statusKind(s: unknown): RedemptionStatusKind {
  const k = Object.keys(s as object)[0];
  if (k === "claimed") return "claimed";
  if (k === "settledOffchain") return "settledOffchain";
  return "pending";
}

/** All of `owner`'s redemption requests (owner is the 1st field after the 8B disc). */
export async function fetchRedemptionRequests(
  connection: Connection,
  owner: PublicKey,
): Promise<RedemptionRequestView[]> {
  const program = getReadOnlyProgram(connection);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await (program.account as any).redemptionRequest.all([
      { memcmp: { offset: 8, bytes: owner.toBase58() } },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return all.map((a: any) => ({
      pubkey: a.publicKey as PublicKey,
      owner: a.account.owner as PublicKey,
      amountSilv: a.account.amountSilv as BN,
      requestedAt: (a.account.requestedAt as BN).toNumber(),
      claimableAt: (a.account.claimableAt as BN).toNumber(),
      nonce: a.account.nonce as BN,
      status: statusKind(a.account.status),
    }));
  } catch (e) {
    console.error("fetchRedemptionRequests error", e);
    return [];
  }
}

// ---- parsing ----

// Parse a plain non-negative decimal string to atomic units (6 decimals).
// Fable audit P2-G: `<input type="number">` accepts scientific notation
// ("2e3"), and these run inside a render-time useMemo, so a `new BN("2e3")`
// throw would crash the whole page via the error boundary. Reject anything that
// is not a plain decimal (no exponent, no sign) by returning 0 - the caller's
// zero-amount guards then handle it cleanly, and the preview shows nothing.
function parseDecimalToAtomic6(input: string): BN {
  if (!/^\d*\.?\d*$/.test(input.trim())) return new BN(0);
  const [whole = "0", frac = ""] = input.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return new BN(whole || "0")
    .mul(new BN(1_000_000))
    .add(new BN(fracPadded || "0"));
}

export function parseUsdcAmount(input: string): BN {
  return parseDecimalToAtomic6(input);
}

export function parseSilvAmount(input: string): BN {
  return parseDecimalToAtomic6(input);
}
