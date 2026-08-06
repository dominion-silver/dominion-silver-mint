/**
 * REVIEW-OF-FIXES P2. The round-3 P1 fix (a snapshot must belong to the signer before anything is priced
 * from it) shipped as three copies of the same expression and ZERO tests. The reviewer reverted the check
 * in both builders AND in the card and measured 60/60 public plus 25/25 admin still green.
 *
 * The predicate now lives in one place and this is that place's test.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { flagsMatchOwner, type WalletFlags } from "../lazer-tx";

const A = new PublicKey("11111111111111111111111111111112");
const B = new PublicKey("SysvarC1ock11111111111111111111111111111111");

function snapshot(owner: PublicKey, feeExempt: WalletFlags["feeExempt"] = null): WalletFlags {
  return { owner, feeExempt, kyc: null, feeExemptFlags: null, feeExemptExpiresAt: null } as WalletFlags;
}

describe("a wallet-flags snapshot is only usable for the wallet it describes", () => {
  it("accepts its own owner", () => {
    expect(flagsMatchOwner(snapshot(A), A)).toBe(true);
  });

  it("REJECTS the previous wallet's snapshot, which is what keepPreviousData serves", () => {
    // The exact round-3 P1 shape: wallet A is connected, the user switches to B, SWR keeps serving A's
    // entitlements until B's fetch settles. Pricing B's transaction from A's exemptions is the bug.
    expect(flagsMatchOwner(snapshot(A), B)).toBe(false);
  });

  it("rejects absent and null snapshots rather than treating them as empty entitlements", () => {
    // `undefined` must mean NOT KNOWN, never "no exemption": the second reading is the fail-OPEN one, and
    // it is the reading that makes the quote and the transaction disagree.
    expect(flagsMatchOwner(undefined, A)).toBe(false);
    expect(flagsMatchOwner(null, A)).toBe(false);
  });

  it("is decided by the owner alone, not by whether the snapshot carries an exemption", () => {
    // A foreign snapshot that happens to be empty is still foreign: B may hold an exemption that A does
    // not, and quoting B off A's empty snapshot is the redeem-budget revert.
    expect(flagsMatchOwner(snapshot(A, null), B)).toBe(false);
    expect(flagsMatchOwner(snapshot(B, null), B)).toBe(true);
  });
});
