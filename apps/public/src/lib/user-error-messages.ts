/**
 * ROUND 8 T8-07. The user-facing mapping for a failed mint or redeem, EXTRACTED so it can be tested.
 *
 * It lived inline in `MintRedeemCard.tsx`'s catch block, which meant the only way to exercise it was
 * to render the component and drive a wallet. So the wording of what a user is told after losing
 * money to a revert was never asserted by anything.
 *
 * The extraction is behaviour-preserving on purpose: the strings below are moved, not rewritten, so
 * the test that follows fails on the TEXT rather than on the refactor. The card imports and calls
 * this, so the test drives the same function the product does.
 */
import {
  errorToText,
  isStaleOracleError,
  isLazerReplayedError,
  isLazerCarriedForwardError,
  isBelowMinimumError,
  parseRedeemError,
  STALE_ORACLE_USER_MESSAGE,
} from "./anchor-client";

export type OperationMode = "mint" | "redeem";

/**
 * Turn any thrown value into the sentence the user reads.
 *
 * `flat` is the FLATTENED error: message plus program logs plus the structured `onChainErr`. A
 * transaction that was confirmed and then reverted carries its signal in the logs, never in
 * `.message`, which is why every predicate below reads the flattened form.
 */
export function mapUserFacingError(
  e: unknown,
  mode: OperationMode,
  otcEmail: string,
): string {
  // ROUND 8 T8-07. Every branch below fires on a PROGRAM error, which means the transaction was
  // executed by the cluster and then reverted. The fee payer paid the base fee and any priority fee;
  // only the state changes rolled back. The previous copy said "Nothing was charged", which is true
  // of a preflight refusal and false here. The principal really is untouched, so that reassurance
  // stays, but the fee is now disclosed instead of denied.
  const msg = e instanceof Error ? e.message : String(e);
  const flat = errorToText(e);
  const reroute = mode === "redeem" ? parseRedeemError(flat) : null;

  return isStaleOracleError(flat)
    ? STALE_ORACLE_USER_MESSAGE
    : isLazerReplayedError(flat)
      ? "Another transaction used the same price update a moment before yours. No SILV and no USDC moved, though network fees may still apply. Try again, and a fresh price will be fetched."
      : isLazerCarriedForwardError(flat)
        ? "The silver price feed has not published a new value yet. No SILV and no USDC moved, though network fees may still apply. Wait a few seconds rather than retrying immediately."
        : isBelowMinimumError(flat)
          ? "That amount is below the protocol's minimum operation size. No SILV and no USDC moved, though network fees may still apply. Try a larger amount."
          : reroute === "limit"
            ? "The protocol's rolling redemption limit for this window is used up. Your SILV was not touched. Retry after the window rolls, or redeem less."
            : reroute === "kyc"
              ? `This wallet needs identity verification before it can redeem. Contact ${otcEmail}.`
              : reroute === "otc"
                ? `Treasury can't cover this now. Redeem via OTC: ${otcEmail}.`
                : reroute === "disabled"
                  ? "Redemptions are disabled / paused."
                  : msg;
}
