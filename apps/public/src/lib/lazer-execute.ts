// Pyth Lazer single-popup execute flow. Replaces the Core 2-popup
// postPythAndExecuteConsumer: with Lazer there is no separate price-posting tx
// (the signed price rides inside the consumer tx as the ed25519 + dominion
// instructions), so the whole mint/redeem/claim is ONE tx and ONE wallet popup.
//
// Robustness mirrors the Core flow: client-side simulate before send (catch
// reverts for free + map StaleOracle), then confirm-on-INCLUSION with a
// value.err inspection (a landed-but-reverted tx must never be reported as
// success - CODEX P1-01).
import { Connection, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { isStaleOracleError, STALE_ORACLE_USER_MESSAGE } from "./anchor-client";
import { fetchLazerEnvelope } from "./lazer-client";

const FLOW_TIMEOUT_MS = 90_000;

// ROUND 5 P1-05. How many prints a submitter may try to claim before giving up, and how long to wait
// between tries. The feed publishes at fixed_rate@1000ms, so one second is exactly one new print.
const CLAIM_ATTEMPTS = 3;
const CLAIM_RETRY_MS = 1_100;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * ROUND 5 P1-05. Fetch a print for submission, preferring one no other submitter has been handed.
 *
 * D2 lets one signed envelope price exactly ONE operation, so two submitters on the same print means
 * the second is refused `LazerReplayed` after paying the Lazer verify fee. The proxy marks a print
 * `contended` when somebody already took it; waiting ~1s gets the next one, and the feed publishes at
 * fixed_rate@1000ms.
 *
 * IT ALWAYS RETURNS AN ENVELOPE. Contention is a preference, never a refusal: this runs before the
 * wallet popup, so a delay is invisible, but a refusal would mean an anonymous request loop against the
 * unauthenticated proxy could stop every user from minting. Losing the race costs a fraction of a cent
 * on a transaction the user chose to send; being unable to send at all costs the product.
 */
async function claimEnvelope(
  feedId?: number,
): Promise<{ envelope: Uint8Array; priceUsd: number | null; contended: boolean }> {
  let last = await fetchLazerEnvelope(feedId, true);
  for (let attempt = 1; attempt < CLAIM_ATTEMPTS && last.contended; attempt++) {
    await new Promise((r) => setTimeout(r, CLAIM_RETRY_MS));
    try {
      last = await fetchLazerEnvelope(feedId, true);
    } catch {
      // KEEP THE ENVELOPE WE ALREADY HAVE. A review pass caught this: the loop discarded a usable
      // contended envelope and re-fetched, and `fetchLazerEnvelope` throws on any non-2xx, so a 429
      // or a transient 502 on the OPTIONAL retry killed a mint that was one signature away from
      // working. Contention costs the user a fraction of a cent if they lose the race; propagating
      // this costs them the transaction. The doc above says this function always returns an envelope,
      // and it now does.
      break;
    }
  }
  return last;
}

/**
 * Fetch the latest signed Lazer envelope, build the consumer tx with it (the
 * caller's `buildTx` wraps buildLazerMint/Redeem/ClaimTx, which assemble
 * `[ed25519, ...preIxs, dominion]`), then sign + simulate + send + confirm.
 * Throws `LazerNotConfiguredError` if the proxy has no key, the mapped
 * StaleOracle message on a stale-price revert, or a structured on-chain error.
 */
export async function fetchAndExecuteLazer(
  connection: Connection,
  wallet: WalletContextState,
  buildTx: (envelope: Uint8Array, priceUsd: number | null) => Promise<Transaction>,
  feedId?: number,
): Promise<{ consumerSig: string }> {
  return withTimeout(
    _impl(connection, wallet, buildTx, feedId),
    FLOW_TIMEOUT_MS,
    "Mint/redeem flow",
  );
}

async function _impl(
  connection: Connection,
  wallet: WalletContextState,
  buildTx: (envelope: Uint8Array, priceUsd: number | null) => Promise<Transaction>,
  feedId?: number,
): Promise<{ consumerSig: string }> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }

  // 1. Fetch the signed envelope + its price (throws LazerNotConfiguredError on 503).
  //
  // THIS IS THE SUBMIT PATH. `fresh` is mandatory here: the program refuses a feed timestamp it has
  // already consumed, so an envelope shared with another signer costs this user a failed transaction
  // plus the Lazer verify fee. See round 4 P0-01.
  //
  // ROUND 5 P1-05: the proxy marks a print `contended` when another submitter already took it, and
  // `claimEnvelope` waits for a fresher one up to CLAIM_ATTEMPTS times. It always returns an envelope:
  // this runs BEFORE the wallet popup, so a wait is invisible, but a refusal here would hand anyone
  // with curl a way to stop every mint on the site. Bounded at 3 tries inside a 90s flow budget.
  const { envelope, priceUsd } = await claimEnvelope(feedId);

  // 2. Build the single consumer tx (ed25519 + dominion). The caller computes
  //    min_out from `priceUsd` - the envelope's OWN price - so the slippage floor
  //    matches what the contract will price at.
  const tx = await buildTx(envelope, priceUsd);

  // 3. ONE popup: sign the consumer tx. Phantom shows the isolated balance change.
  const signed = (await wallet.signTransaction(tx)) as Transaction;
  const sigBytes = signed.signature;
  if (!sigBytes) {
    throw new Error("Wallet returned an unsigned transaction. Try a different wallet.");
  }
  const consumerSig = bs58.encode(sigBytes);

  // 4. Client-side simulate before send (free revert catch; map StaleOracle).
  const sim = await connection.simulateTransaction(signed);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const errStr =
      typeof sim.value.err === "string" ? sim.value.err : JSON.stringify(sim.value.err);
    if (isStaleOracleError(`${errStr}\n${logs.join("\n")}`)) {
      throw new Error(STALE_ORACLE_USER_MESSAGE);
    }
    throw new Error(`Simulation reverted: ${errStr}\n  ${logs.slice(-8).join("\n  ")}`);
  }

  // 5. Send. Tolerate the optimistic-preflight "already processed" race.
  try {
    await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already been processed") && !msg.includes("AlreadyProcessed")) throw e;
  }

  // 6. Confirm. confirmTransaction resolves on INCLUSION, not success: a tx that
  //    lands then reverts (stale oracle, pause, slippage, treasury race) has a
  //    non-null value.err. Inspect it + surface the real failure (CODEX P1-01).
  const blockhash = signed.recentBlockhash!;
  const lastValidBlockHeight =
    signed.lastValidBlockHeight ??
    (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  const conf = await connection.confirmTransaction(
    { signature: consumerSig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value?.err != null) {
    const txInfo = await connection
      .getTransaction(consumerSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    throw Object.assign(new Error("Transaction reverted on-chain"), {
      logs: txInfo?.meta?.logMessages ?? [],
      onChainErr: conf.value.err,
    });
  }

  return { consumerSig };
}
