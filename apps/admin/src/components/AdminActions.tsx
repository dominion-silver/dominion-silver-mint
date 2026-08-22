"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
// the bool/select form defaults live in one shared module so the render
// default and the read default cannot diverge again. See form-defaults.ts.
import { boolField, selectField, displayField, UNCHOSEN } from "../lib/form-defaults";
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

/**
 * THE PROGRAM'S REAL LIMITS, mirrored from programs/dominion_silver_mint_v2/src/state/config.rs.
 * These exist because the labels used to promise ranges the program does not allow, and always in the
 * PERMISSIVE direction: "Premium (bps, 0..2000)" against a ceiling of 500, "Fee (bps, 0..1000)" against
 * 500, and "Delay (3600..604800 s)" against a FLOOR of 86400. The field validators were
 * `parseUint(p.bps, U16)` and `parseUint(p.secs, U32)`, so the printed range was decoration and 65535
 * bps built cleanly.
 * WHY THAT IS WORSE THAN A COSMETIC BUG. Every one of these is a `propose`, so the cost of a value the
 * program will refuse is a full Squads ceremony: create the vault transaction, collect three of five
 * approvals from three different humans, execute, and only then does it revert. The timelock one was the
 * worst of the three: it told the operator the guardian veto window could be shortened to one hour, when
 * the program's floor is 24h and shortening that window is exactly what an attacker with the admin key
 * would want.
 * Label and enforcement now read the same constant, so they cannot drift apart again.
 */
const PREMIUM_BPS_CEILING = 500; // config.rs:4 and :5, both sides, 5%
const ADMIN_TIMELOCK_MIN_SECONDS = 86_400; // config.rs:10, 24h
const ADMIN_TIMELOCK_MAX_SECONDS = 604_800; // 7 days, the panel's own operational ceiling

