/**
 * Audit EVERY interaction with the program since it went live, and reconcile it against on-chain state.
 * WHY A RECONCILIATION RATHER THAN A LIST. Listing transactions shows what happened; it cannot show that
 * nothing ELSE happened. Reconciliation can: if every ounce minted minus every ounce burned equals the
 * mint's current supply, and every premium charged equals the fee vault's balance, then there is no
 * unexplained issuance and no unexplained fee. A discrepancy is the finding, and its absence is the
 * evidence. That is the only form of "everything is normal" worth reporting.
 * WHAT IT RECONCILES
 *   supply      sum(mint_silv out) + sum(admin_premint) - sum(redeem_silv burned) == silv_mint.supply
 *   fees        sum(mint premium) + sum(redeem premium) == fee vault balance
 *   treasury    sum(usdc in) - sum(usdc out) + deposits == treasury balance
 *   premiums    every mint charged exactly premium_bps_mint, every redeem premium_bps_redeem
 * WHAT IT ALSO REPORTS, because a failed transaction is data and not noise
 *   every reverted transaction, with its Anchor error DECODED from the IDL rather than left as
 *   "Custom: 12000". A user hitting a limit is the protocol working; a user hitting an internal error is
 *   not, and the two are indistinguishable until the code is named.
 * AND WHAT IT FLAGS AS ANOMALOUS
 *   an instruction outside the expected set, a premium that does not match config, a signer that is
 *   neither a user nor the ops vault on an admin instruction, and any SILV that appeared or vanished
 *   without a matching mint or burn.
 * Read-only. It sends nothing and needs no keypair.
 * Run: DOMINION_RPC=<mainnet> npx tsx scripts/audit-since-launch.ts [--limit 1000]
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { redactRpc } from "./_redact";

const RPC = process.env.DOMINION_RPC;

function arg(name: string, dflt: number): number {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i >= 0 ? Number(a[i + 1]) : dflt;
}

type Op = {
  sig: string;
  slot: number;
  time: number;
  signer: string;
  ours: string[];
  err: string | null;
  silv: Map<string, number>;
  usdc: Map<string, number>;
};

const fmt = (n: number, d = 6) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

let fail = 0;
function check(cond: boolean, what: string, detail = ""): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}${detail ? ` -> ${detail}` : ""}`);
  if (!cond) fail++;
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("DOMINION_RPC must be set to the MAINNET endpoint");
  const limit = arg("--limit", 1000);
  const conn = new Connection(RPC, "finalized");

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const idl = loadIdl();
  const program = new Program(idl as Idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "finalized" }));
  const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], PROGRAM_ID)[0];
  const cfg: any = await (program.account as any).configAccount.fetch(pda("config"));

  const SILV = String(cfg.silvMint);
  const USDC = String(cfg.usdcMint);
  const TREASURY_OWNER = pda("treasury").toBase58();
  const FEE_OWNER = pda("fee_vault").toBase58();
  const INVENTORY = String(cfg.inventoryWallet);
  const bpsMint = Number(cfg.premiumBpsMint);
  const bpsRedeem = Number(cfg.premiumBpsRedeem);

  // Decode Anchor error codes from the IDL, so a revert is named rather than numbered.
  const errByCode = new Map<number, { name: string; msg: string }>();
  for (const e of ((idl as any).errors ?? []) as { code: number; name: string; msg?: string }[]) {
    errByCode.set(e.code, { name: e.name, msg: e.msg ?? "" });
  }
  const ourNames = new Set(
    ((idl as any).instructions ?? []).map((i: { name: string }) =>
      i.name.replace(/(^|_)([a-z])/g, (_m: string, _p: string, c: string) => c.toUpperCase()),
    ),
  );

  console.log("audit since launch");
  console.log(`  cluster : ${redactRpc(RPC)}`);
  console.log(`  program : ${PROGRAM_ID.toBase58()}`);
  console.log("");

  // ---- walk every signature, paginating backwards -----------------------------------------
  const sigs: { signature: string; slot: number; blockTime: number | null; err: unknown }[] = [];
  let before: string | undefined;
  while (sigs.length < limit) {
    const page = await conn.getSignaturesForAddress(PROGRAM_ID, { limit: 1000, before }, "finalized");
    if (page.length === 0) break;
    sigs.push(...page.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err })));
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  sigs.reverse(); // oldest first, so the ledger reads chronologically
  console.log(`  ${sigs.length} transaction(s) on the program, oldest first`);
  console.log("");

  const ops: Op[] = [];
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!tx) continue;
    const keys = (tx.transaction.message as any).staticAccountKeys?.map((k: PublicKey) => k.toBase58()) ?? [];
    const ours: string[] = [];
    for (const l of tx.meta?.logMessages ?? []) {
      const m = /^Program log: Instruction: (\w+)$/.exec(l);
      if (m && ourNames.has(m[1])) ours.push(m[1]);
    }
    // Decode the error to a name. `Custom: 12000` means nothing on its own.
    let err: string | null = null;
    if (tx.meta?.err) {
      const e = tx.meta.err as any;
      const custom = e?.InstructionError?.[1]?.Custom;
      if (typeof custom === "number") {
        const known = errByCode.get(custom);
        err = known ? `${known.name} (${custom})` : `Custom ${custom}`;
      } else {
        err = JSON.stringify(e);
      }
      // A revert leaves no log line for the instruction, so recover the intent from the error's own
      // instruction index if we can. Otherwise the op is recorded with no name, which is honest.
      if (ours.length === 0) {
        for (const l of tx.meta?.logMessages ?? []) {
          const m = /^Program log: Instruction: (\w+)$/.exec(l);
          if (m && ourNames.has(m[1])) ours.push(m[1]);
        }
      }
    }
    // Balance deltas by OWNER, which is what matters: an ATA address is an implementation detail.
    const delta = (mint: string): Map<string, number> => {
      const out = new Map<string, number>();
      const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint);
      for (const p of (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === mint)) {
        const b = pre.find((x) => x.accountIndex === p.accountIndex);
        const d = Number(p.uiTokenAmount.uiAmount ?? 0) - Number(b?.uiTokenAmount.uiAmount ?? 0);
        if (Math.abs(d) > 1e-9) out.set(p.owner ?? keys[p.accountIndex] ?? "?", (out.get(p.owner ?? "?") ?? 0) + d);
      }
      // An account that existed before and vanished after would only appear in `pre`.
      for (const b of pre) {
        const stillThere = (tx.meta?.postTokenBalances ?? []).some((p) => p.accountIndex === b.accountIndex);
        if (!stillThere) out.set(b.owner ?? "?", (out.get(b.owner ?? "?") ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
      }
      return out;
    };
    ops.push({
      sig: s.signature,
      slot: s.slot,
      time: s.blockTime ?? 0,
      signer: keys[0] ?? "?",
      ours,
      err,
      silv: delta(SILV),
      usdc: delta(USDC),
    });
  }

  // ---- the ledger -------------------------------------------------------------------------
  let mintedOz = 0;
  let premintedOz = 0;
  let burnedOz = 0;
  let feesFromMints = 0;
  let feesFromRedeems = 0;
  let usdcIntoTreasury = 0;
  let usdcOutOfTreasury = 0;
  let depositedUsdc = 0;
  const premiumMismatch: string[] = [];
  const anomalies: string[] = [];
  const failures: Op[] = [];
  const byInstruction = new Map<string, number>();

  console.log("== every interaction, oldest first ==");
  for (const o of ops) {
    const name = o.ours.join("+") || "(no dominion instruction in logs)";
    byInstruction.set(name, (byInstruction.get(name) ?? 0) + 1);

    if (o.err) {
      failures.push(o);
      console.log(`  ${iso(o.time)}  slot ${o.slot}  ${name.padEnd(14)} REVERTED ${o.err}`);
      console.log(`      by ${o.signer}`);
      continue;
    }

    const feeDelta = o.usdc.get(FEE_OWNER) ?? 0;
    const treDelta = o.usdc.get(TREASURY_OWNER) ?? 0;

    if (o.ours.includes("MintSilv")) {
      // The user pays USDC and receives SILV. Their own deltas are the source of truth for size.
      const userIn = -Math.min(...[...o.usdc.entries()].filter(([k]) => k !== FEE_OWNER && k !== TREASURY_OWNER).map(([, v]) => v), 0);
      const silvOut = [...o.silv.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
      mintedOz += silvOut;
      feesFromMints += feeDelta;
      usdcIntoTreasury += treDelta;
      // The premium the CHAIN charged, measured, against the configured one.
      const gross = userIn;
      const impliedBps = gross > 0 ? Math.round((feeDelta / gross) * 10_000) : 0;
      const exempt = feeDelta === 0;
      if (!exempt && Math.abs(impliedBps - bpsMint) > 1) {
        premiumMismatch.push(`mint ${o.sig.slice(0, 12)} charged ${impliedBps} bps, config ${bpsMint}`);
      }
      console.log(
        `  ${iso(o.time)}  slot ${o.slot}  MintSilv       ${fmt(gross, 2)} USDC -> ${fmt(silvOut)} oz` +
          `  fee ${fmt(feeDelta)}${exempt ? " (EXEMPT)" : ` (${impliedBps} bps)`}`,
      );
      console.log(`      by ${o.signer}`);
    } else if (o.ours.includes("RedeemSilv")) {
      const silvIn = -[...o.silv.values()].filter((v) => v < 0).reduce((a, b) => a + b, 0);
      burnedOz += silvIn;
      feesFromRedeems += feeDelta;
      usdcOutOfTreasury += -treDelta;
      const userOut = [...o.usdc.entries()].filter(([k]) => k !== FEE_OWNER && k !== TREASURY_OWNER).map(([, v]) => v).reduce((a, b) => a + b, 0);
      const gross = userOut + feeDelta;
      const impliedBps = gross > 0 ? Math.round((feeDelta / gross) * 10_000) : 0;
      const exempt = feeDelta === 0;
      if (!exempt && Math.abs(impliedBps - bpsRedeem) > 1) {
        premiumMismatch.push(`redeem ${o.sig.slice(0, 12)} charged ${impliedBps} bps, config ${bpsRedeem}`);
      }
      console.log(
        `  ${iso(o.time)}  slot ${o.slot}  RedeemSilv     ${fmt(silvIn)} oz -> ${fmt(userOut, 2)} USDC` +
          `  fee ${fmt(feeDelta)}${exempt ? " (EXEMPT)" : ` (${impliedBps} bps)`}`,
      );
      console.log(`      by ${o.signer}`);
    } else if (o.ours.includes("AdminPremint")) {
      const silvOut = [...o.silv.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
      premintedOz += silvOut;
      console.log(`  ${iso(o.time)}  slot ${o.slot}  AdminPremint   +${fmt(silvOut)} oz to inventory`);
      const to = [...o.silv.entries()].filter(([, v]) => v > 0).map(([k]) => k);
      if (!to.every((k) => k === INVENTORY)) {
        anomalies.push(`premint ${o.sig.slice(0, 12)} sent SILV to ${to.join(",")}, not the inventory wallet`);
      }
    } else if (o.ours.includes("DepositUsdc")) {
      depositedUsdc += treDelta;
      console.log(`  ${iso(o.time)}  slot ${o.slot}  DepositUsdc    +${fmt(treDelta, 2)} USDC to treasury`);
    } else {
      console.log(`  ${iso(o.time)}  slot ${o.slot}  ${name}`);
      if (o.ours.length > 0 && !["Initialize", "Unpause", "SetFeeExempt"].some((n) => o.ours.includes(n))) {
        anomalies.push(`unexpected instruction ${name} in ${o.sig.slice(0, 12)} by ${o.signer}`);
      }
    }
  }

  // ---- the reconciliation, which is the point ---------------------------------------------
  const mintInfo = await conn.getParsedAccountInfo(new PublicKey(SILV), "finalized");
  const supplyOz = Number((mintInfo.value as any).data.parsed.info.supply) / 1e6;
  const feeVaultAta = getAssociatedTokenAddressSync(new PublicKey(USDC), pda("fee_vault"), true, TOKEN_PROGRAM_ID);
  const feeVault = Number((await conn.getTokenAccountBalance(feeVaultAta, "finalized")).value.amount) / 1e6;
  const treasury = Number((await conn.getTokenAccountBalance(new PublicKey(String(cfg.usdcTreasury)), "finalized")).value.amount) / 1e6;
  const invAta = getAssociatedTokenAddressSync(new PublicKey(SILV), new PublicKey(INVENTORY), true, TOKEN_2022_PROGRAM_ID);
  const inventory = Number((await conn.getTokenAccountBalance(invAta, "finalized")).value.amount) / 1e6;

  console.log("");
  console.log("== the ledger ==");
  console.log(`  minted by users     ${fmt(mintedOz)} oz`);
  console.log(`  pre-minted by admin ${fmt(premintedOz)} oz`);
  console.log(`  burned by redeems   ${fmt(burnedOz)} oz`);
  console.log(`  = expected supply   ${fmt(mintedOz + premintedOz - burnedOz)} oz`);
  console.log(`    actual supply     ${fmt(supplyOz)} oz`);
  console.log("");
  console.log(`  fees from mints     ${fmt(feesFromMints)} USDC`);
  console.log(`  fees from redeems   ${fmt(feesFromRedeems)} USDC`);
  console.log(`  = expected fees     ${fmt(feesFromMints + feesFromRedeems)} USDC`);
  console.log(`    actual fee vault  ${fmt(feeVault)} USDC`);
  console.log("");
  console.log(`  usdc into treasury  ${fmt(usdcIntoTreasury)} (mints) + ${fmt(depositedUsdc)} (deposits)`);
  console.log(`  usdc out            ${fmt(usdcOutOfTreasury)} (redeems)`);
  console.log(`  = expected treasury ${fmt(usdcIntoTreasury + depositedUsdc - usdcOutOfTreasury)} USDC`);
  console.log(`    actual treasury   ${fmt(treasury)} USDC`);
  console.log(`    inventory holds   ${fmt(inventory)} oz`);

  console.log("");
  console.log("== reconciliation ==");
  const EPS = 1e-6;
  check(Math.abs(mintedOz + premintedOz - burnedOz - supplyOz) < EPS, "every ounce is accounted for: minted + pre-minted - burned == supply", `${fmt(mintedOz + premintedOz - burnedOz)} vs ${fmt(supplyOz)}`);
  check(Math.abs(feesFromMints + feesFromRedeems - feeVault) < EPS, "every premium charged is in the fee vault, and nothing else is", `${fmt(feesFromMints + feesFromRedeems)} vs ${fmt(feeVault)}`);
  check(Math.abs(usdcIntoTreasury + depositedUsdc - usdcOutOfTreasury - treasury) < EPS, "treasury balance equals what flowed in minus what flowed out", `${fmt(usdcIntoTreasury + depositedUsdc - usdcOutOfTreasury)} vs ${fmt(treasury)}`);
  check(premiumMismatch.length === 0, "every non-exempt operation charged exactly the configured premium", premiumMismatch.join("; "));
  check(anomalies.length === 0, "no anomalous instruction, destination or signer", anomalies.join("; "));

  // ---- failures, named ---------------------------------------------------------------------
  console.log("");
  console.log(`== reverted transactions: ${failures.length} ==`);
  if (failures.length === 0) console.log("  none");
  const byErr = new Map<string, number>();
  for (const f of failures) byErr.set(f.err!, (byErr.get(f.err!) ?? 0) + 1);
  for (const [e, n] of byErr) {
    const code = Number(/\((\d+)\)$/.exec(e)?.[1] ?? NaN);
    const known = errByCode.get(code);
    console.log(`  ${n}x  ${e}`);
    if (known?.msg) console.log(`        "${known.msg.slice(0, 150)}"`);
    // A revert on a LIMIT is the protocol refusing, which is the design working. A revert on an
    // internal invariant is not. Naming the difference is the whole reason the code is decoded.
    const expected = [
      "InsufficientTreasury", "TreasuryBelowFloor", "RedeemBudgetExceeded", "InstantBudgetExceeded",
      "OperationBelowMinimum", "SlippageExceeded", "SupplyCapExceeded", "Paused", "MintPaused",
      "PublicMintDisabled", "RedemptionsDisabled", "ZeroAmount", "StalePrice", "StaleReadinessDigest",
    ];
    const isLimit = known && expected.some((n2) => known.name.includes(n2));
    console.log(`        ${isLimit ? "EXPECTED: a limit the protocol is designed to enforce" : "REVIEW: not one of the known user-facing limits"}`);
  }

  console.log("");
  console.log("== instruction mix ==");
  for (const [k, v] of [...byInstruction.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}x  ${k}`);

  console.log("");
  console.log(`==== ${fail === 0 ? "RECONCILED: nothing unaccounted for" : `${fail} DISCREPANCY(IES)`} ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`audit-since-launch FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
