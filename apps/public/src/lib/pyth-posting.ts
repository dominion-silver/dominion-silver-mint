/**
 * Pyth PriceUpdateV2 posting helper.
 *
 * Why two-tx flow:
 *   Pyth's PostPriceUpdate (encoded-VAA write + post-update) is too large
 *   to fit alongside our mint/redeem ix in a single Solana tx (1232B limit).
 *
 * Why closeUpdateAccounts: false:
 *   With the SDK default (true), buildVersionedTransactions APPENDS close ix
 *   to the bundle. Result: the priceUpdate account is closed in the same
 *   bundle that creates it, BEFORE our mint/redeem tx can read it.
 *   We disable auto-close here and re-close manually AFTER the consumer tx
 *   to reclaim ~0.008 SOL of rent.
 *
 *   Verified: SDK source confirms (PythSolanaReceiver.mjs L178-181).
 *
 * Flow:
 *   1. caller calls postPythUpdate(connection, wallet) -> confirms posting
 *      transactions (1-2 wallet popups), returns the resulting PriceUpdateV2
 *      PublicKey + a `close` callback.
 *   2. caller passes that PublicKey into mint_silv / redeem_silv.
 *   3. (optional, fire-and-forget) caller calls close() to recover rent.
 *
 * Lazy-loads the SDK to avoid Next.js build issues with jito-ts transitive.
 */
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, type Signer } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { PYTH_XAG_USD_FEED_ID } from "./constants";

const HERMES_URL = "https://hermes.pyth.network";
const HERMES_TIMEOUT_MS = 10_000;
const FLOW_TIMEOUT_MS = 120_000;
// EE-H1: if user takes longer than this between popup 1 and popup 2,
// the Pyth update may be stale by the time the consumer tx lands.
// On-chain max_staleness is currently 90s (devnet); we bail early at 60s
// to leave headroom for confirmation latency.
const PYTH_FRESHNESS_BUDGET_MS = 60_000;

function normalizeFeedId(id: string): string {
  return id.startsWith("0x") ? id.slice(2) : id;
}

/**
 * Promise.race against a timeout. Used to bound network calls / whole flows
 * so the UI never spins forever on a hung RPC.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Detect whether the connected wallet supports versioned (v0) transactions.
 * Ledger / older Coinbase Wallet adapters historically did not. FE-H1 fix.
 */
function walletSupportsVersionedTx(wallet: WalletContextState): boolean {
  const adapter = wallet.wallet?.adapter;
  if (!adapter) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supported = (adapter as any).supportedTransactionVersions as Set<number | "legacy"> | null;
  // null => legacy only. Set with 0 => v0 supported.
  if (supported === null || supported === undefined) return false;
  return supported.has(0);
}

export interface PostedPriceUpdate {
  priceUpdateAccount: PublicKey;
  postedTxSignatures: string[];
  /** call after the consumer (mint/redeem) tx confirms to reclaim rent */
  close: () => Promise<string[]>;
}

