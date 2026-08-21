/**
 * Build a Dominion admin instruction, wrap it in a Squads v4 vault transaction on the REAL ops
 * multisig, and create the proposal. Also approves (deployer only), simulates, and executes.
 *
 * WHY THIS EXISTS AS A SCRIPT rather than ad-hoc code. The two instructions it carries, `unpause` and
 * `admin_premint`, are the two that cannot be rehearsed anywhere else: `unpause` is the go-live lever
 * and `admin_premint` issues the launch supply. Each one costs a 3-of-5 human approval round, so a
 * revert at execute time is not a retry, it is five people re-approving. Everything below exists to
 * make that impossible.
 *
 * THE CENTRAL TRICK, and the reason this is not just "create the proposal". `vaultTransactionExecute`
 * cannot be simulated before the proposal reaches threshold, so a naive flow discovers program-level
 * reverts only AFTER the humans have signed. Instead this simulates the INNER instruction directly,
 * with the vault PDA as fee payer and `sigVerify: false`, which runs the full program logic through
 * the real runtime against real accounts without needing any signature. That is what caught
 * `DominionError::Paused` on the pre-mint before a single approval was requested.
 *
 * Ordering is a hard consequence of that: `admin_premint` requires `!config.paused` (premint.rs:60),
 * and `unpause` IS the go-live. So the pre-mint cannot be simulated, let alone executed, until the
 * unpause has landed. The script refuses to create a pre-mint proposal whose simulation it could not
 * pass, unless --skip-simulation is passed deliberately.
 *
 * THE READINESS DIGEST is recomputed from the chain on every run, never hardcoded. `unpause` compares
 * `expected_readiness_digest` against `config.readiness_digest()` AT EXECUTE TIME
 * (config.rs:304-315), and the digest covers admin, silv_mint, inventory_wallet,
 * public_mint_enabled, redemptions_enabled, guardian_count, min_publishers and pyth_lazer_feed_id.
 * It does NOT cover `paused`, which is what makes a pause/unpause round trip safe. It DOES cover
 * `guardian_count`, so adding a guardian after this proposal is created silently voids it with
 * StaleReadinessDigest and the approvals have to be redone. Create the unpause LAST.
 *
 * Run:
 *   DOMINION_RPC=... DOMINION_ALLOW_MAINNET=1 npx tsx scripts/create-ops-proposal.ts \
 *     --action unpause --create --approve-with-deployer
 *   ... --action premint --amount 1500000 --create --approve-with-deployer
 *   ... --action premint --amount 1500000 --execute      (after 3 approvals)
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { requireSanctionedCluster, assertReversible, intentFromEnv } from "./_guard";
import { resolveCluster } from "./_cluster";
import { redactRpc } from "./_redact";

/* eslint-disable @typescript-eslint/no-explicit-any */
const REPO = path.resolve(__dirname, "..");
const r = createRequire(path.join(REPO, "apps/admin/"));
const {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = r("@solana/web3.js");
const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = r("@solana/spl-token");
const multisig = r("@sqds/multisig");
const anchor = r("@coral-xyz/anchor");

const CLUSTER = resolveCluster();

/** The ops multisig. Read from the env the admin panel already uses, so there is one source. */
function opsMultisig(): any {
  const v = process.env.NEXT_PUBLIC_OPS_SQUADS;
  if (!v) throw new Error("NEXT_PUBLIC_OPS_SQUADS is not set (see .env)");
  return new PublicKey(v);
}

function deployerKeypair(): any {
  const p = (
    process.env.DOMINION_KEYPAIR || path.join(os.homedir(), ".config", "solana", "dominion-dev.json")
  ).replace(/^~/, os.homedir());
  if (!fs.existsSync(p)) throw new Error(`deployer keypair not found at ${p}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/**
 * Reproduce `ConfigAccount::readiness_digest()` byte for byte. Any divergence here surfaces as
 * StaleReadinessDigest at execute time, after the approvals, which is the expensive failure.
 */
function readinessDigest(c: any): Buffer {
  const mp = Buffer.alloc(2);
  mp.writeUInt16LE(Number(c.minPublishers));
  const fid = Buffer.alloc(4);
  fid.writeUInt32LE(Number(c.pythLazerFeedId));
  return createHash("sha256")
    .update(
      Buffer.concat([
        new PublicKey(String(c.admin)).toBuffer(),
        new PublicKey(String(c.silvMint)).toBuffer(),
        new PublicKey(String(c.inventoryWallet)).toBuffer(),
        Buffer.from([c.publicMintEnabled ? 1 : 0]),
        Buffer.from([c.redemptionsEnabled ? 1 : 0]),
        Buffer.from([Number(c.guardianCount)]),
        mp,
        fid,
      ]),
    )
    .digest();
}

type Args = {
  action: "unpause" | "premint" | "deposit" | "fee-exempt" | "premium-mint" | "premium-mint-execute";
  amount?: bigint;
  create: boolean;
  approve: boolean;
  execute: boolean;
  skipSimulation: boolean;
  /** Simulate an unpause IMMEDIATELY BEFORE this action, in the same simulated transaction. */
  withUnpause: boolean;
  /** fee-exempt only. */
  wallet?: string;
  flags?: number;
  /** premium-mint only, in basis points. */
  bps?: number;
  expiresAt?: number;
  index?: bigint;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string) => {
    const i = a.indexOf(f);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const action = get("--action");
  // `as const` so the includes() check NARROWS the type: without it TypeScript keeps `action` as a
  // plain string and the Args assignment below fails, which is the compiler correctly refusing to trust
  // a runtime check it cannot see through.
  const ALLOWED = ["unpause", "premint", "deposit", "fee-exempt", "premium-mint", "premium-mint-execute"] as const;
  type Action = (typeof ALLOWED)[number];
  if (!action || !ALLOWED.includes(action as Action)) {
    throw new Error(`--action must be one of: ${ALLOWED.join(", ")}`);
  }
  const act = action as Action;
  const amountRaw = get("--amount");
  if ((act === "premint" || act === "deposit") && !amountRaw) {
    throw new Error(`--action ${act} requires --amount (atomic, 6 decimals)`);
  }
  const idx = get("--index");
  return {
    action: act,
    wallet: get("--wallet"),
    bps: get("--bps") ? Number(get("--bps")) : undefined,
    flags: get("--flags") ? Number(get("--flags")) : undefined,
    expiresAt: get("--expires-at") ? Number(get("--expires-at")) : undefined,
    amount: amountRaw ? BigInt(amountRaw) : undefined,
    create: a.includes("--create"),
    approve: a.includes("--approve-with-deployer"),
    execute: a.includes("--execute"),
    skipSimulation: a.includes("--skip-simulation"),
    withUnpause: a.includes("--with-unpause"),
    index: idx ? BigInt(idx) : undefined,
  };
}

async function confirmFinalized(conn: any, sig: string, label: string): Promise<void> {
  // READ THE TRANSACTION BACK AT FINALIZED, never trust a `confirmed` read-back. This session
  // produced three false negatives from immediate confirmed reads on a load-balanced endpoint, two
  // of which had actually succeeded. A reflexive re-send there would have been a double execution.
  for (let i = 0; i < 40; i++) {
    const tx = await conn.getTransaction(sig, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      if (tx.meta?.err) throw new Error(`${label} FAILED on chain: ${JSON.stringify(tx.meta.err)}`);
      console.log(`    ${label} finalized, slot ${tx.slot}`);
      return;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`${label} not finalized after 120s. DO NOT RE-SEND. Check ${sig} manually.`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  await requireSanctionedCluster(CLUSTER.rpc, "create-ops-proposal");
  // RULE 2, at the honest granularity. CREATING a proposal is `propose_any`, genuinely reversible:
  // it can be cancelled, and nothing on the Dominion side has moved. EXECUTING it is the real action,
  // so it is gated under its own name in ACTION_COST. `admin_premint` is classified `irreversible`
  // there, and correctly: there is NO admin burn in this program, the only burn requires the holder's
  // signature inside redeem_silv, so an over-mint cannot be undone. Executing it therefore needs
  // DOMINION_INTENT=admin_premint spelled out, which is exactly the friction that classification was
  // added for.
  if (args.execute) {
    const named =
      args.action === "unpause"
        ? "unpause"
        : args.action === "premint"
          ? "admin_premint"
          : args.action === "deposit"
            ? "deposit_usdc"
            : args.action === "fee-exempt"
              ? "set_fee_exempt"
              : args.action === "premium-mint"
                ? "propose_set_premium_mint"
                : "execute_set_premium_mint";
    assertReversible(named, intentFromEnv());
  }
  else if (args.create) assertReversible("propose_any", intentFromEnv());

  const conn = new Connection(CLUSTER.rpc, "confirmed");
  const deployer = deployerKeypair();
  const OPS = opsMultisig();
  const [vault] = multisig.getVaultPda({ multisigPda: OPS, index: 0 });

  const idl = JSON.parse(fs.readFileSync(path.join(REPO, "target/idl/dominion_silver_mint.json"), "utf8"));
  const PROGRAM_ID = new PublicKey(idl.address);
  const provider = new anchor.AnchorProvider(
    conn,
    {
      publicKey: deployer.publicKey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    },
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
  const cfg: any = await program.account.configAccount.fetch(configPda);

  console.log(`ops proposal :: ${args.action}`);
  console.log(`  cluster   : ${redactRpc(CLUSTER.rpc)} (${CLUSTER.cluster})`);
  console.log(`  program   : ${PROGRAM_ID.toBase58()}`);
  console.log(`  multisig  : ${OPS.toBase58()}`);
  console.log(`  vault     : ${vault.toBase58()}`);
  console.log(`  deployer  : ${deployer.publicKey.toBase58()}`);
  console.log("");

  // ---- refusals that apply to every action -------------------------------------------------
  if (vault.toBase58() !== String(cfg.admin)) {
    throw new Error(
      `vault ${vault.toBase58()} is NOT config.admin ${String(cfg.admin)}. Wrong multisig: every ` +
        `instruction here would revert ConstraintHasOne after the approvals.`,
    );
  }
  const ms: any = await multisig.accounts.Multisig.fromAccountAddress(conn, OPS);
  const me = ms.members.find((m: any) => m.key.toBase58() === deployer.publicKey.toBase58());
  if (!me) throw new Error(`deployer is not a member of ${OPS.toBase58()}`);
  const bal = await conn.getBalance(deployer.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error(`deployer has ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL, too low to pay fees`);
  }
  console.log(`  threshold ${ms.threshold} of ${ms.members.length}, timeLock ${ms.timeLock}s`);
  console.log(`  transactionIndex ${ms.transactionIndex}, stale below ${ms.staleTransactionIndex}`);

  // ---- build the inner instruction, with the action's own refusals -------------------------
  /**
   * Build the unpause instruction. Factored out because it is needed TWICE: as the proposal's own
   * payload, and as a simulation-only prefix in front of a pre-mint (see --with-unpause below).
   */
  const buildUnpauseIx = async (): Promise<any> => {
    if (Number(cfg.guardianCount) === 0) throw new Error("guardian_count is 0: unpause reverts NoActiveGuardian");
    const guardians = await (program.account as any).guardianAccount.all();
    const usable = guardians.filter(
      (g: any) => String(g.account.guardian) !== String(cfg.admin) && Number(g.account.cooldownUntil ?? 0) === 0,
    );
    if (usable.length === 0) {
      throw new Error(
        "no guardian is both independent of the admin and out of cooldown. unpause would revert " +
          "GuardianNotIndependent or GuardianInCooldown. Run add_guardian first, then rebuild this " +
          "proposal (guardian_count is in the readiness digest).",
      );
    }
    const g = usable[0];
    const digest = readinessDigest(cfg);
    console.log(`  guardian  : ${g.publicKey.toBase58()} (key ${String(g.account.guardian)})`);
    console.log(`  digest    : ${digest.toString("hex")}`);
    return program.methods
      .unpause([...digest])
      .accounts({ config: configPda, admin: vault, guardian: g.publicKey })
      .instruction();
  };

  // AN ARRAY, not one instruction. A Squads vault transaction carries as many instructions as fit, so
  // changing two whitelists costs ONE 3-of-5 round instead of two. The simulation below runs the whole
  // batch, so a batch that would revert is refused before anyone is asked to approve.
  let innerIxs: any[] = [];
  if (args.action === "unpause") {
    if (!cfg.paused) throw new Error("config.paused is already false. Nothing to unpause.");
    // The guardian is a plain account here, NOT a signer (unpause IDL). So this is an ops-only
    // 3-of-5, not a coordination of both multisigs. It still has to be an INDEPENDENT guardian.
    innerIxs = [await buildUnpauseIx()];
  } else if (args.action === "premint") {
    const amount = args.amount!;
    if (amount <= BigInt(0)) throw new Error("--amount must be > 0 (admin_premint reverts ZeroAmount)");
    const inventory = new PublicKey(String(cfg.inventoryWallet));
    if (inventory.equals(PublicKey.default)) throw new Error("config.inventory_wallet is unset");

    // allowOwnerOffCurve = true is MANDATORY: inventory_wallet is a Squads vault PDA.
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(String(cfg.silvMint)),
      inventory,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const ataInfo = await conn.getAccountInfo(ata, "finalized");
    if (!ataInfo) {
      throw new Error(
        `inventory SILV ATA ${ata.toBase58()} does not exist. admin_premint takes it as an existing ` +
          `account and would revert AccountNotInitialized. Run scripts/create-inventory-silv-ata.ts.`,
      );
    }
    const mintAcc = await conn.getParsedAccountInfo(new PublicKey(String(cfg.silvMint)), "finalized");
    const supply = BigInt((mintAcc.value as any).data.parsed.info.supply);
    const decimals = Number((mintAcc.value as any).data.parsed.info.decimals);
    const cap = BigInt(cfg.maxSilvSupply.toString());
    if (supply + amount > cap) {
      throw new Error(
        `supply_post ${supply + amount} exceeds max_silv_supply ${cap}: reverts SupplyCapExceeded`,
      );
    }
    const [mintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("silv_mint_authority")],
      PROGRAM_ID,
    );
    console.log(`  inventory : ${inventory.toBase58()}`);
    console.log(`  ATA       : ${ata.toBase58()}`);
    console.log(
      `  amount    : ${amount} atomic = ${Number(amount) / 10 ** decimals} oz` +
        `  (supply ${supply} -> ${supply + amount} / cap ${cap})`,
    );
    if (cfg.paused) {
      console.log("");
      console.log("  *** config.paused is TRUE. admin_premint reverts Paused (premint.rs:60).");
      console.log("  *** The unpause has to execute FIRST. Order: unpause -> premint.");
    }
    innerIxs = [await program.methods
      .adminPremint(new anchor.BN(amount.toString()))
      .accounts({
        config: configPda,
        admin: vault,
        silvMint: new PublicKey(String(cfg.silvMint)),
        inventorySilvAta: ata,
        silvMintAuthority: mintAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .instruction()];
  } else if (args.action === "deposit") {
    // DEPOSIT. `deposit_usdc` is permissionless (`pub user: Signer`, no admin constraint), so this
    // path exists only because the SOURCE is the ops vault's own USDC account: moving tokens out of a
    // Squads vault needs the vault's signature, and that is the 3-of-5. A partner replenishing the
    // treasury from their OWN wallet needs no proposal at all - they sign `deposit_usdc` themselves.
    //
    // Why route a partner's USDC through the vault instead: `config.usdc_treasury` is a TOKEN account
    // and off-curve, so pasting it into a wallet or an exchange withdrawal form is at best a loud
    // failure and at worst an ATA derived from it that nothing can sign for. A Squads vault is a
    // normal, documented deposit address, and the funds stay under 3-of-5 the whole way.
    const amount = args.amount!;
    if (amount <= BigInt(0)) throw new Error("--amount must be > 0");
    if (amount < BigInt(1_000_000)) {
      throw new Error("deposit_usdc refuses below 1 USDC (MIN_DEPOSIT_USDC in deposit_usdc.rs)");
    }
    const usdcMint = new PublicKey(String(cfg.usdcMint));
    const treasury = new PublicKey(String(cfg.usdcTreasury));
    // allowOwnerOffCurve: the vault is a PDA.
    const vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vault, true, TOKEN_PROGRAM_ID);
    const src = await conn.getTokenAccountBalance(vaultUsdcAta, "finalized").catch(() => null);
    if (!src) {
      throw new Error(`the vault has no USDC account at ${vaultUsdcAta.toBase58()}. Send USDC to the vault first.`);
    }
    const held = BigInt(src.value.amount);
    if (held < amount) {
      throw new Error(
        `the vault holds ${Number(held) / 1e6} USDC at ${vaultUsdcAta.toBase58()}, needs ${Number(amount) / 1e6}.`,
      );
    }
    const treBal = await conn.getTokenAccountBalance(treasury, "finalized");
    console.log(`  source    : ${vaultUsdcAta.toBase58()} (vault USDC), holds ${Number(held) / 1e6}`);
    console.log(`  treasury  : ${treasury.toBase58()}, holds ${treBal.value.uiAmountString}`);
    console.log(`  amount    : ${amount} atomic = ${Number(amount) / 1e6} USDC`);
    innerIxs = [await program.methods
      .depositUsdc(new anchor.BN(amount.toString()))
      .accounts({
        config: configPda,
        user: vault,
        usdcMint,
        usdcTreasury: treasury,
        userUsdcAta: vaultUsdcAta,
        classicTokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction()];
  }

  if (args.action === "premium-mint-execute") {
    // EXECUTE the queued premium change. This applies the new value AND clears
    // `pending_premium_mint_nonce`, which is what actually lets minting resume: the timelock elapsing
    // is NOT enough on its own, by design, or mints would restart at the OLD premium in the gap.
    const nonce = cfg.pendingPremiumMintNonce;
    if (nonce === null) {
      throw new Error("no mint-premium change is queued: pending_premium_mint_nonce is null. Nothing to execute.");
    }
    const n = BigInt(nonce.toString());
    const nonceLe = Buffer.alloc(8);
    nonceLe.writeBigUInt64LE(n);
    const [timelockPda] = PublicKey.findProgramAddressSync([Buffer.from("timelock"), nonceLe], PROGRAM_ID);

    // Read the queued value out of the timelock account rather than taking it on trust from a flag.
    const tl: any = await (program.account as any).timelockQueueAccount.fetch(timelockPda);
    const queuedBps = Buffer.from(tl.actionData).readUInt16LE(0);
    const executableAt = Number(tl.executableAt);
    const nowSec = Math.floor(Date.now() / 1000);

    console.log(`  queued    : ${Number(cfg.premiumBpsMint)} bps -> ${queuedBps} bps`);
    console.log(`  nonce     : ${n}   timelock PDA ${timelockPda.toBase58()}`);
    console.log(
      `  executable: ${new Date(executableAt * 1000).toISOString().slice(0, 16).replace("T", " ")}Z` +
        `  (${nowSec >= executableAt ? `elapsed ${Math.floor((nowSec - executableAt) / 60)} min ago` : `in ${Math.ceil((executableAt - nowSec) / 60)} min`})`,
    );
    if (tl.cancelled) throw new Error("this timelocked action was CANCELLED; it cannot execute.");
    if (tl.executedAt !== null) throw new Error("this timelocked action has ALREADY executed.");
    if (nowSec < executableAt) {
      throw new Error(`the timelock has NOT elapsed: reverts TimelockNotElapsed. Wait ${Math.ceil((executableAt - nowSec) / 60)} more minutes.`);
    }
    console.log("");
    console.log("  This RESUMES minting: it clears pending_premium_mint_nonce, which is the check still");
    console.log("  refusing every mint even though mint_paused_until has passed.");
    console.log("");

    innerIxs = [
      await program.methods
        .executeSetPremiumMint(new anchor.BN(n.toString()))
        .accounts({
          config: configPda,
          admin: vault,
          timelock: timelockPda,
          // Rent from the closed timelock account goes back to the vault that paid for it.
          rentRecipient: new PublicKey(String(tl.rentPayer)),
        })
        .instruction(),
    ];
  }

  if (args.action === "premium-mint") {
    // PROPOSE a new mint premium. This is the ONE action here that takes a service DOWN, so the
    // console shouts about it rather than printing a diff.
    const bps = args.bps;
    if (bps === undefined || !Number.isInteger(bps) || bps < 0) {
      throw new Error("--bps is required, an integer number of basis points (5 = 0.05%)");
    }
    const CEILING = 500; // PREMIUM_BPS_MINT_CEILING, config.rs:4
    if (bps > CEILING) throw new Error(`--bps ${bps} exceeds PREMIUM_BPS_MINT_CEILING ${CEILING}`);
    const current = Number(cfg.premiumBpsMint);
    if (bps === current) throw new Error(`--bps ${bps} equals the current premium: reverts ProposalNoOp`);
    if (cfg.pendingPremiumMintNonce !== null) {
      throw new Error(
        `a mint-premium proposal is ALREADY active (nonce ${String(cfg.pendingPremiumMintNonce)}). ` +
          `Reverts ProposalAlreadyActive. Execute or cancel it first.`,
      );
    }
    const MAX_ACTIVE = 10; // MAX_ACTIVE_PROPOSALS, config.rs:12
    const active = Number(cfg.activeProposalCount ?? 0);
    if (active >= MAX_ACTIVE) throw new Error(`active_proposal_count is ${active}, the cap is ${MAX_ACTIVE}`);

    // The timelock account is created by the instruction at seeds ["timelock", next_timelock_nonce].
    const nonce = BigInt(cfg.nextTimelockNonce.toString());
    const nonceLe = Buffer.alloc(8);
    nonceLe.writeBigUInt64LE(nonce);
    const [timelockPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("timelock"), nonceLe],
      PROGRAM_ID,
    );
    const timelockSecs = Number(cfg.adminTimelockSeconds);
    const executableAt = new Date((Math.floor(Date.now() / 1000) + timelockSecs) * 1000);

    console.log(`  premium   : ${current} bps -> ${bps} bps  (${(current / 100).toFixed(2)}% -> ${(bps / 100).toFixed(2)}%)`);
    console.log(`  timelock  : ${timelockSecs}s, executable from ${executableAt.toISOString().slice(0, 16).replace("T", " ")}Z`);
    console.log(`  nonce     : ${nonce}   timelock PDA ${timelockPda.toBase58()}`);
    console.log("");
    console.log("  *** THIS PAUSES ALL MINTING THE MOMENT IT LANDS, AND UNTIL IT EXECUTES.");
    console.log("  *** mint_silv refuses on both `mint_paused_until` and `pending_premium_mint_nonce`");
    console.log("  *** (mint_silv.rs:139-146), so the site, the market makers and any direct call all");
    console.log("  *** revert with MintPaused for at least the timelock above. Redemptions keep working.");
    console.log("  *** Undoing it is cancel_timelocked_action, another 3-of-5, and mints stay down until then.");
    console.log("");

    innerIxs = [
      await program.methods
        .proposeSetPremiumMint(bps)
        .accounts({
          config: configPda,
          admin: vault,
          timelock: timelockPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  if (args.action === "fee-exempt") {
    // FEE EXEMPTION. `set_fee_exempt(wallet, flags, expires_at)`, admin-only, so a 3-of-5.
    //
    // `flags` is a Side bitfield (state/side.rs): bit 0 mint, bit 1 redeem, 3 both. The handler itself
    // notes that BOTH bits set, a term near the cap, or a self-grant by the admin are worth alerting on,
    // so those are decisions to make explicitly rather than defaults to inherit.
    //
    // `expires_at` is MANDATORY and every part of that is enforced (audit C-01): unix SECONDS, strictly
    // in the future, at most MAX_FEE_EXEMPT_TERM_SECONDS (2 years) away, and ZERO IS REFUSED because zero
    // is not an indefinite term. A 13-digit millisecond paste is rejected by the same rail, which is why
    // the digit count is checked here too: the revert message is clear but it arrives after three people
    // have approved.
    // COMMA-SEPARATED, so several wallets go in ONE proposal and cost ONE 3-of-5 round.
    const wallets = (args.wallet ?? "").split(",").map((w) => w.trim()).filter(Boolean);
    if (wallets.length === 0) throw new Error("--action fee-exempt requires --wallet <pubkey>[,<pubkey>...]");
    const flags = args.flags;
    if (flags === undefined || !Number.isInteger(flags) || flags < 1 || flags > 3) {
      throw new Error("--flags must be 1 (mint), 2 (redeem) or 3 (both)");
    }
    const expiresAt = args.expiresAt;
    if (expiresAt === undefined || !Number.isInteger(expiresAt)) {
      throw new Error("--expires-at is MANDATORY: a unix timestamp in SECONDS (zero is refused on chain)");
    }
    if (String(expiresAt).length !== 10) {
      throw new Error(
        `--expires-at ${expiresAt} has ${String(expiresAt).length} digits. Seconds are 10; a 13-digit ` +
          `millisecond value is refused on chain and would waste a 3-of-5 round.`,
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt <= nowSec) throw new Error(`--expires-at ${expiresAt} is not in the future`);
    const MAX_TERM = 2 * 365 * 86400;
    if (expiresAt - nowSec > MAX_TERM) {
      throw new Error(`--expires-at is ${((expiresAt - nowSec) / 86400).toFixed(0)} days away, the cap is 730`);
    }
    console.log(
      `  flags     : ${flags} (${flags & 1 ? "mint" : ""}${flags === 3 ? "+" : ""}${flags & 2 ? "redeem" : ""})`,
    );
    console.log(
      `  expires   : ${expiresAt} = ${new Date(expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")}Z` +
        ` (${((expiresAt - nowSec) / 86400).toFixed(0)} days)`,
    );
    innerIxs = [];
    for (const w of wallets) {
      const walletPk = new PublicKey(w);
      const [feeExemptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_exempt"), walletPk.toBuffer()],
        PROGRAM_ID,
      );
      const already = await conn.getAccountInfo(feeExemptPda, "finalized");
      let currentFlags = "";
      if (already) {
        // Show what is being REPLACED. `set_fee_exempt` is `init_if_needed` and the handler rewrites
        // every field, so this overwrites rather than failing, and there is no window where the wallet
        // pays full price on both sides. Printing the old flags makes the change auditable at a glance.
        const acc: any = await (program.account as any).feeExemptAccount.fetch(feeExemptPda);
        currentFlags = ` flags ${Number(acc.flags)} -> ${flags}`;
      }
      console.log(`  wallet    : ${w}`);
      console.log(`  fee_exempt: ${feeExemptPda.toBase58()}${already ? ` (EXISTS,${currentFlags}, overwritten)` : " (new)"}`);
      if (walletPk.equals(vault)) {
        console.log("  *** this wallet IS the admin vault: a self-grant, which the handler flags as notable.");
      }
      innerIxs.push(
        await program.methods
          .setFeeExempt(walletPk, flags, new anchor.BN(expiresAt))
          .accounts({
            config: configPda,
            admin: vault,
            feeExempt: feeExemptPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
    }
  }

  // ---- SIMULATE THE INNER INSTRUCTION ------------------------------------------------------
  // The whole point. `vaultTransactionExecute` cannot be simulated before threshold, so simulate the
  // inner ix directly with the vault as payer and sigVerify off: the runtime executes the program
  // logic against the real accounts and reports the real error, with no signature needed.
  console.log("");
  // --with-unpause: THE FULL-CEREMONY PRE-FLIGHT. `admin_premint` reverts Paused, so it cannot be
  // simulated against the live paused state, and creating its proposal blind means discovering any
  // OTHER defect after three humans have signed. Simulating [unpause, premint] as ONE transaction
  // removes that blind spot entirely: the runtime applies the unpause to the simulated state, then
  // runs the pre-mint against it. Nothing is sent, the chain stays paused, and both instructions are
  // proven end to end before a single approval is requested. The prefix is simulation-only and never
  // enters the proposal.
  const simIxs: any[] = [];
  if (args.withUnpause) {
    if (args.action === "unpause") throw new Error("--with-unpause is meaningless on --action unpause");
    if (!cfg.paused) {
      console.log("  --with-unpause ignore: la chaine n'est deja plus en pause.");
    } else {
      console.log("  --with-unpause: l'unpause est simule JUSTE AVANT, dans la meme transaction simulee.");
      simIxs.push(await buildUnpauseIx());
    }
  }
  simIxs.push(...innerIxs);
  console.log(
    `  simulation de ${simIxs.length} instruction(s) (sigVerify off, vault en payeur) ...`,
  );
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  const simMsg = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: blockhash,
    instructions: simIxs,
  }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(simMsg), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  const simOk = !sim.value.err;
  if (simOk) {
    console.log("    SIMULATION OK: l'instruction passe contre l'etat reel de la chaine.");
  } else {
    console.log(`    SIMULATION EN ECHEC: ${JSON.stringify(sim.value.err)}`);
    for (const l of sim.value.logs ?? []) if (/Error|error|failed/.test(l)) console.log(`      ${l}`);
    if (!args.skipSimulation) {
      throw new Error(
        "refus: la simulation echoue, donc l'execution echouerait APRES les trois approbations. " +
          "Corrige la cause, ou passe --skip-simulation en connaissance de cause (par exemple pour " +
          "creer d'avance un premint qui attend son unpause).",
      );
    }
    console.log("    --skip-simulation: on continue malgre l'echec, deliberement.");
  }

  const transactionIndex = args.index ?? BigInt(ms.transactionIndex.toString()) + BigInt(1);
  const [proposalPda] = multisig.getProposalPda({ multisigPda: OPS, transactionIndex });
  console.log("");
  console.log(`  transaction index : ${transactionIndex}`);
  console.log(`  proposal PDA      : ${proposalPda.toBase58()}`);

  // ---- create -----------------------------------------------------------------------------
  if (args.create) {
    const existing = await conn.getAccountInfo(proposalPda, "finalized");
    if (existing) {
      console.log("    la proposition existe deja a cet index, rien a creer.");
    } else {
      const { blockhash: bh } = await conn.getLatestBlockhash("finalized");
      const innerMessage = new TransactionMessage({
        payerKey: vault,
        recentBlockhash: bh,
        instructions: innerIxs,
      });
      const sig1 = await multisig.rpc.vaultTransactionCreate({
        connection: conn,
        feePayer: deployer,
        multisigPda: OPS,
        transactionIndex,
        creator: deployer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0, // neither ix creates a keypair account
        transactionMessage: innerMessage,
      });
      await confirmFinalized(conn, sig1, "vaultTransactionCreate");
      const sig2 = await multisig.rpc.proposalCreate({
        connection: conn,
        feePayer: deployer,
        creator: deployer,
        multisigPda: OPS,
        transactionIndex,
      });
      await confirmFinalized(conn, sig2, "proposalCreate");
    }
  }

  // ---- approve (deployer only; the other members approve from the Squads UI) ---------------
  if (args.approve) {
    const p: any = await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda);
    const already = (p.approved ?? []).some((k: any) => k.toBase58() === deployer.publicKey.toBase58());
    if (already) {
      console.log("    le deployer a deja approuve.");
    } else {
      const sig = await multisig.rpc.proposalApprove({
        connection: conn,
        feePayer: deployer,
        member: deployer,
        multisigPda: OPS,
        transactionIndex,
      });
      await confirmFinalized(conn, sig, "proposalApprove(deployer)");
    }
  }

  // ---- status -----------------------------------------------------------------------------
  // Tolerant of absence ON PURPOSE: with no --create this script is a pre-flight, and the whole value
  // of that mode is being able to run it before the proposal exists.
  const propInfo = await conn.getAccountInfo(proposalPda, "finalized");
  if (!propInfo) {
    console.log("");
    console.log("  la proposition n'existe pas encore a cet index (mode pre-vol, rien n'a ete envoye).");
    console.log("  pour la creer : ajoute --create --approve-with-deployer");
    return;
  }
  const p: any = await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda);
  const approvals = (p.approved ?? []).length;
  console.log("");
  console.log(`  statut     : ${p.status?.__kind}`);
  console.log(`  approbations: ${approvals} / ${ms.threshold} requises`);
  for (const k of p.approved ?? []) console.log(`     approuve  ${k.toBase58()}`);
  for (const k of p.rejected ?? []) console.log(`     REJETE    ${k.toBase58()}`);
  if (transactionIndex <= BigInt(ms.staleTransactionIndex.toString())) {
    console.log("  *** PERIMEE: index <= staleTransactionIndex, cette proposition ne peut plus executer.");
  }

  // ---- execute ----------------------------------------------------------------------------
  if (args.execute) {
    if (approvals < ms.threshold) {
      throw new Error(`refus d'executer: ${approvals} approbations sur ${ms.threshold} requises.`);
    }
    if (!simOk) {
      throw new Error("refus d'executer: la simulation de l'instruction interne echoue.");
    }
    console.log("");
    console.log("  EXECUTION ...");
    const sig = await multisig.rpc.vaultTransactionExecute({
      connection: conn,
      feePayer: deployer,
      multisigPda: OPS,
      transactionIndex,
      member: deployer.publicKey,
    });
    await confirmFinalized(conn, sig, "vaultTransactionExecute");
    console.log(`    SIGNATURE ${sig}`);
    console.log(`    https://solscan.io/tx/${sig}`);

    // Read the effect back at finalized, not the transaction status.
    const after: any = await program.account.configAccount.fetch(configPda);
    if (args.action === "unpause") {
      console.log(`    config.paused apres : ${after.paused} ${after.paused === false ? "OK" : "*** TOUJOURS EN PAUSE ***"}`);
    } else {
      const m = await conn.getParsedAccountInfo(new PublicKey(String(cfg.silvMint)), "finalized");
      console.log(`    supply SILV apres   : ${(m.value as any).data.parsed.info.supply} atomic`);
    }
  }
}

main().catch((e) => {
  console.error(`\ncreate-ops-proposal FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
