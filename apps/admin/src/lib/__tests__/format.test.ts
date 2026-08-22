import { describe, it, expect } from "vitest";
import BN from "bn.js";
import { formatSilv, formatUsdc } from "../anchor-client";

// review of daac4ac: formatSilv had NO test coverage, and the rewrite that
// removed one bug (BN.toNumber() throwing above 2^53) introduced another (a rounding
// carry that displayed 1.999999 as "1.1"). All three reviewers found it
// independently. These are the cases that distinguish the two implementations.
describe("formatSilv", () => {
  const f = (raw: string) => formatSilv(new BN(raw));

  it("renders whole ounces without a decimal point", () => {
    expect(f("1000000")).toBe("1");
    expect(f("3000000000")).toBe("3,000");
    expect(f("0")).toBe("0");
  });

  it("renders simple fractions", () => {
    expect(f("1500000")).toBe("1.5");
    expect(f("1250000")).toBe("1.25");
    expect(f("100")).toBe("0.0001");
  });

  it("does NOT carry a near-whole fraction into the wrong digit", () => {
    // The regression: Math.round(999999/100) = 10000 -> padStart(4) -> "10000"
    // -> trailing-zero strip -> "1". Reported ~0.9 oz low, silently.
    expect(f("1999999")).toBe("1.999999");
    expect(f("1999950")).toBe("1.99995");
    expect(f("999999")).toBe("0.999999");
    expect(f("5999995")).toBe("5.999995");
  });

  it("is exact to the mint's full 6 decimals", () => {
    expect(f("1000001")).toBe("1.000001");
    expect(f("1999949")).toBe("1.999949");
  });

  it("handles the live devnet and launch-cap magnitudes", () => {
    expect(f("100000000000")).toBe("100,000"); // the 100k oz launch cap
    expect(f("3000000000")).toBe("3,000"); // live devnet supply
  });

  it("does not throw above 2^53 atomic units (the original A-29 bug)", () => {
    // 1e15 atomic = MAX_SILV_SUPPLY_CEILING, which is over 2^53 ~ 9.007e15? No:
    // 1e15 < 9.007e15, so pin something unambiguously past the boundary too.
    expect(() => f("1000000000000000")).not.toThrow();
    expect(() => f("99999999999999999999")).not.toThrow();
    expect(f("1000000000000000")).toBe("1,000,000,000");
  });

  it("renders negatives with a single leading sign", () => {
    expect(f("-1500000")).toBe("-1.5");
    expect(f("-1999999")).toBe("-1.999999");
  });
});

// formatUsdc was fixed and reviewed in the previous batch. Pinning the same
// boundary class here so the two formatters cannot drift apart again.
describe("formatUsdc", () => {
  const f = (raw: string) => formatUsdc(new BN(raw));

  // No currency symbol: callers add "$" themselves. Pinned so a future "helpful"
  // prefix cannot silently double up at every call site.
  it("renders cents exactly, including the carry boundary", () => {
    expect(f("0")).toBe("0.00");
    expect(f("1000000")).toBe("1.00");
    expect(f("1999999")).toBe("2.00"); // carries into the whole part
    expect(f("999999")).toBe("1.00"); // carries 0 -> 1
    expect(f("1005000")).toBe("1.01");
  });

  it("groups thousands", () => {
    expect(f("1234567890")).toBe("1,234.57");
  });
});
