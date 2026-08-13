/**
 * ROUND 8 T8-07. What a user is told after a CONFIRMED-then-REVERTED financial transaction.
 *
 * The distinction that matters: a transaction refused at PREFLIGHT never lands, so it costs nothing.
 * A transaction that lands and then reverts HAS been executed by the cluster: the fee payer paid the
 * base fee and any priority fee, and only the instruction's state changes were rolled back.
 *
 * `lazer-execute.ts:155-162` builds exactly the second shape: it reads `confirmTransaction`'s
 * `value.err`, refetches the transaction for its logs, and throws
 * `Object.assign(new Error("Transaction reverted on-chain"), { logs, onChainErr })`. That is the
 * object this test feeds in, unmodified in shape, so the assertions run against the real path:
 * `errorToText` flattens it, then `mapUserFacingError` (the function `MintRedeemCard.tsx`'s catch
 * calls) picks the sentence.
 *
 * Telling that user "Nothing was charged" is false. Their principal is intact, which is the reassuring
 * part and must be said, but they did pay network fees. A protocol that misstates a fee, however
 * small, teaches its users that its financial statements are approximate.
 *
 * Both program errors are driven twice: once with the Anchor NAME in the logs (the parsed path) and
 * once with only the raw `Custom:<code>` in the structured `onChainErr` (the path where the IDL was
 * not consulted). Both must reach the same sentence, because the shape that reaches the browser
 * depends on how far the RPC got, not on which error it was.
 */
import { describe, it, expect } from "vitest";
import { errorToText } from "../anchor-client";
import { mapUserFacingError } from "../user-error-messages";

const OTC_EMAIL = "mark@dominion.market";

/** Reproduce `lazer-execute.ts:155-162` byte-for-byte in shape: message, logs, structured err. */
function revertedOnChain(logs: string[], customCode: number): Error {
  return Object.assign(new Error("Transaction reverted on-chain"), {
    logs,
    onChainErr: { InstructionError: [0, { Custom: customCode }] },
  });
}

/** The named path: the RPC returned logs and Anchor's own line naming the error. */
function byName(name: string, code: number): Error {
  return revertedOnChain(
    [
      "Program 3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ invoke [1]",
      "Program log: Instruction: MintSilv",
      `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: ${name}.`,
      "Program 3ucji6JDQsbuicvNaPfFeHh9diAjTx5kqEjEZzaZ5ZNQ failed: custom program error: 0x" +
        code.toString(16),
    ],
    code,
  );
}

/** The unnamed path: logs were not retrievable, only the structured `Custom:<code>` survived. */
function byCode(code: number): Error {
  return revertedOnChain([], code);
}

const CASES = [
  { label: "LazerReplayed by name", err: byName("LazerReplayed", 12121), verb: "Try again" },
  { label: "LazerReplayed by Custom code", err: byCode(12121), verb: "Try again" },
  {
    label: "LazerCarriedForward by name",
    err: byName("LazerCarriedForward", 12082),
    verb: "Wait",
  },
  { label: "LazerCarriedForward by Custom code", err: byCode(12082), verb: "Wait" },
] as const;

describe("Lazer failure messages after an on-chain revert", () => {
  for (const mode of ["mint", "redeem"] as const) {
    for (const c of CASES) {
      it(`${c.label} (${mode}) states the fee truthfully`, () => {
        const message = mapUserFacingError(c.err, mode, OTC_EMAIL);

        // The reassurance that is TRUE: the principal never moved.
        expect(
          /no SILV/i.test(message) && /no USDC/i.test(message),
          `expected message to state that neither SILV nor USDC principal moved\nreceived ${JSON.stringify(message)}`,
        ).toBe(true);

        // The disclosure that is REQUIRED: the transaction executed, so fees were paid.
        expect(
          message,
          `expected message to contain "network fees may still apply"\nreceived ${JSON.stringify(message)}`,
        ).toContain("network fees may still apply");

        // The claim that is FALSE for a landed transaction.
        expect(
          message,
          `message must not claim nothing was charged after an on-chain revert\nreceived ${JSON.stringify(message)}`,
        ).not.toContain("Nothing was charged");

        // The remediations stay OPPOSITE: replay is contention, carry-forward is a stalled feed.
        expect(message).toContain(c.verb);
      });
    }
  }

  it("both errors are actually recognised in both shapes (guards against a vacuous pass)", () => {
    for (const c of CASES) {
      const flat = errorToText(c.err);
      expect(flat.length, `${c.label}: flattened to nothing`).toBeGreaterThan(0);
      expect(
        mapUserFacingError(c.err, "mint", OTC_EMAIL),
        `${c.label}: fell through to the raw error message, so no mapping ran`,
      ).not.toBe("Transaction reverted on-chain");
    }
  });
});
