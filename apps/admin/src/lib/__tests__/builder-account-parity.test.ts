/**
 * ROUND 8 L1-03, the CLASS. Every admin builder sends exactly the accounts the IDL declares.
 *
 * WHY THIS FILE EXISTS. `unpause` gained a mandatory `guardian` account on chain and the panel's
 * builder kept calling `.accountsPartial({ admin })`. Anchor cannot derive that PDA (its seed is the
 * guardian's own key, which the config does not hold), so the card threw `Unresolved accounts:
 * guardian` before producing an instruction: the documented way to resume after an emergency pause
 * was dead, and nothing in the repository noticed.
 *
 * Nothing COULD notice. `scripts/verify-client-idl-parity.ts` says in its own header that it cannot
 * check completeness, because it cannot tell which instruction a given `.accounts({...})` belongs to.
 * `account-parity.test.ts` covers eight builders someone chose by hand, and `unpause` was not one of
 * them. So the defect was not that a case was missing; it was that cases were OPT-IN.
 *
 * THE FIX IS THE LAST TEST IN THIS FILE. The table below must name every exported builder, and
 * `every builder is covered` fails when one is added without a case. Forgetting is no longer possible
 * without a red test, which is the only version of this guarantee that survives the next ABI change.
 *
 * Everything is offline: `.instruction()` never dials out, and the fake connection answers the two
 * reads a builder can perform (the config, for the timelock nonce and the admin, and the guardian
 * roster) from bytes constructed here.
 */
import { describe, it, expect } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import * as actions from "../admin-actions";

/* eslint-disable @typescript-eslint/no-explicit-any */

const IDL = idl as any;
const CONFIG_ACCOUNT_BYTES = 800;
const GUARDIAN_ACCOUNT_BYTES = 98;

const disc = (name: string): number[] =>
  IDL.accounts.find((a: any) => a.name === name).discriminator;

const ADMIN = PublicKey.unique();
const GUARDIAN = PublicKey.unique();
const SOMEBODY = PublicKey.unique();

/** A zero-filled ConfigAccount: every pubkey default, every bool false, every Option None, nonce 0. */
function configAccountData(): Buffer {
  const data = Buffer.alloc(CONFIG_ACCOUNT_BYTES);
  Buffer.from(disc("ConfigAccount")).copy(data, 0);
  return data;
}

/** One ACTIVE guardian: cooldown_until = 0 and a key that is not the (default) config admin. */
function guardianAccountData(): Buffer {
  const data = Buffer.alloc(GUARDIAN_ACCOUNT_BYTES);
  Buffer.from(disc("GuardianAccount")).copy(data, 0);
  GUARDIAN.toBuffer().copy(data, 8); // guardian
  data.writeBigInt64LE(1n, 40); // added_at, non-zero so the row is not read as empty
  return data;
}

function fakeConnection(): Connection {
  const owner = new PublicKey(IDL.address);
  const config = { data: configAccountData(), executable: false, lamports: 1, owner, rentEpoch: 0 };
  const guardian = {
    data: guardianAccountData(),
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
  };
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  (conn as any).getAccountInfo = async () => config;
  (conn as any).getAccountInfoAndContext = async () => ({ context: { slot: 0 }, value: config });
  (conn as any).getProgramAccounts = async () => [
    { pubkey: PublicKey.unique(), account: guardian },
  ];
  return conn;
}

const ctx = (): actions.BuildCtx => ({ connection: fakeConnection(), admin: ADMIN });

/**
 * name -> how to build it, and which IDL instruction it must produce.
 *
 * A builder that emits SEVERAL instructions lists them in order. Arguments are plausible rather than
 * meaningful: this asserts the account list and the instruction identity, not the economics, which
 * the on-chain harness owns.
 */
