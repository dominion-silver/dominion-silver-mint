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
  silvMetadataAuthorityPda,
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

async function nextTimelockNonce(connection: Connection): Promise<bigint> {
  const c: any = await (getProgram(connection).account as any).configAccount.fetch(
    configPda(),
  );
  return BigInt(c.nextTimelockNonce.toString());
}

export interface BuildCtx {
  connection: Connection;
}
type Ix = Promise<TransactionInstruction[]>;
const one = (ix: TransactionInstruction): TransactionInstruction[] => [ix];

// ---------------------------------------------------------------------------
// Instant setters (Ops vault, no timelock). Accounts: { config(auto), admin }.
// ---------------------------------------------------------------------------
async function instant(c: BuildCtx, method: string, arg: any): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    [method](arg)
    .accountsPartial({ admin: adminAuthority() })
    .instruction();
  return one(ix);
}
export const setMaxSilvSupply = (c: BuildCtx, v: bigint): Ix =>
  instant(c, "setMaxSilvSupply", new BN(v.toString()));
export const setLargeRedeemThreshold = (c: BuildCtx, v: bigint): Ix =>
  instant(c, "setLargeRedeemThreshold", new BN(v.toString()));
export const setInstantRedeemBudget = (c: BuildCtx, v: bigint): Ix =>
  instant(c, "setInstantRedeemBudget", new BN(v.toString()));
export const setInstantRedeemWindow = (c: BuildCtx, secs: number): Ix =>
  instant(c, "setInstantRedeemWindow", secs);
export const setRedeemQueueDelay = (c: BuildCtx, secs: number): Ix =>
  instant(c, "setRedeemQueueDelay", secs);
export const setRedemptionsEnabled = (c: BuildCtx, on: boolean): Ix =>
  instant(c, "setRedemptionsEnabled", on);

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
      user: adminAuthority(),
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
      admin: adminAuthority(),
      payer: adminAuthority(),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return one(ix);
}
export async function removeGuardian(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .removeGuardian(g)
    .accountsPartial({ admin: adminAuthority() })
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
    .accountsPartial({ signer: adminAuthority(), guardian: null })
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
    .accountsPartial({ admin: adminAuthority() })
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
// ---------------------------------------------------------------------------
async function propose(c: BuildCtx, method: string, args: any[]): Ix {
  const nonce = await nextTimelockNonce(c.connection);
  const ix = await (getProgram(c.connection).methods as any)
    [method](...args)
    .accountsPartial({
      admin: adminAuthority(),
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
export const proposeUpdateMetadata = (
  c: BuildCtx,
  name: string,
  symbol: string,
  uri: string,
): Ix => propose(c, "proposeUpdateMetadata", [name, symbol, uri]);
export const proposeWithdrawUsdc = (
  c: BuildCtx,
  amount: bigint,
  recipient: PublicKey,
): Ix =>
  propose(c, "proposeWithdrawUsdc", [new BN(amount.toString()), recipient]);
export const proposeSetPythFeed = (
  c: BuildCtx,
  feedId: Uint8Array,
  receiverProgram: PublicKey,
): Ix =>
  propose(c, "proposeSetPythFeed", [Array.from(feedId), receiverProgram]);
export const proposeAdminTransfer = (c: BuildCtx, newAdmin: PublicKey): Ix =>
  propose(c, "proposeAdminTransfer", [newAdmin]);

/** OracleGuardsArgs: every field is optional (null = leave unchanged).
 *  Keys are the IDL field names (the Borsh coder reads by IDL name). */
export interface OracleGuardsInput {
  stalenessSeconds?: number;
  confBps?: number;
  minPriceScaled?: bigint;
  maxPriceScaled?: bigint;
  maxDeltaBps?: number;
  decaySeconds?: number;
  dustFilterMinUsdc?: bigint;
}
export const proposeSetOracleGuards = (
  c: BuildCtx,
  a: OracleGuardsInput,
): Ix =>
  propose(c, "proposeSetOracleGuards", [
    {
      staleness: a.stalenessSeconds ?? null,
      conf_bps: a.confBps ?? null,
      min_price_scaled:
        a.minPriceScaled != null ? new BN(a.minPriceScaled.toString()) : null,
      max_price_scaled:
        a.maxPriceScaled != null ? new BN(a.maxPriceScaled.toString()) : null,
      max_delta_bps: a.maxDeltaBps ?? null,
      decay_seconds: a.decaySeconds ?? null,
      dust_filter_min_usdc:
        a.dustFilterMinUsdc != null
          ? new BN(a.dustFilterMinUsdc.toString())
          : null,
    },
  ]);

// 2-step admin transfer. accept = signed by the NEW admin = the Ops vault.
export async function acceptAdminTransfer(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .acceptAdminTransfer()
    .accountsPartial({ newAdmin: adminAuthority() })
    .instruction();
  return one(ix);
}
export async function cancelAdminTransfer(c: BuildCtx): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .cancelAdminTransfer()
    .accountsPartial({ admin: adminAuthority() })
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
  | "executeSetComplianceMode";
export const EXEC_METHODS: ExecMethod[] = [
  "executeSetPremiumMint",
  "executeSetPremiumRedeem",
  "executeSetOracleGuards",
  "executeSetPythFeed",
  "executeSetTreasuryMinFloat",
  "executeSetAdminTimelock",
  "executeSetComplianceMode",
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
      admin: adminAuthority(),
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
      admin: adminAuthority(),
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
      admin: adminAuthority(),
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
