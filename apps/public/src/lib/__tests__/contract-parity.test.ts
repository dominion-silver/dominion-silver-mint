/**
 * Parity between this client and the on-chain program.
 * Everything here exists because the batch of 2026-08-05 shipped four bugs of the same shape: the
 * program changed and the client kept using the old formula or the old account list, and NOTHING
 * caught it. The method builders go through `as any`, and `.accounts` is NOT strict in Anchor
 * 0.31.1 (it delegates to `accountsPartial`), so neither TypeScript nor Anchor rejects a wrong
 * account list. A test is the only mechanical guard on this path.
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
import {
  effectivePremiumBps,
  decodeFeeExemptFlags,
  decodeFeeExemptExpiry,
} from "../lazer-tx";
import { effectiveMintPrice, effectiveRedeemPrice, floor6 } from "../pyth";
import {
  mintSilvAccounts,
  redeemSilvAccounts,
  feeVaultUsdcAta,
  usable,
} from "../lazer-tx";
import { feeVaultPda, feeExemptPda, kycPda } from "../pdas";
import { USDC_MINT, TOKEN_PROGRAM_ID, PROGRAM_ID } from "../constants";
import {
  feeFromAmount,
  redeemGrossUsdc,
  redeemOutflowForGross,
  classifyRedeem,
  computeMaxInstantRedeemableUsdc,
  redeemUsdcOut,
  effectiveRedeemUsed,
  type ConfigAccount,
} from "../anchor-client";

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
  it("the minSilvOut the client SENDS is never above what the program mints", () => {
    // THE regression test, restated to assert what actually matters. An earlier version compared
    // the RAW EXACT quote against the program's output, which can never hold at dust amounts because
    // the program floors twice: at 1 atomic USDC the exact quote is 1.7e-8 SILV and the program mints
    // 0. That is not a defect, it is flooring.
    // The property that matters is the one the transaction carries: `minSilvOut`, after the client's
    // own flooring and slippage, must be <= what the program mints. Otherwise the program reverts
    // SlippageExceeded on a transaction that was fine.
    // This exercises `floor6` from the lib, i.e. the SAME function the builder uses. Reimplementing
    // the rounding here would prove nothing about the code that ships.
    for (const bps of ALL_BPS) {
      for (const slip of [10, 50, 100]) {
        for (const usdc of [
          0.000001, 0.000009, 0.01, 0.0288, 0.05, 1, 10, 100, 1_000, 10_000, 250_000,
        ]) {
          const quoted = usdc / effectiveMintPrice(SPOT_USD, bps);
          const minSilvOut = BigInt(
            Math.round(Number(floor6(quoted * (1 - slip / 10_000))) * 1e6),
          );
          const actual = contractMintSilvOut(
            BigInt(Math.round(usdc * 1e6)),
            SPOT_SCALED,
            bps,
          );
          expect(
            minSilvOut,
            `bps=${bps} slip=${slip} usdc=${usdc}: minSilvOut ${minSilvOut} > mints ${actual}`,
          ).toBeLessThanOrEqual(actual);
        }
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
  const user = new PublicKey("HXaptAcaXBoEAsNuEv4ZwYrciHbMxSpip2VScRVDjo1Z");
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

describe("optional-account validation (the dust-griefing P0)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disc = (name: string): Uint8Array =>
    Uint8Array.from(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (idl as any).accounts.find((a: any) => a.name === name).discriminator,
    );
  const FEE = disc("FeeExemptAccount");
  const KYC = disc("KycAccount");
  const data = (d: Uint8Array, len = 120) => {
    const b = new Uint8Array(len);
    b.set(d.slice(0, 8), 0);
    return b;
  };

  it("a genuine program-owned account of the right type is usable", () => {
    expect(usable({ owner: PROGRAM_ID, data: data(FEE) }, FEE)).toBe(true);
  });

  it("an absent account is not usable", () => {
    expect(usable(null, FEE)).toBe(false);
  });

  it("A DUSTED SYSTEM-OWNED ACCOUNT AT THE PDA IS NOT USABLE", () => {
    // THE regression test for the . Creating an account at a PDA address is permissionless: a
    // one-lamport SystemProgram.transfer to `feeExemptPda(victim)` makes a System-owned, zero-data
    // account there. The previous existence-only check reported it as an exemption, the builder
    // passed the real PDA, and the program reverted on the owner check -- so every mint and every
    // redeem from that wallet failed permanently, for the price of a dust transfer, with no
    // self-service remedy because nobody can sign for a PDA to close it.
    const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
    expect(usable({ owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }, FEE)).toBe(
      false,
    );
    // Also with a spoofed discriminator: the owner check must carry it alone.
    expect(usable({ owner: SYSTEM_PROGRAM, data: data(FEE) }, FEE)).toBe(false);
  });

  it("our account of the WRONG type is not usable", () => {
    // The discriminator must carry it alone, in case a future account type collides at an address.
    expect(usable({ owner: PROGRAM_ID, data: data(KYC) }, FEE)).toBe(false);
    expect(usable({ owner: PROGRAM_ID, data: data(FEE) }, KYC)).toBe(false);
  });

  it("a truncated account is not usable", () => {
    expect(usable({ owner: PROGRAM_ID, data: FEE.slice(0, 7) }, FEE)).toBe(false);
  });

  it("the two discriminators differ, so the type check is meaningful", () => {
    expect(Buffer.from(FEE).toString("hex")).not.toBe(
      Buffer.from(KYC).toString("hex"),
    );
  });
});

// --- the sliding window, ported vs the Rust -----------------------------------

/** Independent reimplementation of `state/redeem_window.rs::roll_window`.
 *  Deliberately written from the Rust rather than from the TypeScript port, because a test that
 *  calls the code under test proves nothing. This is the guard for the drift that shipped twice:
 *  the program moved to a sliding window and the client kept a fixed one, and nothing
 *  mechanical could catch it. */
