"use client";

// Wired admin actions tab. Each action builds the dominion instruction
// (admin-actions.ts), wraps it into a Squads proposal (squads.ts), and the
// connected wallet (an Ops Squads member) signs + sends. Guardian-only
// actions (pause / cancel) are signed DIRECTLY by the connected guardian
// key. A pending-proposals panel approves + executes. All numeric/address
// inputs are strictly validated before building (no silent garbage).

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as actions from "../lib/admin-actions";
import { EXEC_METHODS } from "../lib/admin-actions";
import {
  buildApproveTx,
  buildCreateProposalTx,
  buildExecuteTx,
  isConfigured,
  listProposals,
  type ProposalView,
} from "../lib/squads";

// ---- strict parsers (throw a clear error; never silently coerce) ----
function parseAtomic(s: string, decimals: number): bigint {
  const t = (s ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t))
    throw new Error("Enter a positive number (no sign, digits only)");
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`At most ${decimals} decimals`);
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
function parseUint(s: string, max: number): number {
  const t = (s ?? "").trim();
  if (!/^\d+$/.test(t)) throw new Error("Enter a non-negative integer");
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw new Error(`Out of range (0..${max})`);
  return n;
}
function parseBigUint(s: string): bigint {
  const t = (s ?? "").trim();
  if (!/^\d+$/.test(t)) throw new Error("Enter a non-negative integer");
  return BigInt(t);
}
function pk(s: string): PublicKey {
  return new PublicKey((s ?? "").trim()); // throws on invalid base58
}
const U32 = 4_294_967_295;
const U16 = 65_535;

type FieldKind =
  | "usdc"
  | "silv"
  | "int"
  | "bps"
  | "bool"
  | "pubkey"
  | "text"
  | "hex32"
  | "select"
  | "optint"
  | "optbig";
interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
}
interface ActionDesc {
  id: string;
  label: string;
  group: "Instant" | "Delayed (24h)" | "Execute / cancel" | "Emergency & ops";
  danger?: boolean;
  mode: "squads" | "direct";
  fields: Field[];
  tip: string;
  build: (
    ctx: actions.BuildCtx,
    p: Record<string, string>,
    me: PublicKey,
  ) => Promise<TransactionInstruction[]>;
}

const optNum = (s: string | undefined, max: number) =>
  s && s.trim() ? parseUint(s, max) : undefined;
const optBig = (s: string | undefined) =>
  s && s.trim() ? parseBigUint(s) : undefined;

