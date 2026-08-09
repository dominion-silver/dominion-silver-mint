// Dominion admin instruction builders. Each returns instruction(s) whose required signer is the
// on-chain `config.admin` = the Ops Squads VAULT PDA; squads.ts `buildCreateProposalTx` wraps the
// Squads-routed ones. PDA rules: `config` and `guardian_account` carry IDL seeds and are auto-derived.
// The `timelock` PDA seed is `[b"timelock", nonce_u64_le]`, account-data-dependent, so it is derived
// and passed EXPLICITLY, as is the OPTIONAL `guardian` on pause/cancel (Anchor 0.31 skips optionals).

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
  feeExemptPda,
  feeVaultPda,
  guardianPda,
  kycPda,
  silvMetadataAuthorityPda,
  silvMintAuthorityPda,
  timelockPda,
  treasuryPda,
} from "./pdas";
import { roleVaultPda } from "./squads";
// ROUND 8 L1-03: the eligibility rule for a guardian lives in ONE place (anchor-client's `active`),
// so the unpause builder reuses it rather than restating `cooldown_until == 0 && key != admin`.
import { fetchGuardians } from "./anchor-client";

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

/** Treasury USDC ATA: the owner is the treasury PDA, on the classic Token program. */
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

/** The raw Anchor-decoded config: camelCase fields, BN for u64/i64, PublicKey for pubkeys. */
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
  /** Direct-admin override: when the connected wallet IS `config.admin` (a plain wallet, not the Ops
   *  vault), pass it here to sign directly, with no Squads wrapper. Absent, builders use
   *  adminAuthority(), the Ops vault PDA. */
  admin?: PublicKey;
}
type Ix = Promise<TransactionInstruction[]>;
const one = (ix: TransactionInstruction): TransactionInstruction[] => [ix];

// Instant setters (Ops vault, no timelock). Accounts: { config(auto), admin }.
async function instant(c: BuildCtx, method: string, arg: any): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    [method](arg)
    .accountsPartial({ admin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}
// Reads the live mint supply, so the cap can never land below what is already minted (which would
// brick admin_premint, since raising is blocked). Hence silvMint, and no shared `instant` helper.
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
// Asymmetric, matching the program: CLOSING is instant, OPENING is 24h-timelocked and
// guardian-cancellable. Opening also wakes the oracle path, so every oracle guard becomes load-bearing.
export const setPublicMintEnabled = (c: BuildCtx, on: boolean): Ix =>
  instant(c, "setPublicMintEnabled", on);
export const proposeSetPublicMint = (c: BuildCtx, on: boolean): Ix =>
  propose(c, "proposeSetPublicMint", [on]);

export const setRedemptionsEnabled = (c: BuildCtx, on: boolean): Ix =>
  instant(c, "setRedemptionsEnabled", on);

/**
 * ROUND 8 T8-03. There is NO instant inventory setter any more, in the program or here.
 *
 * The pre-mint destination is an argument of `initialize`, bound atomically with everything else and
 * validated non-default. `set_inventory_wallet` was deleted, not restricted: an instant first binding
 * still let a key compromised DURING the ceremony bind the attacker's wallet before the legitimate
 * one, with no delay and no veto. The builder that wrapped it is gone for the same reason: leaving it
 * would send a discriminator the program no longer dispatches, and an operator would read the failure
 * as an outage rather than as a removed capability.
 *
 * The remaining operational need is a LATER change (key rotation, custody move), and that is the
 * 24h-timelocked pair below plus the shared `cancelTimelockedAction`, which a guardian can use inside
 * the window. `proposeSetInventoryWallet` occupies the single `pending_inventory_wallet_nonce` slot,
 * so exactly one change can be armed at a time and a guardian has one thing to watch.
 */
export const proposeSetInventoryWallet = (
  c: BuildCtx,
  wallet: PublicKey,
): Ix => propose(c, "proposeSetInventoryWallet", [wallet]);

/**
 * ROUND 5 P1-04. The MINIMUM SIZE OF A PRICED OPERATION, atomic USDC: `amount_usdc` on mint, the gross
 * USDC value of `amount_silv` on redeem. Instant in BOTH directions, bounded by
 * MIN_OPERATION_CEILING_USDC (100 USDC on chain); zero disables the floor.
 *
 * It exists because D2 made the Lazer anti-replay strict, so one signed print prices exactly one
 * operation protocol-wide and, with no floor, capturing every print cost about 0.00006 USDC on the mint
 * side and less on redeem. The floor is what makes that cost working capital.
 *
 * THIS BUILDER IS WHY THE FLOOR IS ADJUSTABLE AT ALL. `config.admin` is the off-curve Ops Squads vault,
 * so no keypair can call the instruction; the panel is the only thing that wraps a dominion instruction
 * into a Squads vault transaction. A review pass caught that the setter shipped with no builder and no
 * card, which made "instant in both directions, so operators can react" true of the program and false
 * of the product: there was nothing to react with, and an in-place upgrade lands with the floor at 0.
 */
export const setMinOperationUsdc = (c: BuildCtx, minUsdc: bigint): Ix =>
  instant(c, "setMinOperationUsdc", new BN(minUsdc.toString()));

/** Every field is optional (null = leave unchanged). The keys MUST be camelCase: Anchor camelCases the
 *  IDL at runtime, so a snake_case key silently encodes None and the field is dropped with NO error.
 *  emergencyTightenRedeemLimits is instant and takes SAFE-DIRECTION values only (budget DOWN, window
 *  UP); a loosen reverts LooseningRequiresTimelock. proposeSetRedeemLimits is the 24h LOOSEN path. */
export interface RedeemLimitsInput {
  instantRedeemBudgetUsdc?: bigint;
  instantRedeemWindowSeconds?: number;
  /** DEAD on chain. Still encoded: removing it changes the borsh layout of the action data. */
  largeRedeemThresholdUsdc?: bigint;
  /** DEAD on chain. Same reason. */
  redeemQueueDelaySeconds?: number;
  /** THE REDEEM SWITCH. `true` is a LOOSENING, reachable only through proposeSetRedeemLimits + the 24h
   *  wait + executeSetRedeemLimits (emergencyTighten rejects it); `false` works on either path. It is
   *  the ONLY way to open redemptions: setRedemptionsEnabled still refuses `true` in the deployed code. */
  redemptionsEnabled?: boolean;
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
    // `?? null`, never `|| null`: `false` is meaningful here, and `||` would drop the field silently.
    redemptionsEnabled: a.redemptionsEnabled ?? null,
  };
}
// Instant TIGHTEN-only. Accounts: { config(auto), admin }.
export const emergencyTightenRedeemLimits = (
  c: BuildCtx,
  a: RedeemLimitsInput,
): Ix =>
  instant(c, "emergencyTightenRedeemLimits", redeemLimitsArgsObject(a));

