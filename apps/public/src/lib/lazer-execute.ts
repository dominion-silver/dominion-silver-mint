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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
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
  const { envelope, priceUsd } = await fetchLazerEnvelope(feedId);

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