const ACTIONS: ActionDesc[] = [
  {
    id: "set-redemptions",
    label: "Set redemptions on/off",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "on", label: "Enabled", kind: "bool" }],
    tip: "Master switch for user redemptions.",
    build: (c, p) => actions.setRedemptionsEnabled(c, p.on === "true"),
  },
  {
    id: "set-max-supply",
    label: "Set max SILV supply",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "oz", label: "Max supply (oz)", kind: "silv" }],
    tip: "Hard ceiling on total SILV. Raise only with matching physical silver.",
    build: (c, p) => actions.setMaxSilvSupply(c, parseAtomic(p.oz, 6)),
  },
  {
    id: "set-instant-budget",
    label: "Set instant budget",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "usd", label: "Budget (USDC)", kind: "usdc" }],
    tip: "Total instant-redemption value allowed per reset window.",
    build: (c, p) => actions.setInstantRedeemBudget(c, parseAtomic(p.usd, 6)),
  },
  {
    id: "set-instant-window",
    label: "Set instant window",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "secs", label: "Window (seconds)", kind: "int" }],
    tip: "Length of the fixed window after which the instant budget resets.",
    build: (c, p) =>
      actions.setInstantRedeemWindow(c, parseUint(p.secs, U32)),
  },
  {
    id: "set-large-threshold",
    label: "Set large-redeem threshold",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "usd", label: "Threshold (USDC)", kind: "usdc" }],
    tip: "At/above this size a single redeem is forced into the T+3 queue.",
    build: (c, p) =>
      actions.setLargeRedeemThreshold(c, parseAtomic(p.usd, 6)),
  },
  {
    id: "set-queue-delay",
    label: "Set queue delay",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "secs", label: "Delay (seconds)", kind: "int" }],
    tip: "How long a queued redemption waits before it can be claimed.",
    build: (c, p) => actions.setRedeemQueueDelay(c, parseUint(p.secs, U32)),
  },
  {
    id: "propose-min-float",
    label: "Propose treasury minimum",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "usd", label: "Min float (USDC)", kind: "usdc" }],
    tip: "Minimum USDC the admin must leave in the treasury.",
    build: (c, p) =>
      actions.proposeSetTreasuryMinFloat(c, parseAtomic(p.usd, 6)),
  },
  {
    id: "propose-premium-mint",
    label: "Propose mint premium",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "bps", label: "Premium (bps, 0..2000)", kind: "bps" }],
    tip: "Markup users pay to mint.",
    build: (c, p) =>
      actions.proposeSetPremiumMint(c, parseUint(p.bps, U16)),
  },
  {
    id: "propose-premium-redeem",
    label: "Propose redeem fee",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "bps", label: "Fee (bps, 0..1000)", kind: "bps" }],
    tip: "Fee applied when users redeem.",
    build: (c, p) =>
      actions.proposeSetPremiumRedeem(c, parseUint(p.bps, U16)),
  },
  {
    id: "propose-withdraw",
    label: "Propose treasury withdraw",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "usd", label: "Amount (USDC)", kind: "usdc" },
      { name: "to", label: "Recipient (pubkey)", kind: "pubkey" },
    ],
    tip: "Withdraw USDC from the treasury. Cannot breach the min float.",
    build: (c, p) =>
      actions.proposeWithdrawUsdc(c, parseAtomic(p.usd, 6), pk(p.to)),
  },
  {
    id: "propose-admin-timelock",
    label: "Propose change delay",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "secs", label: "Delay (3600..604800 s)", kind: "int" },
    ],
    tip: "Change the timelock duration itself.",
    build: (c, p) =>
      actions.proposeSetAdminTimelock(c, parseUint(p.secs, U32)),
  },
  {
    id: "propose-compliance",
    label: "Propose compliance toggle",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "on", label: "Compliance on", kind: "bool" }],
    tip: "Flip the compliance flag (also auto-pauses).",
    build: (c, p) => actions.proposeSetComplianceMode(c, p.on === "true"),
  },
  {
    id: "propose-metadata",
    label: "Propose token metadata",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "name", label: "Name", kind: "text" },
      { name: "symbol", label: "Symbol", kind: "text" },
      { name: "uri", label: "URI", kind: "text" },
    ],
    tip: "Update SILV name / symbol / URI. Leave a field BLANK to keep its current value (only filled fields are changed; blank no longer wipes a field). Limits: name 32, symbol 10, URI 180 chars.",
    build: (c, p) => {
      const opt = (v?: string, max?: number, label?: string) => {
        const t = (v ?? "").trim();
        if (t.length === 0) return null;
        // Contract caps are UTF-8 BYTES (Rust String::len), not JS UTF-16
        // code units - measure bytes so a multi-byte input is rejected
        // here, not as an opaque on-chain MetadataFieldTooLong revert.
        const bytes = new TextEncoder().encode(t).length;
        if (max && bytes > max)
          throw new Error(`${label} exceeds ${max} bytes`);
        return t;
      };
      const name = opt(p.name, 32, "Name");
      const symbol = opt(p.symbol, 10, "Symbol");
      const uri = opt(p.uri, 180, "URI");
      if (name === null && symbol === null && uri === null)
        throw new Error(
          "Set at least one field (blank fields are left unchanged)",
        );
      return actions.proposeUpdateMetadata(c, name, symbol, uri);
    },
  },
  {
    id: "propose-pyth",
    label: "Propose price-feed source",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "feed", label: "Lazer feed id (u32, SILV = 3304)", kind: "int" },
    ],
    tip: "Change the Pyth Lazer feed id. The Lazer program is a fixed contract constant (no receiver arg).",
    build: (c, p) => actions.proposeSetPythFeed(c, parseUint(p.feed, U32)),
  },
  {
    id: "propose-oracle-guards",
    label: "Propose price-feed safety",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "stale", label: "Max staleness s (blank=keep)", kind: "optint" },
      { name: "conf", label: "Max confidence bps (blank=keep)", kind: "optint" },
      { name: "delta", label: "Max delta bps (blank=keep)", kind: "optint" },
      { name: "decay", label: "Decay s (blank=keep)", kind: "optint" },
      { name: "minp", label: "Min price 1e9 (blank=keep)", kind: "optbig" },
      { name: "maxp", label: "Max price 1e9 (blank=keep)", kind: "optbig" },
      { name: "dust", label: "Dust min USDC (blank=keep)", kind: "optbig" },
      { name: "minpub", label: "Min publishers (blank=keep)", kind: "optint" },
    ],
    tip: "Change oracle guards. Leave a field blank to keep its value. Raising Min publishers (>=2) is the mandatory pre-unpause GO-gate step.",
    build: (c, p) =>
      actions.proposeSetOracleGuards(c, {
        stalenessSeconds: optNum(p.stale, U32),
        confBps: optNum(p.conf, U16),
        maxDeltaBps: optNum(p.delta, U16),
        decaySeconds: optNum(p.decay, U32),
        minPriceScaled: optBig(p.minp),
        maxPriceScaled: optBig(p.maxp),
        dustFilterMinUsdc: optBig(p.dust),
        minPublishers: optNum(p.minpub, U16),
      }),
  },
  {
    id: "settle-offchain",
    label: "Settle redemption off-chain",
    group: "Emergency & ops",
    mode: "squads",
    fields: [
      { name: "owner", label: "Request owner (pubkey)", kind: "pubkey" },
      { name: "nonce", label: "Request nonce (u64)", kind: "optbig" },
    ],
    tip: "Mark a Pending queued redemption settled off-chain (paid via OTC) so it can no longer be claimed on-chain. Copy owner + nonce from the Redemptions table.",
    build: (c, p) => {
      if (!p.nonce || !p.nonce.trim()) throw new Error("Nonce is required");
      return actions.settleRedemptionOffchain(
        c,
        pk(p.owner),
        parseBigUint(p.nonce),
      );
    },
  },
  {
    id: "propose-admin-transfer",
    label: "Transfer admin (propose)",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "to", label: "New admin (pubkey)", kind: "pubkey" }],
    tip: "Begin handing control to a new admin (it must accept).",
    build: (c, p) => actions.proposeAdminTransfer(c, pk(p.to)),
  },
  {
    id: "execute-nonce",
    label: "Execute timelocked (by nonce)",
    group: "Execute / cancel",
    mode: "squads",
    fields: [
      { name: "m", label: "Method", kind: "select", options: EXEC_METHODS },
      { name: "nonce", label: "Nonce", kind: "int" },
      { name: "rent", label: "Rent recipient", kind: "pubkey" },
    ],
    tip: "Execute a proposed change after its delay.",
    build: (c, p) =>
      actions.executeTimelocked(
        c,
        p.m as actions.ExecMethod,
        parseBigUint(p.nonce),
        pk(p.rent),
      ),
  },
  {
    id: "cancel-nonce",
    label: "Guardian: cancel timelocked",
    group: "Execute / cancel",
    mode: "direct",
    fields: [
      { name: "nonce", label: "Nonce", kind: "int" },
      { name: "rent", label: "Rent recipient", kind: "pubkey" },
    ],
    tip: "Guardian cancels a pending change (guardian key signs directly).",
    build: (c, p, me) =>
      actions.cancelTimelockedAction(c, parseBigUint(p.nonce), me, pk(p.rent)),
  },
  {
    id: "pause-admin",
    label: "Pause (via Ops Squads)",
    group: "Emergency & ops",
    danger: true,
    mode: "squads",
    fields: [],
    tip: "Halt mint + redeem. Creates an Ops proposal.",
    build: (c) => actions.pauseAsAdmin(c),
  },
  {
    id: "pause-guardian",
    label: "Pause NOW (guardian key)",
    group: "Emergency & ops",
    danger: true,
    mode: "direct",
    fields: [],
    tip: "Connected guardian key pauses immediately, single signature.",
    build: (c, _p, me) => actions.pauseAsGuardian(c, me),
  },
  {
    id: "unpause",
    label: "Unpause (via Ops Squads)",
    group: "Emergency & ops",
    mode: "squads",
    fields: [],
    tip: "Resume after a pause (admin only).",
    build: (c) => actions.unpause(c),
  },
  {
    id: "add-guardian",
    label: "Add guardian",
    group: "Emergency & ops",
    mode: "squads",
    fields: [{ name: "g", label: "Guardian (pubkey)", kind: "pubkey" }],
    tip: "Add a key that can pause + cancel pending changes.",
    build: (c, p) => actions.addGuardian(c, pk(p.g)),
  },
  {
    id: "remove-guardian",
    label: "Remove guardian",
    group: "Emergency & ops",
    mode: "squads",
    fields: [{ name: "g", label: "Guardian (pubkey)", kind: "pubkey" }],
    tip: "Remove a guardian key.",
    build: (c, p) => actions.removeGuardian(c, pk(p.g)),
  },
  {
    id: "deposit-usdc",
    label: "Deposit USDC",
    group: "Emergency & ops",
    mode: "squads",
    fields: [
      { name: "usd", label: "Amount (USDC)", kind: "usdc" },
      { name: "ata", label: "Source USDC ATA", kind: "pubkey" },
    ],
    tip: "Add USDC into the treasury (only adds funds).",
    build: (c, p) =>
      actions.depositUsdc(c, parseAtomic(p.usd, 6), pk(p.ata)),
  },
  {
    id: "accept-admin",
    label: "Accept admin transfer",
    group: "Emergency & ops",
    mode: "squads",
    fields: [],
    tip: "The NEW admin (this Ops vault) accepts a pending transfer.",
    build: (c) => actions.acceptAdminTransfer(c),
  },
  {
    id: "cancel-admin",
    label: "Cancel admin transfer",
    group: "Emergency & ops",
    mode: "squads",
    fields: [],
    tip: "Cancel a pending admin transfer.",
    build: (c) => actions.cancelAdminTransfer(c),
  },
];