/** Like parseUint but with a real floor, for fields whose minimum is not zero. */
function parseUintRange(s: string, min: number, max: number): number {
  const n = parseUint(s, max);
  if (n < min) throw new Error(`Out of range (${min}..${max})`);
  return n;
}

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
export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
}
export interface ActionDesc {
  id: string;
  label: string;
  group: "Instant" | "Delayed (24h)" | "Execute / cancel" | "Emergency & ops";
  danger?: boolean;
  mode: "squads" | "direct";
  fields: Field[];
  tip: string;
  /** When present and the config snapshot is loaded, renders the current
   *  on-chain value near the label so the operator knows what they're changing.
   *  `c` is the decoded config account (any; camelCase fields, BN for u64/i64). */
  current?: (c: any) => string;
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
const optAtomic = (s: string | undefined, decimals: number) =>
  s && s.trim() ? parseAtomic(s, decimals) : undefined;

/** Exported so `src/lib/__tests__/inventory-wallet-actions.test.ts` can traverse the descriptor this
 *  component actually renders. asks for exactly that: asserting a string is present in
 *  EXEC_METHODS proves nothing about which card an operator sees or which builder it calls. */
export const ACTIONS: ActionDesc[] = [
  {
    // "Mint at launch" (, 2026-07-26). Two cards on purpose, because the
    // program is deliberately asymmetric: closing is instant, opening is timelocked.
    // One combined on/off card would let an operator try to open the mint instantly
    // and get a confusing revert.
    id: "close-public-mint",
    label: "CLOSE public mint (emergency, instant)",
    group: "Emergency & ops",
    mode: "squads",
    fields: [],
    tip: "Stops public minting in ONE transaction. Use this the moment the price feed looks wrong: a degraded publisher set, a stale print, a price outside the band. Does NOT affect admin pre-mint, and does not pause the protocol. Re-opening afterwards takes the 24h timelock again.",
    current: (c) => (c.publicMintEnabled ? "OPEN" : "closed"),
    build: (c) => actions.setPublicMintEnabled(c, false),
  },
  {
    id: "propose-open-public-mint",
    label: "OPEN public mint (24h timelock)",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [],
    tip: "Opens direct minting: users pay USDC and receive SILV at the oracle price plus the mint premium. This WAKES THE ORACLE PATH, which is dormant while mint and redeem are both closed, so confirm the staleness, confidence, publisher-floor and price-band guards against live feed data BEFORE proposing. Takes 24h and a guardian can cancel during the window. Execute it afterwards from the Timelock tab.",
    current: (c) =>
      c.publicMintEnabled
        ? "already OPEN"
        : c.pendingPublicMintNonce
          ? `open pending (nonce ${c.pendingPublicMintNonce.toString()})`
          : "closed",
    build: (c) => actions.proposeSetPublicMint(c, true),
  },
  {
    id: "set-redemptions",
    label: "CLOSE redemptions (instant)",
    group: "Instant",
    danger: true,
    mode: "squads",
    fields: [],
    tip: "Emergency close, effective immediately. This is CLOSE-ONLY: the deployed program refuses `true` (RedemptionsEnableBlocked), so the bool this card used to offer had one working value and the other reverted. To OPEN, use 'OPEN redemptions (propose, 24h)' under Delayed. Closing also DISARMS any pending open proposal, so an open cannot land later without a fresh decision.",
    current: (c) => (c.redemptionsEnabled ? "currently OPEN" : "currently closed"),
    build: (c) => actions.setRedemptionsEnabled(c, false),
  },
  {
    id: "set-max-supply",
    label: "Set max SILV supply",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "oz", label: "Max supply (oz)", kind: "silv" }],
    tip: "Hard ceiling on total SILV. TIGHTEN-ONLY: any value ABOVE the current cap reverts SupplyCapRaiseBlocked. Raising the cap needs a program upgrade: there is no admin path for it. Lowering is instant and PERMANENT (a one-way ratchet), and cannot go below the live supply, which would brick admin_premint.",
    current: (c) => `${Number(c.maxSilvSupply) / 1e6} oz`,
    build: (c, p) => actions.setMaxSilvSupply(c, parseAtomic(p.oz, 6)),
  },
  {
    id: "tighten-redeem-limits",
    label: "Emergency tighten redeem limits",
    group: "Instant",
    mode: "squads",
    fields: [
      { name: "budget", label: "Instant budget USDC - DOWN only (blank=keep)", kind: "usdc" },
      { name: "window", label: "Instant window s - UP only (blank=keep)", kind: "int" },
    ],
    // "Large-redeem threshold" and "Queue delay" inputs REMOVED 2026-08-05. Both still write to
    // config and change nothing on chain, so offering them was misleading in itself. Worse:
    // `largeRedeemThresholdUsdc` was what the PUBLIC app read to decide whether to route a
    // redemption to the deleted queue, so an operator "tightening the threshold to $500" in an
    // incident would have moved a client-side cliff to $500 with no indication that the effect was
    // entirely in the front end and nothing on chain had changed.
    tip: "Instant TIGHTEN only: budget DOWN, window UP. LOOSENING either one requires the 24h timelock (see 'Propose redeem limits' under Delayed). Leave a field blank to keep it. Closing redemptions outright is the separate CLOSE card above.",
    current: (c) =>
      `budget ${Number(c.instantRedeemBudgetUsdc) / 1e6} USDC · window ${c.instantRedeemWindowSeconds}s`,
    build: (c, p) => {
      const args = {
        instantRedeemBudgetUsdc: optAtomic(p.budget, 6),
        instantRedeemWindowSeconds: optNum(p.window, U32),
      };
      if (
        args.instantRedeemBudgetUsdc == null &&
        args.instantRedeemWindowSeconds == null
      )
        throw new Error("Set at least one field to tighten");
      return actions.emergencyTightenRedeemLimits(c, args);
    },
  },
  {
    // This card moved from "Instant" to "Delayed (24h)" because the instruction behind
    // it was DELETED. `initialize` binds the pre-mint destination atomically and nothing can set it
    // instantly afterwards, so the only remaining operation is a CHANGE, and a change to where minted
    // supply lands is exactly the thing that has to be announced and be guardian-cancellable.
    id: "propose-inventory-wallet",
    label: "Propose inventory wallet change",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "wallet", label: "New inventory wallet (pubkey)", kind: "pubkey" }],
    tip:
      "Changes where admin_premint mints: the new owner's Token-2022 SILV ATA. Takes effect only " +
      "after 24h and an execute, and a guardian can cancel it inside the window. There is no instant " +
      "path: the first binding happens in initialize and set_inventory_wallet no longer exists.",
    current: (c) => {
      const key = new PublicKey(c.inventoryWallet);
      if (key.equals(PublicKey.default)) return "unset";
      const s = key.toBase58();
      return `${s.slice(0, 4)}..${s.slice(-4)}`;
    },
    build: (c, p) => actions.proposeSetInventoryWallet(c, pk(p.wallet)),
  },
  {
    id: "set-min-operation",
    label: "Set minimum operation size",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "usd", label: "Minimum per mint / redeem (USDC)", kind: "usdc" }],
    tip:
      "The floor on a single priced operation: amount_usdc on mint, the gross USDC " +
      "value on redeem. D2 lets one signed Lazer print price exactly ONE operation protocol-wide, so " +
      "without a floor a dust mint or a dust redeem captured every print for a fraction of a cent and " +
      "denied the priced path to everyone. Instant in BOTH directions, capped at 100 USDC on chain. " +
      "Zero DISABLES the floor, which is what an in-place upgrade of an existing config decodes.",
    current: (c) => {
      const v = c.minOperationUsdc ? Number(c.minOperationUsdc) : 0;
      return v === 0 ? "0 (NO FLOOR)" : `${v / 1e6} USDC`;
    },
    build: (c, p) => actions.setMinOperationUsdc(c, parseAtomic(p.usd, 6)),
  },
  {
    id: "propose-min-float",
    label: "Propose treasury minimum",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "usd", label: "Min float (USDC)", kind: "usdc" }],
    tip: "Minimum USDC the admin must leave in the treasury.",
    current: (c) => `${Number(c.treasuryMinFloatUsdc) / 1e6} USDC`,
    build: (c, p) =>
      actions.proposeSetTreasuryMinFloat(c, parseAtomic(p.usd, 6)),
  },
  {
    id: "propose-premium-mint",
    label: "Propose mint premium",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "bps", label: `Premium (bps, 0..${PREMIUM_BPS_CEILING})`, kind: "bps" }],
    tip: "Markup users pay to mint.",
    current: (c) => `${c.premiumBpsMint / 100}%`,
    build: (c, p) =>
      actions.proposeSetPremiumMint(c, parseUint(p.bps, PREMIUM_BPS_CEILING)),
  },
  {
    id: "propose-premium-redeem",
    label: "Propose redeem fee",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "bps", label: `Fee (bps, 0..${PREMIUM_BPS_CEILING})`, kind: "bps" }],
    tip: "Fee applied when users redeem.",
    current: (c) => `${c.premiumBpsRedeem / 100}%`,
    build: (c, p) =>
      actions.proposeSetPremiumRedeem(c, parseUint(p.bps, PREMIUM_BPS_CEILING)),
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
      { name: "secs", label: `Delay (${ADMIN_TIMELOCK_MIN_SECONDS}..${ADMIN_TIMELOCK_MAX_SECONDS} s; the program floor is 24h)`, kind: "int" },
    ],
    tip: "Change the timelock duration itself.",
    current: (c) => `${c.adminTimelockSeconds}s`,
    build: (c, p) =>
      actions.proposeSetAdminTimelock(c, parseUintRange(p.secs, ADMIN_TIMELOCK_MIN_SECONDS, ADMIN_TIMELOCK_MAX_SECONDS)),
  },
  {
    id: "propose-compliance",
    label: "Propose compliance toggle",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [{ name: "on", label: "Compliance on", kind: "bool" }],
    tip: "Flip the compliance flag (also auto-pauses).",
    current: (c) => (c.complianceMode ? "on" : "off"),
    build: (c, p) => actions.proposeSetComplianceMode(c, boolField(p, "on")),
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
      { name: "feed", label: "Lazer feed id (u32, 3154 = Metal.Index.SILVER/USD)", kind: "int" },
    ],
    tip: "Change the Pyth Lazer feed id. The Lazer program is a fixed contract constant (no receiver arg).",
    current: (c) => `feed ${c.pythLazerFeedId}`,
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
    current: (c) =>
      `staleness ${c.maxStalenessSeconds}s · minPub ${c.minPublishers} · conf ${c.maxConfidenceBps}bps`,
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
    id: "propose-redeem-limits",
    label: "Propose redeem limits (loosen)",
    group: "Delayed (24h)",
    mode: "squads",
    fields: [
      { name: "budget", label: "Instant budget USDC (blank=keep)", kind: "usdc" },
      { name: "window", label: "Instant window s (blank=keep)", kind: "int" },

    ],
    // Threshold and queue-delay inputs REMOVED 2026-08-05: dead on chain (see the note on the
    // emergency card above). The REDEEM SWITCH is deliberately NOT offered here either, even
    // though the same on-chain action carries it: it has its own card, because it is the most
    // consequential switch in the program and bundling it into a four-field form is how it gets
    // flipped by accident.
    tip: "24h-timelocked path to LOOSEN the redeem limits (budget UP, window DOWN). To tighten instantly instead, use 'Emergency tighten redeem limits' under Instant. Leave a field blank to keep it.",
    current: (c) =>
      `budget ${Number(c.instantRedeemBudgetUsdc) / 1e6} USDC · window ${c.instantRedeemWindowSeconds}s`,
    build: (c, p) => {
      const args = {
        instantRedeemBudgetUsdc: optAtomic(p.budget, 6),
        instantRedeemWindowSeconds: optNum(p.window, U32),
      };
      if (
        args.instantRedeemBudgetUsdc == null &&
        args.instantRedeemWindowSeconds == null
      )
        throw new Error("Set at least one field");
      return actions.proposeSetRedeemLimits(c, args);
    },
  },
  // "Settle redemption off-chain" REMOVED 2026-08-05 with the whole queued path. It was also

  // --- Open redemptions. The ONLY path: set_redemptions_enabled still refuses `true` in the
  // deployed bytecode, so opening rides the 24h-timelocked SetRedeemLimits action. Given its
  // own card rather than a checkbox on the limits card, because it is the single most
  // consequential switch in the program: it opens the only user-facing path that pays out
  // treasury cash. ---
  {
    id: "propose-open-redemptions",
    label: "OPEN redemptions (propose, 24h)",
    group: "Delayed (24h)",
    danger: true,
    mode: "squads",
    fields: [],
    tip: "Opens public redemption after a 24h delay, guardian-cancellable. BEFORE executing: (1) the fee vault ATA must exist or every redeem reverts, (2) fund the treasury with USDC, (3) set a non-zero treasury min float, since premium revenue no longer accumulates in the treasury to cushion it. Closing again is instant via the Instant card.",
    current: (c) =>
      c.redemptionsEnabled ? "currently OPEN" : "currently CLOSED",
    build: (c) =>
      actions.proposeSetRedeemLimits(c, { redemptionsEnabled: true }),
  },

  // --- Premium fee vault + fee-exemption whitelist (2026-08-05) ---
  {
    id: "fee-exempt-set",
    label: "Fee exemption: grant / update",
    group: "Instant",
    mode: "squads",
    fields: [
      { name: "wallet", label: "Wallet to exempt (pubkey)", kind: "pubkey" },
      { name: "flags", label: "Scope: 1=mint, 2=redeem, 3=both", kind: "int" },
      {
        // Deliberately NOT optional. Left blank it used to encode 0n ("never expires") while the
        // confirm dialog rendered "(not chosen)", so an operator could read "(not chosen)", confirm,
        // and grant a PERMANENT exemption. That is 's failure mode, the dialog disagreeing with
        // what is encoded, reintroduced for a non-bool field in the very file form-defaults.ts exists
        // to protect. Typing "0" explicitly is one keystroke and it makes the dialog honest.
        name: "expires",
        label: "Expires (unix SECONDS; REQUIRED, must be future, max 2 years out)",
        kind: "optbig",
      },
    ],
    tip: "Waives the premium for one wallet. PREFER 1 (mint only): a both-sides exemption makes a round trip free, which hands that wallet a free option on oracle movement PAID OUT OF THE TREASURY, whereas the normal 1% + 1.5% requires a ~2.485% move before a round trip profits. A free option settled against the treasury is a transfer of value out of it, not merely foregone revenue. AN EXPIRY IS MANDATORY: the contract rejects 0 and rejects any date more than two years out, so this form does not accept 'never'.",
    build: (c, p) => {
      const f = parseUint(p.flags, 3);
      if (f !== 1 && f !== 2 && f !== 3) {
        throw new Error("Scope must be 1 (mint), 2 (redeem) or 3 (both)");
      }
      if (!p.expires || !p.expires.trim()) {
        throw new Error(
          "Expiry is required: a unix timestamp in SECONDS, strictly in the future, " +
            "at most two years out.",
        );
      }
      const exp = parseBigUint(p.expires);
      // The contract enforces all of this, so these checks buy nothing in security. They
      // buy the operator a sentence instead of a hex error code, and they catch the three mistakes
      // that actually happen, at the only moment the operator still has the form open.
      // The reason this validation was worth writing rather than deferring to the chain: this field's
      // label used to read "type 0 for never", so the permanent grant was not an edge case anyone had
      // to reach for, it was the documented shortcut. An operator who types 0 out of habit now learns
      // why it is refused here, not from a reverted Squads transaction an hour later.
      const nowSecs = Math.floor(Date.now() / 1000);
      const TWO_YEARS = 2 * 365 * 86400;
      if (exp === 0n) {
        throw new Error(
          "0 is not accepted. A permanent exemption removes the ~2.485% " +
            "round-trip fee band indefinitely, which is what makes oracle movement unprofitable " +
            "to farm against the treasury. Renewing a two-year term is one instant transaction.",
        );
      }
      if (exp <= BigInt(nowSecs)) {
        throw new Error(
          `Expiry must be in the FUTURE. ${exp} is at or before now (${nowSecs}). ` +
            "A past expiry creates an account that grants nothing while still appearing in every " +
            "roster as an active exemption.",
        );
      }
      if (exp > BigInt(nowSecs + TWO_YEARS)) {
        // The realistic fat finger: a 13-digit JavaScript millisecond timestamp pasted into a
        // seconds field, which yields a year-57000 expiry that looks like a term and behaves like none.
        throw new Error(
          `Expiry is more than two years out (${exp}). If you pasted a millisecond timestamp, ` +
            `divide by 1000: ${exp / 1000n}.`,
        );
      }
      return actions.setFeeExempt(c, pk(p.wallet), f, exp);
    },
  },
  {
    id: "fee-exempt-remove",
    label: "Fee exemption: revoke",
    group: "Instant",
    mode: "squads",
    fields: [{ name: "wallet", label: "Wallet (pubkey)", kind: "pubkey" }],
    tip: "Closes the exemption account and reclaims its rent. There is no 'set scope to 0': the contract rejects zero flags, because an existing-but-empty account would still read as whitelisted in a roster listing.",
    build: (c, p) => actions.removeFeeExempt(c, pk(p.wallet)),
  },
  {
    id: "withdraw-fees",
    label: "Withdraw accrued fees",
    group: "Instant",
    mode: "squads",
    fields: [
      {
        name: "dest",
        label: "Destination wallet (owner pubkey)",
        kind: "pubkey",
      },
      {
        // `fee_whitelist.rs` said of this instruction "the panel prefills the balance instead". It
        // did not, and an empty amount parses to 0n and reverts ZeroAmount. The label now tells the
        // operator where to read the figure, which is one panel above on the Redemptions tab.
        name: "amount",
        label: "Amount (USDC) - balance is on the Premium fee vault panel",
        kind: "usdc",
      },
    ],
    tip: "Sweeps premium revenue out of the program-owned fee vault. The destination's USDC ATA must already exist. Instant, unlike the treasury withdrawal: this vault backs nothing (it holds earned revenue, not the collateral users redeem against) and the admin is already a multisig. Sweep on a regular cadence so the standing balance stays small.",
    build: (c, p) => actions.withdrawFees(c, pk(p.dest), parseAtomic(p.amount, 6)),
  },

  // --- The fee-vault escape hatch. NOT part of the KYC gate below, despite having lived under its
  // section header. ---
  {
    id: "fee-routing",
    label: "Premium routing ON / OFF (escape hatch)",
    group: "Emergency & ops",
    danger: true,
    mode: "squads",
    fields: [{ name: "on", label: "Routing enabled", kind: "bool" }],
    tip: "Turn this OFF if the fee vault ever becomes unusable, e.g. frozen by the USDC issuer. The premium transfer inside mint and redeem is unconditional, so a frozen vault would otherwise brick mint AND redeem for every non-exempt wallet, with exempt wallets still working (which makes it confusing to diagnose). With routing off the premium simply stays in the treasury: that is not an untested mode, it is exactly how this program behaved before 2026-08-05. Instant in both directions.",
    // NEGATED field: false = routing ON. See ConfigAccount.feeRoutingDisabled.
    current: (c) =>
      c.feeRoutingDisabled ? "OFF (premium stays in treasury)" : "ON (premium -> vault)",
    build: (c, p) => actions.setFeeRoutingEnabled(c, boolField(p, "on")),
  },

  // --- KYC gate. DORMANT until armed. ---
  {
    id: "kyc-set-operator",
    label: "KYC: set attestor key",
    group: "Instant",
    mode: "squads",
    fields: [
      {
        name: "operator",
        label: "Attestor pubkey (11111... to decommission)",
        kind: "pubkey",
      },
    ],
    tip: "The hot key that writes approvals. It can ONLY add and remove attestations: it cannot mint, pause, move funds, change a fee, or arm the gate. Instant on purpose, because the realistic failure is that this key leaks and a timelock on rotation would mean 24h with a compromised attestor live.",
    // ONE SIGNATURE. The co-signature-while-armed variant was REVERTED in , and this comment was
    // the half of the revert that got left behind: it claimed the contract required the incoming operator
    // to co-sign, on the incident-response rotation card, which is the exact path the revert exists to keep
    // working. An operator reading it would believe rotating a LEAKED attestor key needs a signature from
    // the appointee. It does not, and Squads could not have assembled it anyway. See the long note in
    // `kyc_admin.rs::set_kyc_operator_handler`.
    build: (c, p) => actions.setKycOperator(c, pk(p.operator)),
  },
  {
    id: "kyc-set-scope",
    label: "KYC: arm / disarm gate",
    group: "Instant",
    danger: true,
    mode: "squads",
    fields: [
      {
        name: "flags",
        label: "Scope: 0=off, 1=mint, 2=redeem, 3=both",
        kind: "int",
      },
    ],
    tip: "WRITE THE ATTESTATIONS FIRST. Arming before any approval exists locks out every holder instantly, and no on-chain check can tell an empty roster from a deliberately empty one. Redeem-only (2) is the usual first step, so public mint stays open for DEX arbitrage. ARMING IS REFUSED BY THE CONTRACT UNTIL AT LEAST ONE WALLET IS ATTESTED, so the attest-then-arm order is enforced by the program rather than by this tooltip. Note that 'an attestor is configured' does not mean anyone can get through: a PDA or a mistyped key would make every future attestation impossible. One admin signature, no co-signer. DISARMING is always allowed and needs nothing: it is the only way out of a wrongly-armed gate. NOTE: arming with exactly one attestation still locks out every other holder, and no on-chain check can tell that apart from a deliberately small roster.",
    current: (c) =>
      `scope ${c.kycScopeFlags ?? 0}${c.kycEnforced ? " (ARMED)" : " (dormant)"}`,
    build: (c, p) => {
      const f = parseUint(p.flags, 3);
      if (f > 3) throw new Error("Scope must be 0, 1, 2 or 3");
      return actions.setKycScope(c, f);
    },
  },
  {
    id: "kyc-attest",
    label: "KYC: attest wallet",
    group: "Emergency & ops",
    // DIRECT, not squads: the required signer is the ATTESTOR key, not config.admin. This card
    // only works when the connected wallet IS the attestor. Normally backend calls it.
    mode: "direct",
    fields: [
      { name: "wallet", label: "Wallet to approve (pubkey)", kind: "pubkey" },
      {
        name: "ref",
        label: "Reference: 32-byte hex hash of the provider record id",
        kind: "hex32",
      },
    ],
    tip: "NEVER put PII here, not even hashed. An email hash is brute-forceable, on-chain data is permanent and public, and Solana cannot honour a GDPR erasure request. Only a hash of the provider's internal record id, which is meaningless without their database. All zeros is valid and means 'no reference'.",
    build: (c, p, me) => {
      const hex = (p.ref ?? "").trim().replace(/^0x/i, "");
      const ref =
        hex === ""
          ? new Uint8Array(32)
          : Uint8Array.from(Buffer.from(hex, "hex"));
      if (ref.length !== 32) {
        throw new Error(
          `Reference must be exactly 32 bytes (64 hex chars), got ${ref.length}`,
        );
      }
      return actions.attestKyc(c, me, pk(p.wallet), ref);
    },
  },
  {
    id: "kyc-revoke",
    label: "KYC: revoke attestation",
    group: "Emergency & ops",
    mode: "squads",
    fields: [
      { name: "wallet", label: "Wallet (pubkey)", kind: "pubkey" },
      { name: "allowDisarm", label: "Also DISARM the gate if this empties the roster", kind: "bool" },
    ],
    tip: "Closes the attestation account, so revocation takes effect in the same slot with no flag for a stale cache to misread. Signable by the admin as well as the attestor, so a compromised attestor's writes can be undone without waiting to rotate it first. LEAVE THE SECOND FIELD OFF unless you mean it: if this is the LAST attestation while the gate is armed, the program refuses rather than dropping the gate silently, because an armed gate with an empty roster locks everybody out. Turning it on removes the holder AND un-gates that side for every wallet, in one transaction. The reason it is a checkbox and not automatic: a compromised attestor can revoke the roster down to one without triggering anything, and then your next revocation would have dropped the gate for everybody, approved at a moment when the roster still held fifty.",
    build: (c, p) =>
      actions.revokeKyc(
        c,
        c.admin ?? actions.adminAuthority(),
        pk(p.wallet),
        boolField(p, "allowDisarm"),
      ),
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
        selectField(p, "m") as actions.ExecMethod,
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
    current: (c) => (c.paused ? "PAUSED" : "live"),
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
    current: (c) => (c.paused ? "PAUSED" : "live"),
    build: (c, _p, me) => actions.pauseAsGuardian(c, me),
  },
  {
    id: "unpause",
    label: "Unpause (via Ops Squads)",
    group: "Emergency & ops",
    mode: "squads",
    fields: [],
    tip: "Resume after a pause (admin only).",
    current: (c) => (c.paused ? "PAUSED" : "live"),
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
    id: "finalize-guardian-removal",
    label: "Finalize guardian removal (after 24h)",
    group: "Emergency & ops",
    mode: "direct",
    fields: [{ name: "g", label: "Guardian (pubkey)", kind: "pubkey" }],
    tip: "Applies a removal previously SCHEDULED by 'Remove guardian', once its 24h window has elapsed. Permissionless on-chain, so it is sent directly. Fails if no removal is scheduled, if the window has not elapsed, or if it would take the active set below the floor.",
    build: (c, p) => actions.finalizeGuardianRemoval(c, pk(p.g)),
  },
  {
    id: "cancel-guardian-removal",
    label: "Cancel guardian removal",
    group: "Emergency & ops",
    mode: "direct",
    fields: [{ name: "g", label: "Guardian (pubkey)", kind: "pubkey" }],
    tip: "Cancels a scheduled removal. Signed by the admin OR by the targeted guardian itself (connect that guardian's wallet to exercise the self-veto). This is what makes the guardian veto non-circular.",
    build: (c, p, me) => actions.cancelGuardianRemoval(c, pk(p.g), me),
  },
  {
    id: "remove-guardian",
    label: "Remove guardian",
    group: "Emergency & ops",
    mode: "squads",
    fields: [{ name: "g", label: "Guardian (pubkey)", kind: "pubkey" }],
    tip: "SCHEDULES removal at now + 24h. The guardian KEEPS its pause and cancel powers during the window and may cancel its own removal. Apply it afterwards with 'Finalize guardian removal'.",
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
    id: "admin-premint",
    label: "Admin pre-mint SILV",
    group: "Emergency & ops",
    mode: "squads",
    fields: [
      { name: "oz", label: "Amount (oz)", kind: "silv" },
      { name: "owner", label: "Inventory owner (pubkey)", kind: "pubkey" },
    ],
    tip: "Admin-only: mint SILV directly into the inventory owner's Token-2022 ATA. Amount is oz (6 decimals). Owner is usually config.inventoryWallet.",
    build: (c, p) =>
      actions.adminPremint(c, parseAtomic(p.oz, 6), pk(p.owner)),
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
  const [onchainAdmin, setOnchainAdmin] = useState<PublicKey | null>(null);
  const [activeGroup, setActiveGroup] =
    useState<ActionDesc["group"]>("Instant");
  const [cfg, setCfg] = useState<any>(null);
  const opsConfigured = isConfigured("ops");
  // FAILS CLOSED. `adminMismatch === true` alone let the UNKNOWN case through: null is the value both
  // before the check resolves and after any RPC failure, so a failed read enabled every Squads button on
  // a screen indistinguishable from the healthy one. On a guard that exists to stop an operator signing
  // against the wrong multisig, unknown has to mean blocked.
  const squadsBlocked = !opsConfigured || adminMismatch !== false;
  // Direct-admin mode: the connected wallet IS the on-chain config.admin (a
  // plain wallet, e.g. the current devnet deploy - not the Ops Squads vault).
  // In that case squads-mode admin actions are signed + sent DIRECTLY by this
  // wallet (no Squads proposal wrapper). Guarded by try/catch so a malformed
  // cfg.admin can never crash the render.
  let directAdmin = false;
  try {
    directAdmin =
      !!cfg && !!publicKey && new PublicKey(cfg.admin).equals(publicKey);
  } catch {
    directAdmin = false;
  }

  // Surface a wrong-multisig: the configured Ops vault PDA must equal the
  // on-chain config.admin, else members would govern the wrong multisig.
  useEffect(() => {
    let alive = true;
    if (!opsConfigured) {
      setAdminMismatch(null);
      setOnchainAdmin(null);
      return;
    }
    (async () => {
      try {
        const onchain = await actions.fetchOnchainAdmin(connection);
        if (alive) {
          // Kept so the UI can PRINT it. Showing both addresses is what turns "no banner" from an
          // ambiguous signal into a statement an operator can check against the runbook.
          setOnchainAdmin(onchain);
          setAdminMismatch(!onchain.equals(actions.adminAuthority()));
        }
      } catch {
        if (alive) {
          setOnchainAdmin(null);
          setAdminMismatch(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [connection, opsConfigured]);

  // One-time fetch of the on-chain config snapshot so each action can show its
  // current value. Refreshed on the same 12s cadence as the pending panel so
  // values stay live after an action lands. Errors are ignored (read-only).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await actions.fetchConfig(connection);
        if (alive) setCfg(c);
      } catch {
        /* read-only; ignore transient RPC errors */
      }
    };
    load();
    const i = setInterval(load, 12_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [connection]);

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

  // Current on-chain value for an action's card. null => don't render the row.
  // "…" while the snapshot is still loading (or a field can't be read).
  const currentValue = (a: ActionDesc): string | null => {
    if (!a.current) return null;
    if (!cfg) return "…";
    try {
      return a.current(cfg);
    } catch {
      return "…";
    }
  };

  async function runAction(a: ActionDesc) {
    if (!publicKey) {
      setMsg({ t: "Connect a wallet first.", err: true });
      return;
    }
    const p = params[a.id] ?? {};
    const summary = a.fields.length
      ? a.fields
          // follow-up: the dialog MUST read the same state the builder
          // reads, or it becomes a third divergent default.
          .map((f) => `${f.label} = ${displayField(p, f.name)}`)
          .join("\n")
      : "(no parameters)";
    // A squads-mode action becomes a Squads proposal ONLY when we are not the
    // on-chain admin. In direct-admin mode it is signed + sent directly, just
    // like the guardian ("direct") actions.
    const asProposal = a.mode === "squads" && !directAdmin;
    const kind = asProposal
      ? "Create an Ops Squads PROPOSAL for:"
      : a.mode === "squads"
        ? "Sign + send NOW (direct admin):"
        : "Sign + send NOW (direct):";
    if (!window.confirm(`${kind}\n\n${a.label}\n\n${summary}`)) return;

    setBusy(a.id);
    setMsg(null);
    try {
      // Direct-admin: thread the connected key as the admin authority so the
      // builder targets it as the acting admin (guardian builders ignore this
      // and use the passed-in `me`).
      const ctx: actions.BuildCtx =
        a.mode === "squads" && directAdmin
          ? { connection, admin: publicKey }
          : { connection };
      const ixs = await a.build(ctx, p, publicKey);
      if (!asProposal) {
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
      {directAdmin && (
        <div className="rounded-md border border-accent bg-accent/10 p-3 text-xs text-accent">
          Direct admin mode - you are the on-chain admin; admin actions are
          signed directly by this wallet (no Squads).
        </div>
      )}
      {!directAdmin && !opsConfigured && (
        <div className="rounded-md border border-warning bg-warning/10 p-3 text-xs text-warning">
          Ops Squads multisig is a placeholder. Set
          <code className="mx-1">NEXT_PUBLIC_OPS_SQUADS</code> to the real
          multisig address. Squads actions are disabled; guardian direct
          actions still work.
        </div>
      )}
      {!directAdmin && adminMismatch === true && (
        <div className="rounded-md border border-danger bg-danger/10 p-3 text-xs text-danger">
          MISMATCH: the configured Ops vault PDA does NOT equal the on-chain
          <code className="mx-1">config.admin</code>. Do NOT sign Squads
          proposals - the app is pointed at the wrong multisig. Fix
          <code className="mx-1">NEXT_PUBLIC_OPS_SQUADS</code>.
        </div>
      )}
      {/* THE UNKNOWN CASE, which used to render nothing at all.
          `adminMismatch` is null until the check resolves AND after any RPC failure, and the banner
          above only fires on `=== true`. So a single failed `fetchOnchainAdmin` left the screen looking
          exactly like the healthy state while every Squads button stayed enabled. "No banner" was both
          the good state and the error state, on the one guard whose whole job is to stop an operator
          signing against the wrong vault. It now says so, and `squadsBlocked` treats null as blocked. */}
      {!directAdmin && opsConfigured && adminMismatch === null && (
        <div className="rounded-md border border-warning bg-warning/10 p-3 text-xs text-warning">
          UNVERIFIED: could not read the on-chain <code className="mx-1">config.admin</code> to
          confirm this app is pointed at the right multisig. Squads actions are disabled until it
          resolves. This is a failed RPC read, not a mismatch: reload, or check the endpoint.
        </div>
      )}
      {/* POSITIVE CONFIRMATION, because until now neither address was rendered anywhere. An operator
          about to start a one-shot mainnet ceremony could not tell from the screen which vault they were
          about to commit to, and the only feedback was the absence of a warning. */}
      {!directAdmin && opsConfigured && (
        <div className="rounded-md border border-border bg-bg/40 p-3 text-[11px] text-muted">
          <div>
            Ops vault this app targets: <code className="text-fg">{actions.adminAuthority().toBase58()}</code>
          </div>
          <div>
            On-chain <code>config.admin</code>:{" "}
            <code className="text-fg">{onchainAdmin ? onchainAdmin.toBase58() : "unread"}</code>
            {adminMismatch === false && <span className="ml-2 text-accent">match</span>}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6">
        <p className="mb-5 text-xs text-muted">
          Squads actions create an Ops multisig proposal (members approve to
          threshold, then execute). Direct actions are signed now by the
          connected key (guardian path). You confirm every action before it
          is sent.
        </p>

        <nav className="mb-5 flex flex-wrap gap-1 border-b border-border">
          {GROUPS.map((g) => (
            <button
              key={g}
              onClick={() => setActiveGroup(g)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
                activeGroup === g
                  ? "border-accent font-semibold text-white"
                  : "border-transparent text-muted hover:text-white"
              }`}
            >
              {g}
            </button>
          ))}
        </nav>

        <div className="mb-6">
          {activeGroup === "Delayed (24h)" && (
            <div className="mb-3 rounded-md border border-border bg-bg/40 p-2 text-xs text-muted">
              Stage these one at a time: fully execute one proposal (create,
              approve, then execute) before creating the next. Two delayed
              proposals created together would both claim the same timelock
              slot and the second would fail after the first executes.
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {ACTIONS.filter((a) => a.group === activeGroup).map((a) => {
              const cur = currentValue(a);
              return (
                <div
                  key={a.id}
                  className={`rounded-md border p-3 ${
                    a.danger ? "border-danger/60" : "border-border"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{a.label}</span>
                    <span className="text-[10px] uppercase text-muted">
                      {a.mode === "squads" ? "Squads" : "Direct"}
                    </span>
                  </div>
                  {cur !== null && (
                    <div className="mb-2 break-all text-[11px] text-muted">
                      current: {cur}
                    </div>
                  )}
                  <div className="mb-2 text-[11px] leading-snug text-muted">
                    {a.tip}
                  </div>
                  {a.fields.map((f) => (
                    <div key={f.name} className="mb-2">
                      {f.kind === "bool" ? (
                        <select
                          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs"
                          value={params[a.id]?.[f.name] ?? UNCHOSEN}
                          onChange={(e) =>
                            setField(a.id, f.name, e.target.value)
                          }
                        >
                          {/* A-02: no default. A privileged two-sided switch
                              must be chosen explicitly. */}
                          <option value={UNCHOSEN}>choose...</option>
                          <option value="true">on / true</option>
                          <option value="false">off / false</option>
                        </select>
                      ) : f.kind === "select" ? (
                        <select
                          className="w-full rounded border border-border bg-bg px-2 py-1 text-xs"
                          value={params[a.id]?.[f.name] ?? UNCHOSEN}
                          onChange={(e) =>
                            setField(a.id, f.name, e.target.value)
                          }
                        >
                          <option value={UNCHOSEN}>choose...</option>
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
                      !publicKey ||
                      (a.mode === "squads" && !directAdmin && squadsBlocked)
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
                      : a.mode === "squads" && !directAdmin
                        ? "Create Squads proposal"
                        : "Sign + send now"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
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
                <span className={p.stale ? "text-muted line-through" : undefined}>
                  #{p.transactionIndex.toString()} - {p.status} -{" "}
                  {p.approvals}/{p.threshold} approvals
                </span>
                {/* Squads voids every proposal at or below `staleTransactionIndex` whenever membership
                    or the threshold changes. A voided row must not offer Approve or Execute: the click
                    wastes a fee on `StaleProposal` (0x1777) and leaves the operator unsure what still
                    needs signing. */}
                {p.stale ? (
                  <span className="rounded border border-border px-2 py-1 text-[10px] text-muted">
                    stale, voided by a later config change
                  </span>
                ) : (
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
                )}
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