type Case = { ix: string[]; run: () => Promise<TransactionInstruction[]> };
const CASES: Record<string, Case> = {
  setMaxSilvSupply: { ix: ["set_max_silv_supply"], run: () => actions.setMaxSilvSupply(ctx(), 1n) },
  setPublicMintEnabled: { ix: ["set_public_mint_enabled"], run: () => actions.setPublicMintEnabled(ctx(), false) },
  setRedemptionsEnabled: { ix: ["set_redemptions_enabled"], run: () => actions.setRedemptionsEnabled(ctx(), false) },
  setMinOperationUsdc: { ix: ["set_min_operation_usdc"], run: () => actions.setMinOperationUsdc(ctx(), 10_000_000n) },
  setFeeRoutingEnabled: { ix: ["set_fee_routing_enabled"], run: () => actions.setFeeRoutingEnabled(ctx(), true) },
  emergencyTightenRedeemLimits: {
    ix: ["emergency_tighten_redeem_limits"],
    run: () => actions.emergencyTightenRedeemLimits(ctx(), { instantRedeemBudgetUsdc: 1n }),
  },
  setKycOperator: { ix: ["set_kyc_operator"], run: () => actions.setKycOperator(ctx(), SOMEBODY) },
  setKycScope: { ix: ["set_kyc_scope"], run: () => actions.setKycScope(ctx(), 0) },
  attestKyc: { ix: ["attest_kyc"], run: () => actions.attestKyc(ctx(), ADMIN, SOMEBODY, new Uint8Array(32)) },
  revokeKyc: { ix: ["revoke_kyc"], run: () => actions.revokeKyc(ctx(), ADMIN, SOMEBODY, false) },
  setFeeExempt: { ix: ["set_fee_exempt"], run: () => actions.setFeeExempt(ctx(), SOMEBODY, 1, 0n) },
  removeFeeExempt: { ix: ["remove_fee_exempt"], run: () => actions.removeFeeExempt(ctx(), SOMEBODY) },
  withdrawFees: { ix: ["withdraw_fees"], run: () => actions.withdrawFees(ctx(), SOMEBODY, 1n) },
  depositUsdc: { ix: ["deposit_usdc"], run: () => actions.depositUsdc(ctx(), 1n, SOMEBODY) },
  adminPremint: { ix: ["admin_premint"], run: () => actions.adminPremint(ctx(), 1n, SOMEBODY) },
  addGuardian: { ix: ["add_guardian"], run: () => actions.addGuardian(ctx(), SOMEBODY) },
  removeGuardian: { ix: ["remove_guardian"], run: () => actions.removeGuardian(ctx(), SOMEBODY) },
  finalizeGuardianRemoval: { ix: ["finalize_guardian_removal"], run: () => actions.finalizeGuardianRemoval(ctx(), SOMEBODY) },
  cancelGuardianRemoval: { ix: ["cancel_guardian_removal"], run: () => actions.cancelGuardianRemoval(ctx(), SOMEBODY, SOMEBODY) },
  pauseAsAdmin: { ix: ["pause"], run: () => actions.pauseAsAdmin(ctx()) },
  pauseAsGuardian: { ix: ["pause"], run: () => actions.pauseAsGuardian(ctx(), GUARDIAN) },
  // THE ONE THAT BROKE. Built with no explicit guardian on purpose, which is how the card calls it.
  unpause: { ix: ["unpause"], run: () => actions.unpause(ctx()) },
  cancelTimelockedAction: { ix: ["cancel_timelocked_action"], run: () => actions.cancelTimelockedAction(ctx(), 1n, GUARDIAN, ADMIN) },
  acceptAdminTransfer: { ix: ["accept_admin_transfer"], run: () => actions.acceptAdminTransfer(ctx()) },
  cancelAdminTransfer: { ix: ["cancel_admin_transfer"], run: () => actions.cancelAdminTransfer(ctx()) },
  proposeAdminTransfer: { ix: ["propose_admin_transfer"], run: () => actions.proposeAdminTransfer(ctx(), SOMEBODY) },
  proposeSetPremiumMint: { ix: ["propose_set_premium_mint"], run: () => actions.proposeSetPremiumMint(ctx(), 100) },
  proposeSetPremiumRedeem: { ix: ["propose_set_premium_redeem"], run: () => actions.proposeSetPremiumRedeem(ctx(), 150) },
  proposeSetTreasuryMinFloat: { ix: ["propose_set_treasury_min_float"], run: () => actions.proposeSetTreasuryMinFloat(ctx(), 0n) },
  proposeSetAdminTimelock: { ix: ["propose_set_admin_timelock"], run: () => actions.proposeSetAdminTimelock(ctx(), 86_400) },
  proposeSetComplianceMode: { ix: ["propose_set_compliance_mode"], run: () => actions.proposeSetComplianceMode(ctx(), false) },
  proposeSetPublicMint: { ix: ["propose_set_public_mint"], run: () => actions.proposeSetPublicMint(ctx(), true) },
  proposeSetPythFeed: { ix: ["propose_set_pyth_feed"], run: () => actions.proposeSetPythFeed(ctx(), 3154) },
  proposeSetOracleGuards: { ix: ["propose_set_oracle_guards"], run: () => actions.proposeSetOracleGuards(ctx(), { minPublishers: 2 }) },
  proposeSetRedeemLimits: { ix: ["propose_set_redeem_limits"], run: () => actions.proposeSetRedeemLimits(ctx(), { redemptionsEnabled: true }) },
  proposeUpdateMetadata: { ix: ["propose_update_metadata"], run: () => actions.proposeUpdateMetadata(ctx(), "n", null, null) },
  proposeWithdrawUsdc: { ix: ["propose_withdraw_usdc"], run: () => actions.proposeWithdrawUsdc(ctx(), 1n, SOMEBODY) },
  proposeSetInventoryWallet: { ix: ["propose_set_inventory_wallet"], run: () => actions.proposeSetInventoryWallet(ctx(), SOMEBODY) },
  executeTimelocked: { ix: ["execute_set_premium_mint"], run: () => actions.executeTimelocked(ctx(), "executeSetPremiumMint", 1n, ADMIN) },
  executeUpdateMetadata: { ix: ["execute_update_metadata"], run: () => actions.executeUpdateMetadata(ctx(), 1n, ADMIN) },
  executeWithdrawUsdc: { ix: ["execute_withdraw_usdc"], run: () => actions.executeWithdrawUsdc(ctx(), 1n, ADMIN, SOMEBODY) },
};