export async function postPythUpdate(
  connection: Connection,
  wallet: WalletContextState,
): Promise<PostedPriceUpdate> {
  if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
    throw new Error("Wallet not connected");
  }

  // Lazy-load SDK at click time (avoids Next.js build issue with jito-ts).
  const [{ HermesClient }, { PythSolanaReceiver }] = await Promise.all([
    import("@pythnetwork/hermes-client"),
    import("@pythnetwork/pyth-solana-receiver"),
  ]);

  const feedIdNoPrefix = normalizeFeedId(PYTH_XAG_USD_FEED_ID);
  const feedIdWithPrefix = "0x" + feedIdNoPrefix;

  // 1. Fetch latest VAA.
  const hermes = new HermesClient(HERMES_URL);
  const updates = await hermes.getLatestPriceUpdates([feedIdNoPrefix], {
    encoding: "base64",
  });
  if (!updates.binary?.data?.length) {
    throw new Error("Hermes returned no price update data");
  }
  const vaa = updates.binary.data[0];

  // 2. Build receiver. Wallet signing wired through user's wallet adapter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anchorWallet: any = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction.bind(wallet),
    signAllTransactions: wallet.signAllTransactions.bind(wallet),
    payer: Keypair.generate(),
  };

  const receiver = new PythSolanaReceiver({ connection, wallet: anchorWallet });

  // CRITICAL: closeUpdateAccounts MUST be false. See file header for why.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates([vaa]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyBuilder = builder as any;
  const priceUpdateAccount: PublicKey =
    anyBuilder.getPriceUpdateAccount(feedIdWithPrefix);

  // 3. Build versioned txs (SDK handles size + signers).
  const versionedBundles: Array<{
    tx: VersionedTransaction;
    signers: Signer[];
  }> = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });

  // 4. Sign + send each tx in order.
  const postedTxSignatures: string[] = [];
  for (const bundle of versionedBundles) {
    // Wallet signs first (user-payer signature), then partial-sign with
    // ephemeral keypairs (encoded-VAA + price-update accounts).
    const signed = await wallet.signTransaction(bundle.tx);
    if (bundle.signers.length > 0) {
      signed.sign(bundle.signers as Keypair[]);
    }
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    postedTxSignatures.push(sig);
  }

  // 5. Build close callback (deferred to caller, called AFTER consumer tx).
  // Closes the priceUpdate account explicitly to reclaim ~0.008 SOL of rent.
  const close = async (): Promise<string[]> => {
    if (!wallet.publicKey || !wallet.signTransaction) return [];
    try {
      // SDK helper: builds InstructionWithEphemeralSigners for closing one priceUpdate.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeIxWithSigners: { instruction: any; signers: Signer[] } =
        await receiver.buildClosePriceUpdateInstruction(priceUpdateAccount);

      // Wrap in a fresh builder to get a properly-built versioned tx.
      // computeUnits: 50_000 is generous; close ix uses < 10k CUs in practice.
      // tightComputeBudget:false avoids the SDK setting CU limit to the
      // computeUnits sum (which would zero out if we wrote 0 here).
      const closeBuilder = receiver.newTransactionBuilder({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (closeBuilder as any).addInstruction({
        instruction: closeIxWithSigners.instruction,
        signers: closeIxWithSigners.signers ?? [],
        computeUnits: 50_000,
      });

      const closeBundles = await closeBuilder.buildVersionedTransactions({
        computeUnitPriceMicroLamports: 10_000,
        tightComputeBudget: false,
      });
      const sigs: string[] = [];
      for (const cb of closeBundles) {
        const signed = await wallet.signTransaction(cb.tx);
        if (cb.signers.length > 0) signed.sign(cb.signers as Keypair[]);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction(sig, "confirmed");
        sigs.push(sig);
      }
      return sigs;
    } catch (e) {
      // Best-effort: if close fails, the rent leaks but consumer tx is unaffected.
      console.warn("Failed to close priceUpdate account, rent leaked:", e);
      return [];
    }
  };

  return { priceUpdateAccount, postedTxSignatures, close };
}

/**
 * 2-popup flow: separates infra (Pyth oracle posts, no money moves)
 * from action (the mint/redeem tx that actually moves USDC/SILV).
 *
 *   Popup 1: signAllTransactions on the 1-2 Pyth post txs. User sees
 *            "Authorize oracle update" with no token deltas. Approve
 *            without scrutiny since it's infra.
 *
 *   Popup 2: signTransaction on the consumer tx alone. Phantom shows
 *            the FULL simulated balance change ("-X USDC, +Y SILV") in
 *            isolation. User can review what they're actually paying
 *            without it being buried in a 3-tx batch.
 *
 * This is the right trade-off for asset-backed protocols: minimize
 * popups for infra, maximize clarity for money flows. Going to 1 popup
 * (signAll across everything) hides the consumer tx among setup txs
 * and encourages mindless approve-clicking. Going to 3 popups is
 * friction overload.
 *
 * Caller passes a buildConsumerTx callback that takes the priceUpdate
 * pubkey (we know it up-front from the SDK's ephemeral keypair) and
 * returns an unsigned legacy Transaction.
 */
export async function postPythAndExecuteConsumer(
  connection: Connection,
  wallet: WalletContextState,
  buildConsumerTx: (priceUpdate: PublicKey) => Promise<Transaction>,
): Promise<{
  priceUpdate: PublicKey;
  pythSigs: string[];
  consumerSig: string;
  close: () => Promise<string[]>;
}> {
  return withTimeout(
    _postPythAndExecuteConsumerImpl(connection, wallet, buildConsumerTx),
    FLOW_TIMEOUT_MS,
    "Mint/redeem flow",
  );
}

async function _postPythAndExecuteConsumerImpl(
  connection: Connection,
  wallet: WalletContextState,
  buildConsumerTx: (priceUpdate: PublicKey) => Promise<Transaction>,
): Promise<{
  priceUpdate: PublicKey;
  pythSigs: string[];
  consumerSig: string;
  close: () => Promise<string[]>;
}> {
  if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
    throw new Error("Wallet not connected");
  }

  // FE-H1: surface a friendly error for wallets that don't support v0 txs
  // (Ledger, older Coinbase Wallet) before the user signs anything.
  if (!walletSupportsVersionedTx(wallet)) {
    throw new Error(
      `${wallet.wallet?.adapter.name ?? "Your wallet"} doesn't support versioned transactions. ` +
        "Use Phantom or Solflare.",
    );
  }

  const [{ HermesClient }, { PythSolanaReceiver }] = await Promise.all([
    import("@pythnetwork/hermes-client"),
    import("@pythnetwork/pyth-solana-receiver"),
  ]);

  const feedIdNoPrefix = normalizeFeedId(PYTH_XAG_USD_FEED_ID);
  const feedIdWithPrefix = "0x" + feedIdNoPrefix;

  // 1. Fetch latest VAA from Hermes (with timeout, EE-M3).
  // EE-H1: track timestamp at fetch so we can reject if too much real
  // time elapses before the consumer ix runs.
  const tBundleStart = Date.now();
  const hermes = new HermesClient(HERMES_URL);
  const updates = await withTimeout(
    hermes.getLatestPriceUpdates([feedIdNoPrefix], { encoding: "base64" }),
    HERMES_TIMEOUT_MS,
    "Hermes price fetch",
  );
  if (!updates.binary?.data?.length) {
    throw new Error("Oracle service unavailable (Hermes returned no data). Please retry.");
  }
  const vaa = updates.binary.data[0];

  // 2. Build receiver + Pyth bundles (unsigned VersionedTransactions).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anchorWallet: any = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction.bind(wallet),
    signAllTransactions: wallet.signAllTransactions.bind(wallet),
    payer: Keypair.generate(),
  };
  const receiver = new PythSolanaReceiver({ connection, wallet: anchorWallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates([vaa]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceUpdate: PublicKey = (builder as any).getPriceUpdateAccount(feedIdWithPrefix);
  const pythBundles: Array<{ tx: VersionedTransaction; signers: Signer[] }> =
    await builder.buildVersionedTransactions({
      computeUnitPriceMicroLamports: 50_000,
      tightComputeBudget: true,
    });

  // 3. POPUP 1: sign Pyth txs together via signAllTransactions. Phantom
  //    shows a single combined approval listing the (1-2) Pyth posts.
  //    No money moves so the user can approve without scrutiny.
  const pythUnsigned = pythBundles.map((b) => b.tx);
  const pythSigned = pythUnsigned.length > 0
    ? (await wallet.signAllTransactions(pythUnsigned)) as VersionedTransaction[]
    : [];

  // Append ephemeral-signer signatures (encoded-VAA + priceUpdate keypairs).
  for (let i = 0; i < pythBundles.length; i++) {
    if (pythBundles[i].signers.length > 0) {
      pythSigned[i].sign(pythBundles[i].signers as Keypair[]);
    }
  }

  // 4. Send Pyth txs sequentially with confirms. Use the MODERN confirm
  //    form (EE-C1) with blockhash + lastValidBlockHeight so the SDK can
  //    detect blockhash expiry instead of polling forever.
  // EE-M2: standardize maxRetries=3 across all sends. App-level retries
  //        (rebuild Pyth bundle) are the right pattern for transient fails;
  //        cluster-level retries are bounded.
  const pythSigs: string[] = [];
  for (const signed of pythSigned) {
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    // VersionedTransaction's recentBlockhash is on the message.
    const blockhash = signed.message.recentBlockhash;
    const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    pythSigs.push(sig);
  }

  // 5. EE-H5: re-check wallet still connected before requesting popup 2.
  //    User may have disconnected between popups.
  if (!wallet.signTransaction) {
    throw new Error("Wallet disconnected between transactions. Please reconnect and retry.");
  }

  // EE-H1: check if Pyth oracle data is about to go stale. If user took
  // a long time to approve popup 1, abort BEFORE the consumer popup so
  // they don't sign a tx that will revert on-chain with StaleOracle.
  const elapsed = Date.now() - tBundleStart;
  if (elapsed > PYTH_FRESHNESS_BUDGET_MS) {
    throw new Error(
      `Oracle data is about to expire (${Math.round(elapsed / 1000)}s elapsed since fetch, budget ${PYTH_FRESHNESS_BUDGET_MS / 1000}s). Please retry to refresh.`,
    );
  }

  // 6. Build the consumer tx (mint or redeem) referencing the priceUpdate.
  //    Build AFTER Pyth posts confirm so the priceUpdate is alive on-chain
  //    when the user reviews the consumer tx in Phantom.
  const consumerTx = await buildConsumerTx(priceUpdate);

  // 7. POPUP 2: sign the consumer tx alone. Phantom shows the simulated
  //    balance change in isolation ("-X USDC, +Y SILV").
  const consumerSigned = (await wallet.signTransaction(consumerTx)) as Transaction;

  const sigBytes = consumerSigned.signature;
  if (!sigBytes) {
    throw new Error("Wallet returned an unsigned transaction. Try a different wallet.");
  }
  const consumerSig: string = bs58.encode(sigBytes);

  // 8. EE-H6: client-side simulate BEFORE sending. Catches reverts (slippage,
  //    paused, daily cap) for free instead of paying tx fees on-chain failure.
  //    Uses our connection (devnet/mainnet, not Phantom's).
  const sim = await connection.simulateTransaction(consumerSigned);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const errStr = typeof sim.value.err === "string"
      ? sim.value.err
      : JSON.stringify(sim.value.err);
    const lastLogs = logs.slice(-8).join("\n  ");
    throw new Error(`Simulation reverted: ${errStr}\n  ${lastLogs}`);
  }

  // 9. Send consumer. Tolerate "already processed" (optimistic-preflight
  //    race). Compute sig locally so confirm works deterministically.
  //    maxRetries: 3 (EE-M2 standardized).
  try {
    await connection.sendRawTransaction(consumerSigned.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already been processed") && !msg.includes("AlreadyProcessed")) throw e;
  }
  // Confirm with modern form. CODEX P1-01: confirmTransaction resolves on
  // INCLUSION, not success. A consumer tx that lands and then reverts
  // (stale oracle, pause, slippage, budget/treasury race after the
  // pre-send simulate) would otherwise be reported as a successful
  // mint/redeem/claim. Inspect value.err; on a non-null err fetch the
  // program logs and throw a structured error so the caller surfaces the
  // real failure (and instant-redeem races still route to queue/OTC via
  // parseRedeemError(errorToText(e))).
  const consumerBlockhash = consumerSigned.recentBlockhash!;
  const consumerLastValid = consumerSigned.lastValidBlockHeight
    ?? (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  const conf = await connection.confirmTransaction(
    { signature: consumerSig, blockhash: consumerBlockhash, lastValidBlockHeight: consumerLastValid },
    "confirmed",
  );
  if (conf.value?.err != null) {
    const txInfo = await connection
      .getTransaction(consumerSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .catch(() => null);
    throw Object.assign(
      new Error("Transaction reverted on-chain"),
      {
        logs: txInfo?.meta?.logMessages ?? [],
        onChainErr: conf.value.err,
      },
    );
  }

  // 8. Build close callback (intentionally NOT auto-fired; saves another
  // popup + ~$0.001 of rent leaks per op for now).
  const close = async (): Promise<string[]> => {
    if (!wallet.publicKey || !wallet.signTransaction) return [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeIx: { instruction: any; signers: Signer[] } =
        await receiver.buildClosePriceUpdateInstruction(priceUpdate);
      const closeBuilder = receiver.newTransactionBuilder({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (closeBuilder as any).addInstruction({
        instruction: closeIx.instruction,
        signers: closeIx.signers ?? [],
        computeUnits: 50_000,
      });
      const closeBundles = await closeBuilder.buildVersionedTransactions({
        computeUnitPriceMicroLamports: 10_000,
        tightComputeBudget: false,
      });
      const sigs: string[] = [];
      for (const cb of closeBundles) {
        const signed = await wallet.signTransaction!(cb.tx);
        if (cb.signers.length > 0) signed.sign(cb.signers as Keypair[]);
        const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
        const blockhash = signed.message.recentBlockhash;
        const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        sigs.push(sig);
      }
      return sigs;
    } catch (e) {
      console.warn("Failed to close priceUpdate, rent leaked:", e);
      return [];
    }
  };

  return { priceUpdate, pythSigs, consumerSig, close };
}
