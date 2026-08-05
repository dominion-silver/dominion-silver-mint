/**
 * Parity between this client and the on-chain program.
 *
 * Everything here exists because the batch of 2026-08-05 shipped four bugs of the same shape: the
 * program changed and the client kept using the old formula or the old account list, and NOTHING
 * caught it. The method builders go through `as any`, and `.accounts()` is NOT strict in Anchor
 * 0.31.1 (it delegates to `accountsPartial`), so neither TypeScript nor Anchor rejects a wrong
 * account list. A test is the only mechanical guard on this path.
 *
 * The two classes covered:
 *   - PRICING: the client's quote must agree with the contract's integer arithmetic. A quote that
 *     promises more than the program mints becomes a SlippageExceeded revert.
 *   - ACCOUNT LISTS: the set the builder passes must match the set the IDL declares, exactly.
 */
import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../idl/dominion_silver_mint.json";
import { effectiveMintPrice, effectiveRedeemPrice } from "../pyth";
import { mintSilvAccounts, redeemSilvAccounts, feeVaultUsdcAta } from "../lazer-tx";
import { feeVaultPda, feeExemptPda, kycPda } from "../pdas";
import { USDC_MINT, TOKEN_PROGRAM_ID, PROGRAM_ID } from "../constants";
import { feeFromAmount, redeemGrossUsdc, redeemUsdcOut } from "../anchor-client";

// --- The contract's own arithmetic, reimplemented in integers. ---------------
// Mirrors math.rs. Deliberately a separate implementation rather than a call into the client
// helpers: a test that reuses the code under test proves nothing.

/** math.rs::fee_from_amount -- CEIL. */
function contractFee(amount: bigint, bps: number): bigint {
  if (bps === 0) return 0n;
  const d = 10_000n;
  return (amount * BigInt(bps) + (d - 1n)) / d;
}

/** mint_silv.rs step 7: fee off the top, then mint the remainder at PURE spot. */
function contractMintSilvOut(
  amountUsdc: bigint,
  spotScaled1e9: bigint,
  bps: number,
): bigint {
  const net = amountUsdc - contractFee(amountUsdc, bps);
  return (net * 1_000_000_000n) / spotScaled1e9; // floor
}

/** redeem_silv.rs step 4: gross at pure spot, fee off the top of the payout. */
function contractRedeemNet(
  amountSilv: bigint,
  spotScaled1e9: bigint,
  bps: number,
): bigint {
  const gross = (amountSilv * spotScaled1e9) / 1_000_000_000n;
  return gross - contractFee(gross, bps);
}

const SPOT_USD = 58.34;
const SPOT_SCALED = BigInt(Math.round(SPOT_USD * 1e9));
/** Every bps the program can be configured to, including both ceilings. */
const ALL_BPS = [0, 1, 50, 100, 150, 200, 300, 400, 500];

describe("mint pricing parity", () => {
  it("the client quote never promises more SILV than the program mints", () => {
    // THE regression test for B4. `effectiveMintPrice` returned `spot * (1 + bps/1e4)` until
    // 2026-08-05, which over-quotes by exactly bps^2/1e8 because the program takes the fee off
    // the top and mints the remainder at pure spot. Over-quoting is the dangerous direction: the
    // quote feeds minSilvOut, and a minSilvOut above what the program mints is a hard revert.
    for (const bps of ALL_BPS) {
      for (const usdc of [1, 10, 100, 1_000, 10_000, 250_000]) {
        const amountAtomic = BigInt(Math.round(usdc * 1e6));
        const quoted = usdc / effectiveMintPrice(SPOT_USD, bps);
        const actual =
          Number(contractMintSilvOut(amountAtomic, SPOT_SCALED, bps)) / 1e6;
        expect(
          quoted,
          `bps=${bps} usdc=${usdc}: quote ${quoted} > actual ${actual}`,
        ).toBeLessThanOrEqual(actual + 1e-6);
      }
    }
  });

  it("the client quote is not wastefully pessimistic either", () => {
    // Guard the other direction so a future "fix" cannot just subtract a safety margin: the quote
    // must stay within a hundredth of a percent of what the program actually mints.
    for (const bps of ALL_BPS) {
      const usdc = 10_000;
      const quoted = usdc / effectiveMintPrice(SPOT_USD, bps);
      const actual =
        Number(contractMintSilvOut(BigInt(usdc * 1e6), SPOT_SCALED, bps)) / 1e6;
      expect(Math.abs(quoted - actual) / actual).toBeLessThan(0.0001);
    }
  });

  it("a mint at the 500 bps ceiling survives the tightest slippage setting", () => {
    // The concrete failure the old formula produced: the slippage selector's minimum is 10 bps,
    // and the old quote drifted 25 bps at the ceiling, so ABOVE ~317 bps EVERY mint reverted
    // SlippageExceeded. The premium is 24h-timelock changeable, so that was one executed
    // proposal away from breaking mint entirely.
    const TIGHTEST_SLIPPAGE_BPS = 10;
    for (const bps of ALL_BPS) {
      const usdc = 1_000;
      const quoted = usdc / effectiveMintPrice(SPOT_USD, bps);
      const minSilvOut = quoted * (1 - TIGHTEST_SLIPPAGE_BPS / 10_000);
      const actual =
        Number(contractMintSilvOut(BigInt(usdc * 1e6), SPOT_SCALED, bps)) / 1e6;
      expect(
        actual,
        `bps=${bps}: program mints ${actual} but minSilvOut is ${minSilvOut} -> SlippageExceeded`,
      ).toBeGreaterThanOrEqual(minSilvOut);
    }
  });
});

