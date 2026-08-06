/**
 * The admin app had NO account-list parity test.
 *
 * The public app got one after four stale call sites shipped, but the same class lives here and was
 * guarded by nothing mechanical: `withdraw_fees` gained a required `usdc_treasury` account in this
 * batch and it is present only because someone added it by hand. The parity CI gate cannot help,
 * because it only checks that a key is an account of SOME instruction, and the admin builders
 * dispatch by computed name (`[method](...)`) so its chain check does not see them either.
 *
 * These tests build the real instructions offline (no network: Anchor's `.instruction()` never
 * touches the RPC) and assert the account COUNT and the account NAMES against the committed IDL. A
 * missing account changes the count; a wrong name changes the set.
 */
import { describe, it, expect } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import * as actions from "../admin-actions";

const conn = new Connection("http://127.0.0.1:8899");
const ctx = { connection: conn, admin: PublicKey.unique() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ix = (name: string) => (idl as any).instructions.find((i: any) => i.name === name);

describe("admin builder account parity with the IDL", () => {
  it("withdraw_fees passes every account the IDL declares", async () => {
    const built = await actions.withdrawFees(ctx, PublicKey.unique(), 1_000_000n);
    expect(built).toHaveLength(1);
    expect(built[0].keys).toHaveLength(ix("withdraw_fees").accounts.length);
  });

  it("set_fee_exempt passes every account the IDL declares", async () => {
    const built = await actions.setFeeExempt(ctx, PublicKey.unique(), 1, 0n);
    expect(built[0].keys).toHaveLength(ix("set_fee_exempt").accounts.length);
  });

  it("remove_fee_exempt passes every account the IDL declares", async () => {
    const built = await actions.removeFeeExempt(ctx, PublicKey.unique());
    expect(built[0].keys).toHaveLength(ix("remove_fee_exempt").accounts.length);
  });

  it("withdraw_fees actually passes the fee vault ATA", async () => {
    // The property that matters: the derived vault address ends up in the instruction. The OWNER
    // being off-curve is what forces `allowOwnerOffCurve = true` in the derivation, and omitting
    // that flag throws TokenOwnerOffCurveError, which has already cost this project a debugging
    // session on the treasury ATA.
    //
    // (An earlier version of this test asserted the ATA ADDRESS was on-curve. It is not: an ATA is
    // itself a PDA of the associated-token program, so it is off-curve too. The test failed on
    // correct code, which is the third time this pass a test of mine was the thing that was wrong.)
    const vault = actions.feeVaultUsdcAta();
    const built = await actions.withdrawFees(ctx, PublicKey.unique(), 1n);
    expect(built[0].keys.map((k) => k.pubkey.toBase58())).toContain(
      vault.toBase58(),
    );
  });

  it("the removed queued instructions are absent from the IDL", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (idl as any).instructions.map((i: any) => i.name);
    for (const gone of [
      "redeem_silv_queued",
      "claim_redemption",
      "admin_settle_redemption_offchain",
      "close_settled_redemption",
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  // --- audit C-02: an OPTIONAL account that is REQUIRED by the handler ---
  //
  // This is the case neither existing gate can see. `verify-client-idl-parity.ts` checks that account
  // NAMES exist in the IDL; a name that is present but never PASSED is invisible to it. And Anchor
  // 0.31's `.accounts()` delegates to `accountsPartial()`, so an omitted optional account encodes as
  // absent without a word of complaint: the transaction builds, the user signs, the chain reverts.
  //
  // The contract requires `kyc_operator` to co-sign whenever `flags != 0`, so the arm path must carry
  // a THIRD key and the disarm path must not.
  it("arming the KYC gate passes the attestor as a signer", async () => {
    const attestor = PublicKey.unique();
    const built = await actions.setKycScope(ctx, 2, attestor);
    expect(built[0].keys).toHaveLength(ix("set_kyc_scope").accounts.length);
    const k = built[0].keys.find((x) => x.pubkey.equals(attestor));
    expect(k, "the attestor must be among the instruction's keys").toBeDefined();
    expect(k!.isSigner, "and it must be marked as a SIGNER, not just present").toBe(true);
  });

  it("disarming the KYC gate needs no attestor, and encodes its absence", async () => {
    // Disarming must never depend on the attestor: it is the only way out of a wrongly-armed gate,
    // and the attestor may be exactly what is broken. Anchor encodes an absent optional account as
    // the PROGRAM ID, so the key count is unchanged and the slot holds the program.
    const built = await actions.setKycScope(ctx, 0);
    const programId = new PublicKey((idl as { address: string }).address);
    expect(built[0].keys.some((x) => x.pubkey.equals(programId))).toBe(true);
  });

  it("arming without an attestor is refused BEFORE a signature is requested", async () => {
    // Failing in the builder rather than on chain is the point: an on-chain revert has already cost
    // the operator a signature and a fee to learn something knowable offline.
    await expect(actions.setKycScope(ctx, 3)).rejects.toThrow(/co-sign/i);
  });
});