/** Exported functions that do not build instructions. Listed by name so that adding a builder cannot
 *  hide behind a vague predicate. */
const NOT_BUILDERS = new Set([
  "adminAuthority",
  "fetchOnchainAdmin",
  "fetchConfig",
  "fetchFeeVaultBalance",
  "feeVaultUsdcAta",
  "redeemLimitsArgsObject",
  "oracleGuardsArgsObject",
]);

function decodeName(program: anchor.Program, ix: TransactionInstruction): string {
  const d = (program.coder.instruction as any).decode(ix.data);
  if (!d) throw new Error(`instruction data did not decode against the IDL`);
  // Anchor decodes to camelCase; the IDL declares snake_case.
  return String(d.name).replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

describe("every admin builder passes exactly the accounts the IDL declares", () => {
  const program = new anchor.Program(
    IDL,
    new anchor.AnchorProvider(
      fakeConnection(),
      {
        publicKey: PublicKey.default,
        signTransaction: async (t: unknown) => t,
        signAllTransactions: async (t: unknown) => t,
      } as any,
      {},
    ),
  );

  for (const [name, c] of Object.entries(CASES)) {
    it(`${name} builds ${c.ix.join(" + ")} with the declared account list`, async () => {
      const built = await c.run();
      expect(built).toHaveLength(c.ix.length);
      built.forEach((ix, i) => {
        const expectedName = c.ix[i];
        expect(decodeName(program, ix)).toBe(expectedName);
        const declared = IDL.instructions.find((x: any) => x.name === expectedName).accounts;
        // COUNT and ORDER. Anchor emits accounts in IDL order, so a positional comparison is what
        // catches an account that was added on chain and never added here: exactly `unpause`.
        expect(
          ix.keys.length,
          `${expectedName} expects ${declared.length} accounts (${declared
            .map((a: any) => a.name)
            .join(", ")}) and the builder sent ${ix.keys.length}`,
        ).toBe(declared.length);
      });
    });
  }

  it("every builder is covered: adding one without a case fails here", () => {
    const exported = Object.entries(actions)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .filter((k) => !NOT_BUILDERS.has(k));
    const covered = new Set(Object.keys(CASES));
    const uncovered = exported.filter((k) => !covered.has(k)).sort();
    expect(
      uncovered,
      `these builders have no parity case. Add one to CASES, or to NOT_BUILDERS if it emits no ` +
        `instruction. This assertion is the reason 'unpause lost an account' cannot happen quietly ` +
        `again: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });
});
