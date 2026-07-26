// Dominion admin instruction builders.
//
// Each builder returns the dominion_silver_mint TransactionInstruction(s)
// whose required signer is the on-chain `config.admin` = the Ops Squads
// VAULT PDA. Squads-routed actions are wrapped by squads.ts
// `buildCreateProposalTx` (the vault PDA signs at Squads execution).
//
// PDA correctness: `config` and `guardian_account` (add/remove) carry IDL
// const/arg seeds so Anchor auto-derives them. The `timelock` PDA seed is
// `[b"timelock", nonce_u64_le]` (account-data-dependent for propose_*), so
// we derive + pass it EXPLICITLY rather than rely on the resolver. The
// OPTIONAL `guardian` account on pause/cancel is also passed explicitly
// (Anchor 0.31 does not auto-add optional accounts). Shapes verified
// against the committed IDL + the contract source.

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import idl from "./idl/dominion_silver_mint.json";
import {
  PROGRAM_ID,
  SILV_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
} from "./constants";
import {
  configPda,
  guardianPda,
  redemptionRequestPda,
  silvMetadataAuthorityPda,
  silvMintAuthorityPda,
  timelockPda,
  treasuryPda,
} from "./pdas";
import { roleVaultPda } from "./squads";

/* eslint-disable @typescript-eslint/no-explicit-any */

const _programCache = new WeakMap<Connection, Program>();
function getProgram(connection: Connection): Program {
  const cached = _programCache.get(connection);
  if (cached) return cached;
  const dummyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  const p = new Program(
    idl as any,
    new AnchorProvider(connection, dummyWallet as any, {
      commitment: "confirmed",
    }),
  );
  _programCache.set(connection, p);
  return p;
}

/** The on-chain admin = Ops Squads vault PDA. */
export function adminAuthority(): PublicKey {
  return roleVaultPda("ops");
}

/** The treasury USDC token account (ATA of the treasury authority PDA,
 *  classic Token program) - matches the live deploy + test scripts. */
