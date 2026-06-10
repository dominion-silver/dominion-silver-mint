"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

// SSR-disabled (wallet state is client-only) -> no hydration mismatch.
const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);
import { ed25519 } from "@noble/curves/ed25519";

const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(h: string): Uint8Array {
  if (
    typeof h !== "string" ||
    h.length === 0 ||
    h.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(h)
  ) {
    return new Uint8Array(0); // invalid -> empty -> ed25519.verify returns false
  }
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++)
    a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}

/**
 * Ownership-proof gate. A connected wallet only means the extension is
 * linked; it does NOT prove the user controls the key. This forces an
 * explicit ed25519 message signature (no transaction, no fee, nothing
 * on-chain) and verifies it locally before granting access. The proof is
 * cached in sessionStorage (per pubkey, short TTL) so a refresh inside the
 * session does not re-prompt, but closing the tab clears it.
 */

const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const STORAGE_PREFIX = "dmn-admin-auth:";

function storageKey(pubkey: string) {
  return STORAGE_PREFIX + pubkey;
}

function buildChallenge(pubkey: string): string {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const issued = new Date().toISOString();
  return [
    "Dominion Silver - Admin Console",
    "",
    "Sign to prove you control this wallet.",
    "This is a signature only: no transaction, no fee,",
    "nothing is sent on-chain.",
    "",
    `Wallet: ${pubkey}`,
    `Issued: ${issued}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

function verifySig(message: string, sigHex: string, pubkey: string): boolean {
  try {
    return ed25519.verify(
      fromHex(sigHex),
      new TextEncoder().encode(message),
      new PublicKey(pubkey).toBytes(),
    );
  } catch {
    return false;
  }
}

export function WalletAuthGate({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const [verifiedPk, setVerifiedPk] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pk = publicKey?.toBase58() ?? null;
  // Gate on the pubkey the verification belongs to, not a bare boolean, so a
  // wallet SWITCH (A -> B) never flashes B's content as verified for one frame
  // before the [pk] effect re-checks (Fable audit P3-i). First load is already
  // fail-closed (verifiedPk starts null).
  const verified = pk !== null && verifiedPk === pk;

  // Re-evaluate when the connected key changes. Honour a cached, still-valid,
  // still-cryptographically-correct proof for this exact pubkey.
  useEffect(() => {
    setErr(null);
    if (!pk) {
      setVerifiedPk(null);
      return;
    }
    try {
      const raw = sessionStorage.getItem(storageKey(pk));
      if (raw) {
        const p = JSON.parse(raw) as {
          message: string;
          sig: string;
          at: number;
        };
        if (
          p.at &&
          Date.now() - p.at < TTL_MS &&
          verifySig(p.message, p.sig, pk)
        ) {
          setVerifiedPk(pk);
          return;
        }
        sessionStorage.removeItem(storageKey(pk));
      }
    } catch {
      /* ignore corrupt cache */
    }
    setVerifiedPk(null);
  }, [pk]);

  const doSign = useCallback(async () => {
    if (!pk || !signMessage) return;
    setErr(null);
    setSigning(true);
    try {
      const message = buildChallenge(pk);
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      const sig = toHex(sigBytes);
      if (!verifySig(message, sig, pk)) {
        throw new Error("Signature did not verify against the wallet key.");
      }
      sessionStorage.setItem(
        storageKey(pk),
        JSON.stringify({ message, sig, at: Date.now() }),
      );
      setVerifiedPk(pk);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(
        /reject|denied|cancell?ed/i.test(m)
          ? "Signature request was rejected. You must sign to continue."
          : m,
      );
    } finally {
      setSigning(false);
    }
  }, [pk, signMessage]);

  // Not connected.
  if (!connected || !pk) {
    return (
      <Shell title="Connect your wallet">
        <p className="mb-6 text-sm text-muted">
          The admin console requires a connected wallet, then a one-time
          signature to prove you control it.
        </p>
        <WalletMultiButton />
      </Shell>
    );
  }

  // Connected, awaiting ownership proof.
  if (!verified) {
    const noSign = !signMessage;
    return (
      <Shell title="Verify wallet ownership">
        <p className="mb-2 text-sm text-muted">
          A connected wallet alone does not prove you hold the key. Sign a
          short message to prove ownership.
        </p>
        <p className="mb-6 text-xs text-muted">
          This is a signature only - no transaction, no network fee, nothing
          is sent on-chain.
        </p>
        {noSign ? (
          <div className="rounded-md border border-danger bg-danger/10 p-4 text-sm text-danger">
            This wallet does not support message signing. Use Phantom or
            Solflare.
          </div>
        ) : (
          <>
            <button
              onClick={doSign}
              disabled={signing}
              className="rounded-md bg-accent px-6 py-3 font-semibold text-bg transition hover:bg-accentDim disabled:opacity-60"
            >
              {signing ? "Waiting for signature…" : "Sign to continue"}
            </button>
            {err && (
              <div className="mt-4 rounded-md border border-danger bg-danger/10 p-3 text-sm text-danger">
                {err}
              </div>
            )}
          </>
        )}
        <button
          onClick={() => disconnect().catch(() => {})}
          className="mt-6 block text-xs text-muted underline hover:text-white"
        >
          Disconnect
        </button>
      </Shell>
    );
  }

  return <>{children}</>;
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-card p-10 text-center">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      {children}
    </div>
  );
}