// Premium fee vault + fee-exemption whitelist.

/** The premium fee vault: the USDC ATA of the fee_vault PDA. allowOwnerOffCurve = true is MANDATORY
 *  because the owner is a PDA; omitting it throws TokenOwnerOffCurveError. */
export function feeVaultUsdcAta(): PublicKey {
  return getAssociatedTokenAddressSync(
    USDC_MINT,
    feeVaultPda(),
    true,
    TOKEN_PROGRAM_ID,
  );
}

/** Accrued premium in USDC atomic units, or NULL when the vault does not exist. The UI must surface
 *  null loudly: mint_silv and redeem_silv both REQUIRE this account, so a missing vault reverts both. */
export async function fetchFeeVaultBalance(
  connection: Connection,
): Promise<bigint | null> {
  // `null` means ABSENT, and anything else THROWS so SWR can tell the two states apart. Never widen
  // to a bare catch. The match is on the message: web3.js throws a plain Error for account-not-found.
  try {
    const r = await connection.getTokenAccountBalance(feeVaultUsdcAta());
    return BigInt(r.value.amount);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/could not find account|Invalid param|AccountNotFound/i.test(msg)) {
      return null;
    }
    throw e;
  }
}

/** Grant or update a fee exemption. Instant, admin-only. `flags`: 1 = mint, 2 = redeem, 3 = both.
 *  Prefer 1: a both-sides exemption makes a round trip free, a free option on oracle movement paid by
 *  the treasury (state/fee_exempt.rs). `expiresAtUnix` is a unix timestamp, or 0n for never; a term is
 *  STRONGLY preferred, since it bounds a self-exempting compromised admin. A past expiry is rejected. */