function treasuryUsdcAta(): PublicKey {
  return getAssociatedTokenAddressSync(
    USDC_MINT,
    treasuryPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
}

/** Read the on-chain config.admin (for the UI mismatch guard). */
export async function fetchOnchainAdmin(
  connection: Connection,
): Promise<PublicKey> {
  const c: any = await (getProgram(connection).account as any).configAccount.fetch(
    configPda(),
  );
  return new PublicKey(c.admin);
}

/** Fetch the full decoded config account (for showing current values in the
 *  Actions UI). Returns the raw Anchor-decoded account (camelCase fields;
 *  BN for u64/i64 fields, raw bytes/PublicKey for pubkeys). */
export async function fetchConfig(connection: Connection): Promise<any> {
  return (getProgram(connection).account as any).configAccount.fetch(
    configPda(),
  );
}

async function nextTimelockNonce(connection: Connection): Promise<bigint> {
  const c: any = await (getProgram(connection).account as any).configAccount.fetch(
    configPda(),
  );
  return BigInt(c.nextTimelockNonce.toString());
}

export interface BuildCtx {
  connection: Connection;
  /** Direct-admin override: when the connected wallet IS the on-chain
   *  config.admin (a plain wallet, not the Ops Squads vault), pass it here so
   *  the admin-role account/signer is the connected key and the instruction is
   *  signed DIRECTLY (no Squads wrapper). When absent, builders fall back to
   *  adminAuthority() (the Ops vault PDA) exactly as before. */
  admin?: PublicKey;
}
type Ix = Promise<TransactionInstruction[]>;
const one = (ix: TransactionInstruction): TransactionInstruction[] => [ix];

// ---------------------------------------------------------------------------
// Instant setters (Ops vault, no timelock). Accounts: { config(auto), admin }.
// ---------------------------------------------------------------------------
async function instant(c: BuildCtx, method: string, arg: any): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    [method](arg)
    .accountsPartial({ admin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}
// AUDIT A-31: set_max_silv_supply now reads the live mint supply (so the cap can
// never be set below what is already minted, which would permanently brick
// admin_premint since raising the cap is blocked). It therefore has its own
// Accounts struct with the SILV mint, and cannot use the shared `instant` helper.
export async function setMaxSilvSupply(c: BuildCtx, v: bigint): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .setMaxSilvSupply(new BN(v.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      silvMint: SILV_MINT,
    })
    .instruction();
  return one(ix);
}
// "Mint at launch" (Thomas, 2026-07-26). Deliberately asymmetric, matching the
// program: CLOSING is instant, OPENING is 24h-timelocked and guardian-cancellable.
// Opening wakes the oracle path, which is dormant while mint and redeem are both
// closed, so every staleness / confidence / publisher guard becomes load-bearing the
// moment it lands.
export const setPublicMintEnabled = (c: BuildCtx, on: boolean): Ix =>
  instant(c, "setPublicMintEnabled", on);
export const proposeSetPublicMint = (c: BuildCtx, on: boolean): Ix =>
  propose(c, "proposeSetPublicMint", [on]);

export const setRedemptionsEnabled = (c: BuildCtx, on: boolean): Ix =>
  instant(c, "setRedemptionsEnabled", on);
// Instant, admin-only. Sets the inventory wallet the admin_premint destination
// ATA is derived against off-chain. Accounts: { config(auto), admin }.
export const setInventoryWallet = (c: BuildCtx, wallet: PublicKey): Ix =>
  instant(c, "setInventoryWallet", wallet);

/** RedeemLimitsArgs: every field is optional (null = leave unchanged).
 *  Same Borsh-camelCase constraint as OracleGuardsArgs (Fable audit P1-A): the
 *  keys MUST be camelCase (Anchor camelCases the IDL at runtime); a snake_case
 *  key silently encodes None and the field is dropped with NO error.
 *
 *  Two callers share this shape:
 *   - emergencyTightenRedeemLimits: instant admin-only; the contract ONLY
 *     accepts SAFE-DIRECTION values (budget DOWN, window UP, threshold DOWN,
 *     queue_delay UP). A loosen reverts LooseningRequiresTimelock.
 *   - proposeSetRedeemLimits: the 24h-timelocked LOOSEN path. */
export interface RedeemLimitsInput {
  instantRedeemBudgetUsdc?: bigint;
  instantRedeemWindowSeconds?: number;
  largeRedeemThresholdUsdc?: bigint;
  redeemQueueDelaySeconds?: number;
}
export function redeemLimitsArgsObject(a: RedeemLimitsInput) {
  return {
    instantRedeemBudgetUsdc:
      a.instantRedeemBudgetUsdc != null
        ? new BN(a.instantRedeemBudgetUsdc.toString())
        : null,
    instantRedeemWindowSeconds: a.instantRedeemWindowSeconds ?? null,
    largeRedeemThresholdUsdc:
      a.largeRedeemThresholdUsdc != null
        ? new BN(a.largeRedeemThresholdUsdc.toString())
        : null,
    redeemQueueDelaySeconds: a.redeemQueueDelaySeconds ?? null,
  };
}
// Instant TIGHTEN-only. Accounts: { config(auto), admin }.
export const emergencyTightenRedeemLimits = (
  c: BuildCtx,
  a: RedeemLimitsInput,
): Ix =>
  instant(c, "emergencyTightenRedeemLimits", redeemLimitsArgsObject(a));

// ---------------------------------------------------------------------------
// admin_premint: admin-only mint of SILV directly into the inventory owner's
// Token-2022 ATA. Accounts: { config(auto), admin, silvMint, inventorySilvAta,
// silvMintAuthority(PDA ["silv_mint_authority"]), token2022Program }.
// ---------------------------------------------------------------------------
export async function adminPremint(
  c: BuildCtx,
  amount: bigint,
  inventoryOwner: PublicKey,
): Ix {
  const inventorySilvAta = getAssociatedTokenAddressSync(
    SILV_MINT,
    inventoryOwner,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const ix = await (getProgram(c.connection).methods as any)
    .adminPremint(new BN(amount.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      silvMint: SILV_MINT,
      inventorySilvAta,
      silvMintAuthority: silvMintAuthorityPda(),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
  return one(ix);
}

// ---------------------------------------------------------------------------
// Deposit USDC (adds funds). usdc_treasury = treasury USDC ATA.
// ---------------------------------------------------------------------------
export async function depositUsdc(
  c: BuildCtx,
  amount: bigint,
  sourceUsdcAta: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .depositUsdc(new BN(amount.toString()))
    .accountsPartial({
      user: c.admin ?? adminAuthority(),
      usdcMint: USDC_MINT,
      usdcTreasury: treasuryUsdcAta(),
      userUsdcAta: sourceUsdcAta,
      classicTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return one(ix);
}

// ---------------------------------------------------------------------------
// Guardians (admin-managed). guardian_account auto-derived from the arg.
// ---------------------------------------------------------------------------
export async function addGuardian(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .addGuardian(g)
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      payer: c.admin ?? adminAuthority(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return one(ix);
}
/** AUDIT 0.12b: this SCHEDULES a removal, it does not apply it. The guardian keeps
 *  full powers for admin_timelock_seconds and may cancel its own removal, so a
 *  compromised admin can no longer clear the veto in one signature. Apply it after
 *  the window with `finalizeGuardianRemoval`. */
export async function removeGuardian(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .removeGuardian(g)
    .accountsPartial({ admin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}

/** Applies a removal scheduled by removeGuardian, once its window has elapsed.
 *  Permissionless on-chain, so no admin account is needed. */
export async function finalizeGuardianRemoval(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .finalizeGuardianRemoval(g)
    .accountsPartial({})
    .instruction();
  return one(ix);
}

/** Cancels a scheduled removal. Signed by the admin OR by the targeted guardian
 *  itself, which is the point of the mechanism. `signer` defaults to the acting
 *  admin; pass the guardian key to exercise the self-veto path. */
export async function cancelGuardianRemoval(
  c: BuildCtx,
  g: PublicKey,
  signer?: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .cancelGuardianRemoval(g)
    .accountsPartial({ signer: signer ?? c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}

// ---------------------------------------------------------------------------
// Pause / unpause. The OPTIONAL `guardian` account is passed explicitly for
// the guardian path (Anchor 0.31 will NOT auto-add an optional account).
// ---------------------------------------------------------------------------
export async function pauseAsAdmin(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .pause()
    .accountsPartial({ signer: c.admin ?? adminAuthority(), guardian: null })
    .instruction();
  return one(ix);
}
export async function pauseAsGuardian(
  c: BuildCtx,
  guardianSigner: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .pause()
    .accountsPartial({
      signer: guardianSigner,
      guardian: guardianPda(guardianSigner),
    })
    .instruction();
  return one(ix);
}
export async function unpause(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .unpause()
    .accountsPartial({ admin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}
// Mark a Pending queued redemption as settled off-chain (OTC). The user's SILV
// is already burned; this confirms they were paid off-chain so the request can
// no longer be claimed on-chain (Fable audit P2-F: closes the double-pay risk).
// owner + nonce identify the request PDA. Admin-signed (the Ops vault).
export async function settleRedemptionOffchain(
  c: BuildCtx,
  owner: PublicKey,
  nonce: bigint,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .adminSettleRedemptionOffchain()
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      redemptionRequest: redemptionRequestPda(owner, nonce),
    })
    .instruction();
  return one(ix);
}
export async function cancelTimelockedAction(
  c: BuildCtx,
  nonce: bigint,
  guardianSigner: PublicKey,
  rentRecipient: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .cancelTimelockedAction(new BN(nonce.toString()))
    .accountsPartial({
      timelock: timelockPda(nonce),
      signer: guardianSigner,
      guardian: guardianPda(guardianSigner),
      rentRecipient,
    })
    .instruction();
  return one(ix);
}

// ---------------------------------------------------------------------------
// Timelocked propose_* : derive the timelock PDA from the CURRENT
// config.next_timelock_nonce and pass it explicitly.
//
// OPERATIONAL CONSTRAINT (Fable audit P2-E): the nonce is read HERE, at build
// time, but a Squads proposal executes LATER (after the multisig ceremony) and
// its message is immutable. The contract `init`s the timelock PDA from the
// nonce at EXECUTION time. So if you stage TWO timelocked proposals via Squads
// before the first one executes, both bake the PDA for the same nonce N; after
// the first executes, the second fails ConstraintSeeds forever (approved but
// dead, needs a full re-propose). RULE: execute timelocked proposals SERIALLY -
// complete one Squads ceremony (create -> approve -> execute the dominion
// propose_*) before staging the next. A contract-level fix (client-provided
// nonce) is deferred to the Lazer frontend phase.
// ---------------------------------------------------------------------------
async function propose(c: BuildCtx, method: string, args: any[]): Ix {
  const nonce = await nextTimelockNonce(c.connection);
  const ix = await (getProgram(c.connection).methods as any)
    [method](...args)
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      timelock: timelockPda(nonce),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return one(ix);
}
export const proposeSetPremiumMint = (c: BuildCtx, bps: number): Ix =>
  propose(c, "proposeSetPremiumMint", [bps]);
export const proposeSetPremiumRedeem = (c: BuildCtx, bps: number): Ix =>
  propose(c, "proposeSetPremiumRedeem", [bps]);
export const proposeSetTreasuryMinFloat = (c: BuildCtx, v: bigint): Ix =>
  propose(c, "proposeSetTreasuryMinFloat", [new BN(v.toString())]);
export const proposeSetAdminTimelock = (c: BuildCtx, secs: number): Ix =>
  propose(c, "proposeSetAdminTimelock", [secs]);
export const proposeSetComplianceMode = (c: BuildCtx, on: boolean): Ix =>
  propose(c, "proposeSetComplianceMode", [on]);
// P2-05: each field is Option<String>. Pass null to LEAVE A FIELD UNCHANGED
// (Anchor encodes null as Rust Option::None; the contract skips that field's
// CPI so it cannot be blanked). A provided field must be non-empty and within
// its size cap (name<=32, symbol<=10, uri<=180) or the contract reverts.
export const proposeUpdateMetadata = (
  c: BuildCtx,
  name: string | null,
  symbol: string | null,
  uri: string | null,
): Ix => propose(c, "proposeUpdateMetadata", [name, symbol, uri]);
export const proposeWithdrawUsdc = (
  c: BuildCtx,
  amount: bigint,
  recipient: PublicKey,
): Ix =>
  propose(c, "proposeWithdrawUsdc", [new BN(amount.toString()), recipient]);
// Pyth Lazer migration: a single numeric feed id (u32). The Core receiver
// program arg is gone (the Lazer program is a compile-time contract constant).
export const proposeSetPythFeed = (c: BuildCtx, lazerFeedId: number): Ix =>
  propose(c, "proposeSetPythFeed", [lazerFeedId]);
export const proposeAdminTransfer = (c: BuildCtx, newAdmin: PublicKey): Ix =>
  propose(c, "proposeAdminTransfer", [newAdmin]);

/** OracleGuardsArgs: every field is optional (null = leave unchanged).
 *  CRITICAL (Fable audit P1-A): the Borsh coder reads the CAMELCASED field
 *  names. Anchor >=0.30 runs convertIdlToCamelCase at Program construction, so
 *  the keys passed here MUST be camelCase (confBps, minPriceScaled, ...). Any
 *  snake_case key is silently treated as `undefined` => encoded as None => the
 *  field is dropped from the proposal with NO error. `min_publishers` is
 *  included (Fable P1-B): the launch GO gate raises it via this instruction. */
export interface OracleGuardsInput {
  stalenessSeconds?: number;
  confBps?: number;
  minPriceScaled?: bigint;
  maxPriceScaled?: bigint;
  maxDeltaBps?: number;
  decaySeconds?: number;
  dustFilterMinUsdc?: bigint;
  minPublishers?: number;
}
// Extracted + exported so the encoding regression test can assert every
// provided field round-trips as Some. The keys MUST stay camelCase (Anchor
// camelCases the IDL at runtime); a snake_case key silently encodes None.
export function oracleGuardsArgsObject(a: OracleGuardsInput) {
  return {
    staleness: a.stalenessSeconds ?? null,
    confBps: a.confBps ?? null,
    minPriceScaled:
      a.minPriceScaled != null ? new BN(a.minPriceScaled.toString()) : null,
    maxPriceScaled:
      a.maxPriceScaled != null ? new BN(a.maxPriceScaled.toString()) : null,
    maxDeltaBps: a.maxDeltaBps ?? null,
    decaySeconds: a.decaySeconds ?? null,
    dustFilterMinUsdc:
      a.dustFilterMinUsdc != null
        ? new BN(a.dustFilterMinUsdc.toString())
        : null,
    minPublishers: a.minPublishers ?? null,
  };
}
export const proposeSetOracleGuards = (c: BuildCtx, a: OracleGuardsInput): Ix =>
  propose(c, "proposeSetOracleGuards", [oracleGuardsArgsObject(a)]);
// 24h-timelocked LOOSEN path for the redeem limits (tighten is instant via
// emergencyTightenRedeemLimits). Same RedeemLimitsArgs shape.
export const proposeSetRedeemLimits = (
  c: BuildCtx,
  a: RedeemLimitsInput,
): Ix => propose(c, "proposeSetRedeemLimits", [redeemLimitsArgsObject(a)]);

// 2-step admin transfer. accept = signed by the NEW admin = the Ops vault.
export async function acceptAdminTransfer(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .acceptAdminTransfer()
    .accountsPartial({ newAdmin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}
// The `admin` account was renamed to `signer` and a NEW optional `guardian`
// account (PDA ["guardian", signer]) was added. Admin path: pass the Ops vault
// as `signer` and `guardian: null` (Anchor sends the program-id sentinel for
// the null optional, matching the pause/cancelTimelockedAction convention).
export async function cancelAdminTransfer(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .cancelAdminTransfer()
    .accountsPartial({ signer: c.admin ?? adminAuthority(), guardian: null })
    .instruction();
  return one(ix);
}

export type ExecMethod =
  | "executeSetPremiumMint"
  | "executeSetPremiumRedeem"
  | "executeSetOracleGuards"
  | "executeSetPythFeed"
  | "executeSetTreasuryMinFloat"
  | "executeSetAdminTimelock"
  | "executeSetComplianceMode"
  | "executeSetRedeemLimits"
  | "executeSetPublicMint";
export const EXEC_METHODS: ExecMethod[] = [
  "executeSetPremiumMint",
  "executeSetPremiumRedeem",
  "executeSetOracleGuards",
  "executeSetPythFeed",
  "executeSetTreasuryMinFloat",
  "executeSetAdminTimelock",
  "executeSetComplianceMode",
  "executeSetRedeemLimits",
  "executeSetPublicMint",
];

export async function executeTimelocked(
  c: BuildCtx,
  method: ExecMethod,
  nonce: bigint,
  rentRecipient: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    [method](new BN(nonce.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      timelock: timelockPda(nonce),
      rentRecipient,
    })
    .instruction();
  return one(ix);
}
export async function executeUpdateMetadata(
  c: BuildCtx,
  nonce: bigint,
  rentRecipient: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .executeUpdateMetadata(new BN(nonce.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      timelock: timelockPda(nonce),
      rentRecipient,
      silvMint: SILV_MINT,
      metadataAuthority: silvMetadataAuthorityPda(),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
  return one(ix);
}
export async function executeWithdrawUsdc(
  c: BuildCtx,
  nonce: bigint,
  rentRecipient: PublicKey,
  recipientAta: PublicKey,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .executeWithdrawUsdc(new BN(nonce.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      timelock: timelockPda(nonce),
      rentRecipient,
      usdcMint: USDC_MINT,
      usdcTreasury: treasuryUsdcAta(),
      recipientAta,
      treasuryPda: treasuryPda(),
      classicTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return one(ix);
}