describe("redeem pricing parity", () => {
  it("effectiveRedeemPrice still matches the contract after the fee-routing change", () => {
    // Asserted rather than assumed. The redeem side did NOT need fixing (the fee is on the
    // output, so `spot * (1 - bps/1e4)` is still exact), but that is only true by coincidence of
    // form and it deserves a pin.
    for (const bps of ALL_BPS) {
      const silv = 100;
      const quoted = silv * effectiveRedeemPrice(SPOT_USD, bps);
      const actual =
        Number(contractRedeemNet(BigInt(silv * 1e6), SPOT_SCALED, bps)) / 1e6;
      expect(Math.abs(quoted - actual)).toBeLessThan(0.01);
    }
  });

  it("the BN helpers agree with the contract exactly, unit for unit", () => {
    for (const bps of ALL_BPS) {
      for (const silv of [1, 7, 100, 5_000]) {
        const atomic = BigInt(Math.round(silv * 1e6));
        const gross = redeemGrossUsdc(
          new BN(atomic.toString()),
          new BN(SPOT_SCALED.toString()),
        );
        const net = redeemUsdcOut(
          new BN(atomic.toString()),
          new BN(SPOT_SCALED.toString()),
          bps,
        );
        expect(gross.toString()).toBe(
          ((atomic * SPOT_SCALED) / 1_000_000_000n).toString(),
        );
        expect(net.toString()).toBe(
          contractRedeemNet(atomic, SPOT_SCALED, bps).toString(),
        );
      }
    }
  });

  it("feeFromAmount ceils, so a caller cannot shave the fee with dust", () => {
    expect(feeFromAmount(new BN(1), 100).toString()).toBe("1");
    expect(feeFromAmount(new BN(7), 150).toString()).toBe("1");
    expect(feeFromAmount(new BN(10_000), 100).toString()).toBe("100");
    expect(feeFromAmount(new BN(1_000_000), 0).toString()).toBe("0");
  });
});

// --- Account lists ----------------------------------------------------------

function idlAccountNames(ixName: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ix = (idl as any).instructions.find((i: any) => i.name === ixName);
  if (!ix) throw new Error(`${ixName} is not in the IDL`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ix.accounts.map((a: any) =>
    a.name.replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase()),
  );
}

describe("account list parity", () => {
  const user = new PublicKey("6bgSnXYg11BWnGRc3R7xenDPCqt2xu2YswkzQGr4AoYh");
  const none = { feeExempt: null, kyc: null };

  it("mintSilvAccounts covers exactly the IDL's mint_silv accounts", () => {
    // This is the guard that was missing. A new required account on the program side now fails
    // here instead of failing in front of a user at signing time, and an account that is dropped
    // from the builder fails here instead of being silently derived by the resolver.
    const expected = idlAccountNames("mint_silv").sort();
    const actual = Object.keys(mintSilvAccounts(user, none)).sort();
    expect(actual).toEqual(expected);
  });

  it("redeemSilvAccounts covers exactly the IDL's redeem_silv accounts", () => {
    const expected = idlAccountNames("redeem_silv").sort();
    const actual = Object.keys(redeemSilvAccounts(user, none)).sort();
    expect(actual).toEqual(expected);
  });

  it("the fee vault is the OFF-CURVE ATA of the fee_vault PDA", () => {
    // allowOwnerOffCurve = true is mandatory because the owner is a PDA. Getting it wrong throws
    // TokenOwnerOffCurveError, which has already cost this project a debugging session on the
    // treasury ATA.
    expect(feeVaultUsdcAta().toBase58()).toBe(
      getAssociatedTokenAddressSync(
        USDC_MINT,
        feeVaultPda(),
        true,
        TOKEN_PROGRAM_ID,
      ).toBase58(),
    );
    expect(PublicKey.isOnCurve(feeVaultPda().toBytes())).toBe(false);
  });

  it("absent optional accounts are null, which Anchor encodes as the program id", () => {
    // NOT the PDA address. Passing the address of an account that does not exist makes the
    // program try to deserialize it and revert AccountNotInitialized. This is exactly what broke
    // the e2e mint script.
    const a = mintSilvAccounts(user, none);
    expect(a.feeExempt).toBeNull();
    expect(a.kyc).toBeNull();
  });

  it("present optional accounts are the wallet-seeded PDAs", () => {
    const a = mintSilvAccounts(user, {
      feeExempt: feeExemptPda(user),
      kyc: kycPda(user),
    });
    expect(a.feeExempt?.toBase58()).toBe(feeExemptPda(user).toBase58());
    expect(a.kyc?.toBase58()).toBe(kycPda(user).toBase58());
    // Seeded from the USER, so they cannot be another wallet's.
    const other = PublicKey.unique();
    expect(feeExemptPda(user).toBase58()).not.toBe(
      feeExemptPda(other).toBase58(),
    );
  });

  it("the removed queued-redemption instructions are gone from the IDL", () => {
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
    expect(PROGRAM_ID.toBase58()).toBe((idl as any).address);
  });
});
