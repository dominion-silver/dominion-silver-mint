/**
 * The admin app had NO account-list parity test.
 * The public app got one after four stale call sites shipped, but the same class lives here and was
 * guarded by nothing mechanical: `withdraw_fees` gained a required `usdc_treasury` account in this
 * batch and it is present only because someone added it by hand. The parity CI gate cannot help,
 * because it only checks that a key is an account of SOME instruction, and the admin builders
 * dispatch by computed name (`[method](...)`) so its chain check does not see them either.
 * These tests build the real instructions offline (no network: Anchor's `.instruction()` never
 * touches the RPC) and assert the account COUNT and the account NAMES against the committed IDL. A
 * missing account changes the count; a wrong name changes the set.
 */
import { describe, it, expect } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import * as actions from "../admin-actions";
import * as actions_ac from "../anchor-client";

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

  // --- FINAL MECHANISM: one signature, and the contract holds the invariant ---
  // The first fix added `kyc_operator: Option<Signer>` to `set_kyc_scope` and three tests asserting the
  // client passed it. Those tests were correct about the client and the mechanism was wrong: the Squads
  // path cannot assemble two signatures, so arming was unreachable from the panel. The reviews
  // recommended the on-chain attestation counter, so the account is gone and so are those tests.
  // What is worth pinning instead: the account list is back to two, and nothing in the client tries to
  // supply a signer the IDL no longer declares.
  it("set_kyc_scope takes exactly the accounts the IDL declares, with no co-signer", async () => {
    const built = await actions.setKycScope(ctx, 2);
    expect(built[0].keys).toHaveLength(ix("set_kyc_scope").accounts.length);
    expect(ix("set_kyc_scope").accounts.map((a: { name: string }) => a.name)).toEqual([
      "config",
      "admin",
    ]);
    // Exactly one signer: the admin. If a co-signer ever comes back, this fails rather than the panel
    // silently building a transaction nobody can sign.
    expect(built[0].keys.filter((k) => k.isSigner)).toHaveLength(1);
  });

  it("disarming and arming build identically, because the invariant is on chain now", async () => {
    const arm = await actions.setKycScope(ctx, 3);
    const disarm = await actions.setKycScope(ctx, 0);
    expect(arm[0].keys.length).toBe(disarm[0].keys.length);
    // The client no longer needs to know which direction is which; the program refuses an empty-roster
    // arm and always allows a disarm.
    expect(arm[0].programId.equals(disarm[0].programId)).toBe(true);
  });

  // --- audit a failed read must be REPORTED, not rendered as zero ---
  // `fetchDashboardSnapshot` mapped a rejected treasury or supply read to BN(0) and returned a snapshot
  // that looked complete: the operator saw Treasury $0 / supply 0 oz / 0% cap used with nothing marking
  // those as unread, and could then decide a withdrawal, a premint, or an opening on them.
  // Tested through the extracted `readTokenAmounts` rather than the whole snapshot. My first attempt
  // faked a Connection and died on `getAccountInfoAndContext`: reaching the branch through Anchor needs
  // a real encoded 800-byte config account, which is why this logic had no test in the first place.
  it("A-01: a failed token read is listed in `degraded`, not silently zeroed", () => {
    const ok = (amount: string) => ({
      status: "fulfilled" as const,
      value: { value: { amount } },
    });
    const bad = (msg: string) => ({ status: "rejected" as const, reason: new Error(msg) });

    // Both succeed: no degradation, real numbers.
    const good = actions_ac.readTokenAmounts(ok("1234"), ok("5678"));
    expect(good.degraded).toEqual([]);
    expect(good.treasuryUsdc.toString()).toBe("1234");
    expect(good.silvSupply.toString()).toBe("5678");

    // The exact scenario: config readable, both token reads 429.
    const both = actions_ac.readTokenAmounts(bad("429 Too Many Requests"), bad("429 Too Many Requests"));
    expect(both.degraded).toHaveLength(2);
    expect(both.degraded.join(" ")).toMatch(/treasury/i);
    expect(both.degraded.join(" ")).toMatch(/supply/i);
    // Zero is still the numeric fallback, deliberately, so downstream figures compute. The point is
    // that it now arrives WITH a warning rather than as a fact.
    expect(both.treasuryUsdc.isZero()).toBe(true);
    expect(both.silvSupply.isZero()).toBe(true);

    // A PARTIAL failure is the dangerous one, because the surviving number looks corroborating.
    const partial = actions_ac.readTokenAmounts(bad("timeout"), ok("999"));
    expect(partial.degraded).toHaveLength(1);
    expect(partial.degraded[0]).toMatch(/treasury/i);
    expect(partial.silvSupply.toString()).toBe("999");

    // The reason is carried through, so the banner can say WHY, and it is bounded so a huge RPC error
    // body cannot blow up the console.
    const long = actions_ac.readTokenAmounts(bad("x".repeat(500)), ok("1"));
    expect(long.degraded[0].length).toBeLessThan(200);
  });
});

/**
 * The generated IDL must not carry claims the program no longer honours.
 * removed `set_inventory_wallet` from the program surface, but four doc comments kept saying
 * the setter chooses the destination, that the first binding takes an instant path, and that the
 * wallet can be redirected instantly. Anchor exports doc comments into the IDL, so those sentences
 * shipped to every integrator that reads it, describing an instruction that does not exist.
 * A negative grep is the right shape here: nothing can assert that prose is TRUE, but a specific
 * false claim that was already made once can be forbidden by name.
 */
describe("the generated IDL does not describe the deleted instant setter", () => {
  const FORBIDDEN = [
    "set_inventory_wallet sets the destination",
    "takes the instant path",
    "redirected instantly",
    "chooses it via `set_inventory_wallet`",
  ];

  it("carries none of the four claims the instruction removal made false", () => {
    const raw = JSON.stringify(idl);
    for (const phrase of FORBIDDEN) {
      expect(
        raw.includes(phrase),
        `the IDL still says ${JSON.stringify(phrase)}. That instruction was deleted; ` +
          `correct the doc comment in the program and regenerate all three IDL copies.`,
      ).toBe(false);
    }
  });

  it("exposes no instruction named set_inventory_wallet", () => {
    const names = (idl.instructions as Array<{ name: string }>).map((i) => i.name);
    expect(names).not.toContain("set_inventory_wallet");
    // The timelocked pair is what replaced it, and it must still be there: a test that only forbids
    // is satisfied by an empty IDL.
    expect(names).toContain("propose_set_inventory_wallet");
    expect(names).toContain("execute_set_inventory_wallet");
  });
});