function rustEffectiveUsed(
  now: number,
  windowStart: number,
  w: number,
  usedCurrent: bigint,
  usedPrev: bigint,
): bigint {
  if (w <= 0) return 0n;
  const elapsed = Math.max(0, now - windowStart);
  let start: number, current: bigint, prev: bigint;
  if (windowStart === 0) {
    [start, current, prev] = [now, usedCurrent, usedPrev];
  } else if (elapsed >= 2 * w) {
    [start, current, prev] = [now, 0n, 0n];
  } else if (elapsed >= w) {
    [start, current, prev] = [windowStart + w, 0n, usedCurrent];
  } else {
    [start, current, prev] = [windowStart, usedCurrent, usedPrev];
  }
  const into = Math.min(Math.max(0, now - start), w);
  return current + (prev * BigInt(w - into)) / BigInt(w);
}

describe("sliding window parity with the program", () => {
  const W = 86_400;
  const BUDGET = 20_000_000_000n;

  const cfg = (
    windowStart: number,
    used: bigint,
    prev: bigint,
  ): ConfigAccount =>
    ({
      paused: false,
      redemptionsEnabled: true,
      instantRedeemWindowSeconds: W,
      instantRedeemBudgetUsdc: new BN(BUDGET.toString()),
      instantWindowStart: new BN(windowStart),
      instantUsedUsdc: new BN(used.toString()),
      instantUsedPrevUsdc: new BN(prev.toString()),
      premiumBpsRedeem: 150,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any as ConfigAccount;

  it("agrees with the Rust across every branch and alignment", () => {
    const cases: [number, number, bigint, bigint][] = [
      [1_000, 0, 0n, 0n], // bootstrap sentinel
      [1_000, 1, 0n, 0n],
      [1_000, 1, BUDGET, 0n], // same bucket
      [1 + W, 1, BUDGET, 0n], // exactly one boundary
      [1 + W + 1, 1, BUDGET, 0n], // just past it: the case that used to read 0
      [1 + W + W / 2, 1, 0n, BUDGET], // half decayed
      [1 + 2 * W - 2, 1, BUDGET, 0n], // the near-2x alignment
      [1 + 10 * W, 1, BUDGET, BUDGET], // long gap
      [500, 5_000, BUDGET, BUDGET], // backwards clock
    ];
    for (const [now, start, used, prev] of cases) {
      const ts = BigInt(effectiveRedeemUsed(cfg(start, used, prev), now).toString());
      const rust = rustEffectiveUsed(now, start, W, used, prev);
      expect(ts, `now=${now} start=${start} used=${used} prev=${prev}`).toBe(rust);
    }
  });

  it("one second past a boundary counts the WHOLE previous bucket, not zero", () => {
    // THE regression test. The old client returned 0 here and told the user "redeems INSTANTLY";
    // the program counts almost all of the previous bucket and reverts RedeemLimitExceeded, after
    // the user has paid the Lazer verify fee.
    const used = effectiveRedeemUsed(cfg(1, BUDGET, 0n), 1 + W + 1);
    expect(BigInt(used.toString())).toBeGreaterThan((BUDGET * 999n) / 1000n);
  });
});

describe("the client must bound OUTFLOW, not the trade size", () => {
  // The original worked example, kept as the first case so a regression reproduces it exactly.
  const base = {
    paused: false,
    redemptionsEnabled: true,
    premiumBpsRedeem: 150,
    instantRedeemBudgetUsdc: new BN(98_500_000), // 98.50 USDC
    instantRedeemWindowSeconds: 86_400,
    instantUsedUsdc: new BN(0),
    instantUsedPrevUsdc: new BN(0),
    instantWindowStart: new BN(1_700_000_000),
    kycScopeFlags: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const NOW = 1_700_000_100;
  const TREASURY = new BN(98_500_000);
  const GROSS = new BN(100_000_000); // 100 USDC gross

  it("routing OFF: a redemption the chain would serve is NOT refused", () => {
    const cfg = { ...base, feeRoutingDisabled: true };
    // The program's arithmetic: to_user = 100 - ceil(100 * 150/1e4) = 98.50, fee_routed = 0,
    // so total_out = 98.50, which fits both the 98.50 budget and the 98.50 treasury exactly.
    expect(redeemOutflowForGross(cfg, GROSS).toString()).toBe("98500000");
    expect(classifyRedeem(cfg, TREASURY, GROSS, NOW, undefined)).toBe("instant");
  });

  it("routing ON: the same redemption IS over the limit, because the fee leg also leaves", () => {
    const cfg = { ...base, feeRoutingDisabled: false };
    expect(redeemOutflowForGross(cfg, GROSS).toString()).toBe("100000000");
    // 100 > 98.50 budget -> limit. This is the case the old code got right, and it must stay right:
    // the fix must not have swapped one wrong answer for another.
    expect(classifyRedeem(cfg, TREASURY, GROSS, NOW, undefined)).toBe("limit");
  });

  it("the treasury bound moves with the flag too, independently of the budget", () => {
    // Budget generous, treasury exactly the net. Routing off -> serveable; routing on -> otc.
    const wide = { ...base, instantRedeemBudgetUsdc: new BN(10_000_000_000) };
    expect(
      classifyRedeem({ ...wide, feeRoutingDisabled: true }, new BN(98_500_000), GROSS, NOW, undefined),
    ).toBe("instant");
    expect(
      classifyRedeem({ ...wide, feeRoutingDisabled: false }, new BN(98_500_000), GROSS, NOW, undefined),
    ).toBe("otc");
  });

  it("the advertised maximum is actually SERVEABLE, in both flag states", () => {
    // The version here accepted `["instant","otc"]`, and "otc" MEANS not-serveable, so
    // the treasury bound went unasserted while the comment claimed the opposite. Worse, it inverted
    // net->gross only in the routing-ON branch, so for routing OFF it submitted a strictly SMALLER
    // redemption than the advertised maximum and proved nothing about the boundary.
    // The UI divides by (1 - bps) in BOTH states (MintRedeemCard), so the gross a user submits to receive
    // the advertised net is the same computation either way. That is what this now exercises, and it
    // demands "instant" exactly.
    for (const flag of [true, false]) {
      const cfg = { ...base, feeRoutingDisabled: flag };
      const maxNet = computeMaxInstantRedeemableUsdc(cfg, TREASURY, NOW);
      // The gross that yields `maxNet` to the user, i.e. what the UI would build.
      const gross = flag
        ? maxNet.mul(new BN(10_000)).div(new BN(10_000 - base.premiumBpsRedeem))
        : maxNet.mul(new BN(10_000)).div(new BN(10_000 - base.premiumBpsRedeem));
      expect(
        classifyRedeem(cfg, TREASURY, gross, NOW, undefined),
        `the advertised max must route INSTANT, not otc/limit (routingDisabled=${flag})`,
      ).toBe("instant");
    }

    // And one atomic unit MORE than the advertised maximum must NOT be instant, or the advertised figure
    // is not a maximum. This is the half that catches an off-by-one in the other direction.
    for (const flag of [true, false]) {
      const cfg = { ...base, feeRoutingDisabled: flag };
      const maxNet = computeMaxInstantRedeemableUsdc(cfg, TREASURY, NOW);
      const grossJustOver = maxNet
        .mul(new BN(10_000))
        .div(new BN(10_000 - base.premiumBpsRedeem))
        .addn(2); // +2 atomic: +1 can be absorbed by the two floors on the way back
      expect(
        classifyRedeem(cfg, TREASURY, grossJustOver, NOW, undefined),
        `just over the advertised max must NOT be instant (routingDisabled=${flag})`,
      ).not.toBe("instant");
    }
  });
});

describe("the per-wallet premium mirrors the program", () => {
  // The IDL is the arbiter of the byte offsets the hand decoder uses. If a field is ever inserted into
  // FeeExemptAccount, this fails instead of the decoder silently reading the wrong bytes.
  it("the FeeExemptAccount layout the decoder derives matches the Rust struct exactly", () => {
    // RE-. This used to assert only the field NAMES and their ORDER, while the decoder hardcoded
    // byte offsets, and the round-trip test below rebuilt its buffer from those same literals. Circular:
    // widen `added_at` from i64 to i128 and every assertion stayed green while `expires_at` moved eight
    // bytes, so the app would read `added_by`/`version` as the expiry and show an active waiver as expired.
    // Two changes. The offsets are now DERIVED from the IDL's field TYPES (lazer-tx.ts), so a widened field
    // moves them automatically and an unknown type throws at module load. And this test pins the total
    // SIZE, which is what actually catches a widening that keeps names and order intact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ty = (idl as any).types?.find((t: any) => t.name === "FeeExemptAccount");
    expect(ty, "FeeExemptAccount must be in the IDL").toBeDefined();

    const W: Record<string, number> = {
      u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4,
      u64: 8, i64: 8, u128: 16, i128: 16, bool: 1, pubkey: 32,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const width = (t: any): number => {
      if (typeof t === "string") {
        expect(W[t], `unhandled IDL type ${t}`).toBeDefined();
        return W[t];
      }
      const [inner, len] = t.array as [string, number];
      return W[inner] * len;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const total = 8 + (ty.type.fields as any[]).reduce((n, f) => n + width(f.type), 0);
    // `FeeExemptAccount::SIZE` in state/fee_exempt.rs, asserted there against the same sum.
    expect(total, "the on-chain account size changed: the decoder's offsets move with it").toBe(114);

    // The field order still matters for a human reading the decoder, so keep it pinned too.
    expect((ty.type.fields as { name: string }[]).map((f) => f.name)).toEqual([
      "wallet",
      "flags",
      "added_at",
      "added_by",
      "version",
      "expires_at",
      "reserved",
    ]);
  });

  const NOW = 1_800_000_000;
  const LIVE = NOW + 86_400;

  it("waives only the side whose bit is set", () => {
    // flags 1 = mint only. The recommended grant: the redeem fee still closes any round trip.
    expect(effectivePremiumBps(100, 1, LIVE, "mint", NOW)).toBe(0);
    expect(effectivePremiumBps(150, 1, LIVE, "redeem", NOW)).toBe(150);
    // flags 2 = redeem only.
    expect(effectivePremiumBps(100, 2, LIVE, "mint", NOW)).toBe(100);
    expect(effectivePremiumBps(150, 2, LIVE, "redeem", NOW)).toBe(0);
    // flags 3 = both.
    expect(effectivePremiumBps(100, 3, LIVE, "mint", NOW)).toBe(0);
    expect(effectivePremiumBps(150, 3, LIVE, "redeem", NOW)).toBe(0);
  });

  it("charges the full premium once the term has lapsed", () => {
    expect(effectivePremiumBps(100, 3, NOW - 1, "mint", NOW)).toBe(100);
    expect(effectivePremiumBps(100, 3, NOW, "mint", NOW)).toBe(100); // expiry is exclusive
    expect(effectivePremiumBps(100, 3, NOW + 1, "mint", NOW)).toBe(0);
  });

  it("treats a ZERO expiry as expired, matching the contract after C-01", () => {
    // The Rust `is_expired` reads zero as dead. If the client read it as "never" it would quote 0%
    // and the program would charge the premium, minting less SILV than the quote promised, and
    // `minSilvOut` is derived from the same number so it becomes a hard SlippageExceeded.
    expect(effectivePremiumBps(100, 3, 0, "mint", NOW)).toBe(100);
  });

  it("falls back to the configured premium when the exemption is unknown", () => {
    expect(effectivePremiumBps(100, null, null, "mint", NOW)).toBe(100);
    expect(effectivePremiumBps(100, 3, null, "mint", NOW)).toBe(100);
    expect(effectivePremiumBps(100, null, LIVE, "mint", NOW)).toBe(100);
  });

  it("decodes flags and a signed i64 expiry out of the raw account bytes", () => {
    // Build the exact byte layout the program writes, then round-trip it.
    const buf = new Uint8Array(114);
    buf[8 + 32] = 3; // flags
    const off = 8 + 32 + 1 + 8 + 32 + 1;
    const v = BigInt(LIVE);
    for (let i = 0; i < 8; i++) buf[off + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    expect(decodeFeeExemptFlags(buf)).toBe(3);
    expect(decodeFeeExemptExpiry(buf)).toBe(LIVE);

    // A NEGATIVE i64 must decode negative, not as a huge positive. It would otherwise look like a
    // far-future expiry, i.e. a permanent exemption, which is precisely what removed.
    const neg = new Uint8Array(114);
    neg.fill(0xff, off, off + 8); // -1
    expect(decodeFeeExemptExpiry(neg)).toBe(-1);
    expect(effectivePremiumBps(100, 3, decodeFeeExemptExpiry(neg)!, "mint", NOW)).toBe(100);

    // Too-short data must not produce a confident answer.
    expect(decodeFeeExemptFlags(new Uint8Array(4))).toBeNull();
    expect(decodeFeeExemptExpiry(new Uint8Array(40))).toBeNull();
  });
});
