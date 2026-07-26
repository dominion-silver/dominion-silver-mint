"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { fetchOnchainAdmin } from "@/lib/admin-actions";
import { guardianPda } from "@/lib/pdas";
import { isActiveMember, isConfigured } from "@/lib/squads";

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
  const { connection } = useConnection();
  const [verifiedPk, setVerifiedPk] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Authorization (identity), separate from ownership proof: is THIS wallet
  // allowed to see the console at all? Fail-closed. Allowed = the on-chain
  // config.admin, OR a registered guardian, OR (if an Ops Squads is configured)
  // an active member of it. A random wallet that merely proved ownership is NOT
  // allowed to view the console.
  const [authz, setAuthz] = useState<"checking" | "ok" | "denied">("checking");

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

  // Identity authorization: only after ownership is proven, and re-run per pk.
  // Fail-closed: any error or non-match => denied.
  useEffect(() => {
    if (!verified || !pk) {
      setAuthz("checking");
      return;
    }
    let alive = true;
    setAuthz("checking");
    (async () => {
      try {
        const key = new PublicKey(pk);
        // 1) the on-chain admin (covers a direct-admin deploy, e.g. devnet).
        const admin = await fetchOnchainAdmin(connection);
        if (admin.equals(key)) {
          if (alive) setAuthz("ok");
          return;
        }
        // 2) an ACTIVE registered guardian.
        //
        // AUDIT finding L-01: this used to accept any wallet whose guardian PDA
        // merely EXISTED. Removal does not close that account, it stamps
        // `cooldown_until`, so a removed guardian kept console access (it could
        // no longer act on-chain, but it could still read the panel). Decode the
        // account and require an active guardian, matching what the program
        // itself enforces (`g.cooldown_until == 0`).
        //
        // GuardianAccount layout, offsets used here:
        //   0..8    discriminator
        //   8..40   guardian: Pubkey
        //   40..48  added_at: i64
        //   48..56  cooldown_until: i64   <- read below
        //   56..64  pending_removal_at: i64
        //   64      self_cancel_used: bool
        //   65      version: u8
        //   66..98  reserved
        // The account has grown twice (56 -> 64 -> 98). Both growths APPENDED, so
        // these offsets held, but that was luck rather than design: inserting a field
        // before cooldown_until would have silently mis-authorized wallets. The
        // minimum length asserted below is therefore the offset this code actually
        // depends on, not the current total size, so a future append cannot make the
        // guard wrong in either direction.
        const COOLDOWN_END = 56;
        const gInfo = await connection.getAccountInfo(guardianPda(key));
        if (gInfo && gInfo.data.length >= COOLDOWN_END) {
          const stored = new PublicKey(gInfo.data.subarray(8, 40));
          const cooldownUntil = gInfo.data.readBigInt64LE(48);
          if (stored.equals(key) && cooldownUntil === 0n) {
            if (alive) setAuthz("ok");
            return;
          }
        }
        // 3) an active member of the configured Ops Squads (mainnet model).
        if (isConfigured("ops") && (await isActiveMember(connection, "ops", key))) {
          if (alive) setAuthz("ok");
          return;
        }
        if (alive) setAuthz("denied");
      } catch {
        if (alive) setAuthz("denied"); // fail-closed
      }
    })();
    return () => {
      alive = false;
    };
  }, [verified, pk, connection]);

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

  // Ownership proven; now checking identity authorization.
  if (authz === "checking") {
    return (
      <Shell title="Checking authorization…">
        <p className="text-sm text-muted">
          Verifying this wallet is the admin, a guardian, or an Ops multisig
          member.
        </p>
      </Shell>
    );
  }

  // Ownership proven but this wallet is NOT authorized to view the console.
  if (authz === "denied") {
    return (
      <Shell title="Not authorized">
        <p className="mb-2 text-sm text-muted">
          This wallet does not have admin rights.
        </p>
        <p className="mb-6 break-all font-mono text-xs text-muted">{pk}</p>
        <button
          onClick={() => disconnect().catch(() => {})}
          className="rounded-md border border-border px-6 py-3 text-sm transition hover:bg-white/5"
        >
          Disconnect and switch wallet
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