export async function setFeeExempt(
  c: BuildCtx,
  wallet: PublicKey,
  flags: number,
  expiresAtUnix: bigint,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .setFeeExempt(wallet, flags, new BN(expiresAtUnix.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      feeExempt: feeExemptPda(wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return one(ix);
}

/** Revoke an exemption and reclaim its rent. Instant. There is no "set flags to 0": the contract
 *  rejects zero flags, since an existing-but-empty account still reads as whitelisted in a roster. */
export async function removeFeeExempt(c: BuildCtx, wallet: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .removeFeeExempt(wallet)
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      feeExempt: feeExemptPda(wallet),
    })
    .instruction();
  return one(ix);
}

/** Sweep accrued premium to `destinationOwner`'s USDC ATA. Instant on purpose: the vault holds earned
 *  revenue, not the collateral users redeem against, and the admin is already a Squads multisig.
 *  `withdraw_usdc` touches the TREASURY and stays 24h-timelocked. The destination ATA must exist. */
export async function withdrawFees(
  c: BuildCtx,
  destinationOwner: PublicKey,
  amount: bigint,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .withdrawFees(new BN(amount.toString()))
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      usdcMint: USDC_MINT,
      feeVaultPda: feeVaultPda(),
      feeVault: feeVaultUsdcAta(),
      destination: getAssociatedTokenAddressSync(
        USDC_MINT,
        destinationOwner,
        true,
        TOKEN_PROGRAM_ID,
      ),
      // Read-only, but REQUIRED: the sweep is gated on the treasury's float.
      usdcTreasury: treasuryUsdcAta(),
      classicTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return one(ix);
}

// KYC gate. DORMANT until set_kyc_scope is armed.

/** Set or rotate the attestor key. Instant, admin-only: the realistic failure is this key LEAKING (it
 *  lives on a server and signs every approval), and a timelock on rotation would mean 24h with a
 *  compromised attestor live. Pass PublicKey.default to decommission it. ONE signature, and it must
 *  stay one: Squads wraps with `ephemeralSigners: 0` and its execute path compiles a single signer, so
 *  a two-signature instruction cannot be assembled at all. An attestor co-signature would break
 *  rotation-while-armed, the incident path for a leaked key. */
export const setKycOperator = (c: BuildCtx, operator: PublicKey): Ix =>
  instant(c, "setKycOperator", operator);

/** Arm or disarm the gate. `flags`: 0 = off, 1 = mint, 2 = redeem, 3 = both. Instant, and ONE
 *  signature for the same reason as setKycOperator. THE ORDER IS ENFORCED BY THE PROGRAM: the
 *  contract refuses to arm while `kyc_attestation_count == 0`, so attest at least one wallet first. */
export const setKycScope = (c: BuildCtx, flags: number): Ix =>
  instant(c, "setKycScope", flags);

/** Record an approval. Signed by the ATTESTOR, not the admin, so the panel can only build it when the
 *  connected wallet holds the operator key. `reference` is a 32-byte HASH of the provider's record id,
 *  NEVER PII even hashed (brute-forceable, and no GDPR erasure on chain). All-zero = no reference. */
export async function attestKyc(
  c: BuildCtx,
  attestor: PublicKey,
  wallet: PublicKey,
  reference: Uint8Array,
): Ix {
  if (reference.length !== 32) {
    throw new Error(
      `attestKyc: reference must be exactly 32 bytes, got ${reference.length}`,
    );
  }
  const ix = await (getProgram(c.connection).methods as any)
    .attestKyc(wallet, Array.from(reference))
    .accountsPartial({
      attestor,
      kyc: kycPda(wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return one(ix);
}

/** Withdraw an approval. Signable by EITHER the attestor (normal offboarding) or the admin (the
 *  incident path, so a compromised attestor's writes can be undone before rotating it). `allowDisarm`
 *  is consent to the KYC GATE BEING DROPPED, and it only matters when this revocation would leave the
 *  roster empty while a side is armed. Leave it false: the program refuses rather than loosening. */
export async function revokeKyc(
  c: BuildCtx,
  signer: PublicKey,
  wallet: PublicKey,
  allowDisarm = false,
): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .revokeKyc(wallet, allowDisarm)
    .accountsPartial({ signer, kyc: kycPda(wallet) })
    .instruction();
  return one(ix);
}

// admin_premint: admin-only mint of SILV straight into the inventory owner's Token-2022 ATA.
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

// Guardians (admin-managed). `guardian_account` is auto-derived from the arg.
/** ROUND 8 F-02: single signer. The appointee's co-signature was removed; it made the instruction
 *  unexecutable through the Squads path, which has no moment for an external key to sign. */
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
/** SCHEDULES a removal, it does not apply it: the guardian keeps full powers for admin_timelock_seconds
 *  and may cancel its own removal, so a compromised admin cannot clear the veto in one signature.
 *  Apply it after the window with `finalizeGuardianRemoval`. */
export async function removeGuardian(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .removeGuardian(g)
    .accountsPartial({ admin: c.admin ?? adminAuthority() })
    .instruction();
  return one(ix);
}

/** Applies a removal scheduled by removeGuardian, once its window has elapsed. Permissionless. */
export async function finalizeGuardianRemoval(c: BuildCtx, g: PublicKey): Ix {
  const ix = await (getProgram(c.connection).methods as any)
    .finalizeGuardianRemoval(g)
    .accountsPartial({})
    .instruction();
  return one(ix);
}

/** Cancels a scheduled removal. Signed by the admin OR by the targeted guardian itself, which is the
 *  point of the mechanism. `signer` defaults to the admin; pass the guardian key for the self-veto. */
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

// Pause / unpause. The OPTIONAL `guardian` is explicit: Anchor 0.31 will NOT auto-add an optional.
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
/**
 * ROUND 8 L1-03. `unpause` takes a MANDATORY `guardian` account now, and this builder did not send
 * it. Anchor cannot derive it: the PDA seed is the guardian's own key, which the config does not
 * hold, so `.accountsPartial` failed with `Unresolved accounts: guardian` and the card threw before
 * producing a single instruction. The resume path after an emergency pause was dead.
 *
 * The account is DISCOVERED rather than typed. An operator ending an incident should not have to
 * remember which guardian key is eligible, and the eligibility rule is not obvious: the program
 * demands `cooldown_until == 0` AND a key different from the current admin. `fetchGuardians` already
 * computes exactly that as `active`, for the roster panel, so this reuses it instead of restating the
 * rule and drifting from it.
 *
 * Pass `guardian` explicitly to present a specific one; the caller is then responsible for its
 * eligibility, and the program is the one that decides.
 */
export async function unpause(c: BuildCtx, guardian?: PublicKey): Ix {
  let present = guardian;
  if (!present) {
    const admin = c.admin ?? adminAuthority();
    const onchainAdmin = await fetchOnchainAdmin(c.connection).catch(() => admin);
    const eligible = (await fetchGuardians(c.connection, onchainAdmin)).filter(
      (g) => g.active,
    );
    if (eligible.length === 0) {
      // The same refusal the program would give, raised where it can still be read. Without this the
      // operator gets `Unresolved accounts: guardian`, which names a client-side symbol and says
      // nothing about what to do.
      throw new Error(
        "unpause needs an ACTIVE guardian whose key is not the current admin, and none is " +
          "registered. Add one with 'Add guardian' first. The protocol cannot leave pause until an " +
          "independent party can pause it again.",
      );
    }
    present = eligible[0].guardian;
  }
  const ix = await (getProgram(c.connection).methods as any)
    .unpause()
    .accountsPartial({
      admin: c.admin ?? adminAuthority(),
      guardian: guardianPda(present),
    })
    .instruction();
  return one(ix);
}
// `settleRedemptionOffchain` is gone with the queued path: there is no such on-chain instruction.
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

// Timelocked propose_*: the timelock PDA is derived from the CURRENT config.next_timelock_nonce and
// passed explicitly. OPERATIONAL CONSTRAINT: the nonce is read HERE at build time, but a Squads
// proposal executes LATER with an immutable message, and the contract `init`s the PDA from the nonce at
// EXECUTION time. Stage TWO before the first executes and both bake nonce N; the second then fails
// ConstraintSeeds forever, approved but dead. RULE: run them SERIALLY, one full ceremony at a time.
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
// Each field is Option<String>: null LEAVES IT UNCHANGED (the contract skips that field's CPI, so a
// field cannot be blanked). A provided field must be non-empty and within its cap (32 / 10 / 180).
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
// A single numeric Lazer feed id (u32); the Lazer program is a compile-time contract constant.
export const proposeSetPythFeed = (c: BuildCtx, lazerFeedId: number): Ix =>
  propose(c, "proposeSetPythFeed", [lazerFeedId]);
export const proposeAdminTransfer = (c: BuildCtx, newAdmin: PublicKey): Ix =>
  propose(c, "proposeAdminTransfer", [newAdmin]);

/** Every field is optional (null = leave unchanged). CRITICAL: the Borsh coder reads the CAMELCASED
 *  names (Anchor runs convertIdlToCamelCase at construction), so a snake_case key is `undefined`,
 *  encodes as None, and the field is dropped with NO error. minPublishers is the launch GO gate. */
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
// The 24h-timelocked LOOSEN path (tightening is instant, via emergencyTightenRedeemLimits).
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
// Admin path: the Ops vault as `signer`, plus `guardian: null` (Anchor sends the program-id sentinel
// for a null optional, matching the pause / cancelTimelockedAction convention).
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
  | "executeSetPublicMint"
  // ROUND 8 T8-03: the ONLY remaining writer of config.inventory_wallet. Same generic shape as the
  // rest (admin, timelock PDA, rent recipient), so it needs no bespoke builder.
  | "executeSetInventoryWallet";
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
  "executeSetInventoryWallet",
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

/** The fee-vault ESCAPE HATCH. Instant in both directions. USDC carries a Circle freeze authority and
 *  the premium transfer inside mint and redeem is unconditional, so a frozen fee vault would brick both
 *  with no remedy short of an upgrade. With this false the premium stays in the treasury instead. */
export const setFeeRoutingEnabled = (c: BuildCtx, enabled: boolean): Ix =>
  instant(c, "setFeeRoutingEnabled", enabled);
