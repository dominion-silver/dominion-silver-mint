/**
 * `flagsMatchOwner` is the single place the "a snapshot must belong to the signer before anything is priced
 * from it" rule lives, and this is its test. Without it, reverting the check in both builders and in the
 * card leaves every other suite green.
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
    // A is connected, the user switches to B, SWR keeps serving A's entitlements until B's fetch settles.
    expect(flagsMatchOwner(snapshot(A), B)).toBe(false);
  });

  it("rejects absent and null snapshots rather than treating them as empty entitlements", () => {
    // `undefined` means NOT KNOWN, never "no exemption": the second reading is the fail-OPEN one.
    expect(flagsMatchOwner(undefined, A)).toBe(false);
    expect(flagsMatchOwner(null, A)).toBe(false);
  });

  it("is decided by the owner alone, not by whether the snapshot carries an exemption", () => {
    // A foreign empty snapshot is still foreign: B may hold an exemption A does not.
    expect(flagsMatchOwner(snapshot(A, null), B)).toBe(false);
    expect(flagsMatchOwner(snapshot(B, null), B)).toBe(true);
  });
});