const GROUPS: ActionDesc["group"][] = [
  "Instant",
  "Delayed (24h)",
  "Execute / cancel",
  "Emergency & ops",
];

export function AdminActions() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ t: string; err: boolean } | null>(null);
  const [params, setParams] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [pending, setPending] = useState<ProposalView[]>([]);
  const [adminMismatch, setAdminMismatch] = useState<boolean | null>(null);
  const opsConfigured = isConfigured("ops");
  const squadsBlocked = !opsConfigured || adminMismatch === true;

  // Surface a wrong-multisig: the configured Ops vault PDA must equal the
  // on-chain config.admin, else members would govern the wrong multisig.
  useEffect(() => {
    let alive = true;
    if (!opsConfigured) {
      setAdminMismatch(null);
      return;
    }
    (async () => {
      try {
        const onchain = await actions.fetchOnchainAdmin(connection);
        if (alive)
          setAdminMismatch(!onchain.equals(actions.adminAuthority()));
      } catch {
        if (alive) setAdminMismatch(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connection, opsConfigured]);

  const refreshPending = useCallback(async () => {
    if (!opsConfigured) return;
    try {
      setPending(await listProposals({ connection, role: "ops" }));
    } catch {
      /* read-only; ignore transient RPC errors */
    }
  }, [connection, opsConfigured]);

  useEffect(() => {
    refreshPending();
    const i = setInterval(refreshPending, 12_000);
    return () => clearInterval(i);
  }, [refreshPending]);

  const setField = (aid: string, fname: string, v: string) =>
    setParams((s) => ({ ...s, [aid]: { ...(s[aid] ?? {}), [fname]: v } }));

  async function runAction(a: ActionDesc) {
    if (!publicKey) {
      setMsg({ t: "Connect a wallet first.", err: true });
      return;
    }
    const p = params[a.id] ?? {};
    const summary = a.fields.length
      ? a.fields.map((f) => `${f.label} = ${p[f.name] ?? "(empty)"}`).join("\n")
      : "(no parameters)";
    const kind =
      a.mode === "squads"
        ? "Create an Ops Squads PROPOSAL for:"
        : "Sign + send NOW (direct):";
    if (!window.confirm(`${kind}\n\n${a.label}\n\n${summary}`)) return;

    setBusy(a.id);
    setMsg(null);
    try {
      const ixs = await a.build({ connection }, p, publicKey);
      if (a.mode === "direct") {
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction().add(...ixs);
        tx.feePayer = publicKey;
        tx.recentBlockhash = blockhash;
        const sig = await sendTransaction(tx, connection);
        setMsg({ t: `Sent. Sig ${sig.slice(0, 12)}...`, err: false });
      } else {
        if (squadsBlocked)
          throw new Error(
            adminMismatch
              ? "Configured Ops vault != on-chain config.admin. Refusing."
              : "Ops Squads multisig not configured.",
          );
        const { tx, transactionIndex } = await buildCreateProposalTx({
          connection,
          role: "ops",
          creator: publicKey,
          innerInstructions: ixs,
          memo: a.label,
        });
        const sig = await sendTransaction(tx, connection);
        setMsg({
          t: `Squads proposal #${transactionIndex} created. Sig ${sig.slice(0, 12)}...`,
          err: false,
        });
        await refreshPending();
      }
    } catch (e) {
      setMsg({ t: e instanceof Error ? e.message : String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  async function approve(idx: bigint) {
    if (!publicKey) return;
    setBusy(`a${idx}`);
    try {
      const tx = await buildApproveTx({
        connection,
        role: "ops",
        transactionIndex: idx,
        member: publicKey,
      });
      const sig = await sendTransaction(tx, connection);
      setMsg({ t: `Approved #${idx}. Sig ${sig.slice(0, 12)}...`, err: false });
      await refreshPending();
    } catch (e) {
      setMsg({ t: e instanceof Error ? e.message : String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  async function execute(idx: bigint) {
    if (!publicKey) return;
    setBusy(`e${idx}`);
    try {
      const vtx = await buildExecuteTx({
        connection,
        role: "ops",
        transactionIndex: idx,
        member: publicKey,
      });
      const sig = await sendTransaction(vtx, connection);
      setMsg({ t: `Executed #${idx}. Sig ${sig.slice(0, 12)}...`, err: false });
      await refreshPending();
    } catch (e) {
      setMsg({ t: e instanceof Error ? e.message : String(e), err: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {!opsConfigured && (
        <div className="rounded-md border border-warning bg-warning/10 p-3 text-xs text-warning">
          Ops Squads multisig is a placeholder. Set
          <code className="mx-1">NEXT_PUBLIC_OPS_SQUADS</code> to the real
          multisig address. Squads actions are disabled; guardian direct
          actions still work.
        </div>
      )}
      {adminMismatch === true && (
        <div className="rounded-md border border-danger bg-danger/10 p-3 text-xs text-danger">
          MISMATCH: the configured Ops vault PDA does NOT equal the on-chain
          <code className="mx-1">config.admin</code>. Do NOT sign Squads
          proposals - the app is pointed at the wrong multisig. Fix
          <code className="mx-1">NEXT_PUBLIC_OPS_SQUADS</code>.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6">
        <p className="mb-5 text-xs text-muted">
          Squads actions create an Ops multisig proposal (members approve to
          threshold, then execute). Direct actions are signed now by the
          connected key (guardian path). You confirm every action before it
          is sent.
        </p>

        {GROUPS.map((g) => (
          <div key={g} className="mb-6 last:mb-0">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted">
              {g}
            </div>
            {g === "Delayed (24h)" && (
              <div className="mb-3 rounded-md border border-border bg-bg/40 p-2 text-xs text-muted">
                Stage these one at a time: fully execute one proposal (create,
                approve, then execute) before creating the next. Two delayed
                proposals created together would both claim the same timelock
                slot and the second would fail after the first executes.
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div
                  key={a.id}
                  className={`rounded-md border p-3 ${
                    a.danger ? "border-danger/60" : "border-border"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-medium">{a.label}</span>
                    <span className="text-[10px] uppercase text-muted">
                      {a.mode === "squads" ? "Squads" : "Direct"}
                    </span>
                  </div>
                  <div className="mb-2 text-[11px] leading-snug text-muted">
                    {a.tip}
                  </div>
                  {a.fields.map((f) => (
                    <div key={f.name} className="mb-2">
                      {f.kind === "bool" ? (
                        <select
                          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs"
                          value={params[a.id]?.[f.name] ?? "true"}
                          onChange={(e) =>
                            setField(a.id, f.name, e.target.value)
                          }
                        >
                          <option value="true">on / true</option>
                          <option value="false">off / false</option>
                        </select>
                      ) : f.kind === "select" ? (
                        <select
                          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs"
                          value={params[a.id]?.[f.name] ?? f.options?.[0] ?? ""}
                          onChange={(e) =>
                            setField(a.id, f.name, e.target.value)
                          }
                        >
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs"
                          placeholder={f.label}
                          value={params[a.id]?.[f.name] ?? ""}
                          onChange={(e) =>
                            setField(a.id, f.name, e.target.value)
                          }
                        />
                      )}
                    </div>
                  ))}
                  <button
                    disabled={
                      busy !== null ||
                      (a.mode === "squads" && squadsBlocked) ||
                      !publicKey
                    }
                    onClick={() => runAction(a)}
                    className={`mt-1 w-full rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                      a.danger
                        ? "border-danger text-danger hover:bg-danger/10"
                        : "border-accent text-accent hover:bg-accent/10"
                    }`}
                  >
                    {busy === a.id
                      ? "Working..."
                      : a.mode === "squads"
                        ? "Create Squads proposal"
                        : "Sign + send now"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-3 text-sm font-semibold">
          Pending Ops Squads proposals ({pending.length})
        </div>
        {!opsConfigured ? (
          <div className="text-xs text-muted">
            Configure the Ops multisig to list proposals.
          </div>
        ) : pending.length === 0 ? (
          <div className="text-xs text-muted">No pending proposals.</div>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div
                key={p.transactionIndex.toString()}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs"
              >
                <span>
                  #{p.transactionIndex.toString()} - {p.status} -{" "}
                  {p.approvals}/{p.threshold} approvals
                </span>
                <span className="flex gap-2">
                  <button
                    disabled={busy !== null || !publicKey}
                    onClick={() => approve(p.transactionIndex)}
                    className="rounded border border-accent px-2 py-1 text-accent disabled:opacity-50"
                  >
                    {busy === `a${p.transactionIndex}` ? "..." : "Approve"}
                  </button>
                  <button
                    disabled={busy !== null || !publicKey}
                    onClick={() => execute(p.transactionIndex)}
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  >
                    {busy === `e${p.transactionIndex}` ? "..." : "Execute"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted">
          Approvers: a decoded view of each proposal's inner instruction is a
          tracked follow-up; for now confirm the action with the proposer
          out-of-band before approving.
        </p>
      </div>

      {msg && (
        <div
          className={`rounded-md border p-3 text-xs ${
            msg.err
              ? "border-danger bg-danger/10 text-danger"
              : "border-accent bg-accent/10 text-accent"
          }`}
        >
          {msg.t}
        </div>
      )}
    </div>
  );
}
