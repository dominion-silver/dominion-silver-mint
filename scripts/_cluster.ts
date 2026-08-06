/**
 * THE single place a script learns which cluster it is talking to, and which cluster-specific
 * addresses go with it.
 *
 * WHY THIS FILE EXISTS: external audit 2026-08-06, finding S-01, the only P0 of that pass.
 *
 * `scripts/t1-hostile-bootstrap.ts` opened with `const RPC = "https://api.devnet.solana.com"` and
 * then called `requireDevnet(RPC, ...)`. That guard is not wrong, it was simply handed a constant:
 * `isDevnet("...devnet...")` is true, so it returned immediately and the `DOMINION_ALLOW_MAINNET`
 * branch was DEAD CODE. The mainnet runbook tells the operator to run T1 with
 * `DOMINION_ALLOW_MAINNET=i-understand` and a mainnet program id. The script would have looked for
 * that program's ProgramData ON DEVNET, funded a devnet attacker, created a devnet mint, and failed,
 * having initialised nothing. `initialize` succeeds exactly once per program id, and T1's case 5 IS
 * the real initialisation, so the ceremony would have been stranded AFTER paying for the mainnet
 * deploy. Same shape in `read-config.ts` and `e2e-lazer-mint.ts` (S-02), which ignored the
 * `DOMINION_RPC` the runbook told the operator to set.
 *
 * THE RULE THIS FILE ENFORCES: a cluster-specific value that we do not have a VERIFIED address for
 * must THROW, never silently fall back to the devnet one. Falling back is precisely what turned a
 * hardcoded constant into a P0. A loud failure before the first transaction costs a minute; a quiet
 * devnet fallback during a mainnet ceremony costs the deploy.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

export type Cluster = "devnet" | "mainnet-beta" | "localnet";

export interface ClusterContext {
  rpc: string;
  cluster: Cluster;
  /** The USDC mint the program's treasury is denominated in. */
  usdcMint: PublicKey;
  /** Pyth Lazer's fee treasury. The Lazer verify CPI pays into this. */
  lazerTreasury: PublicKey;
  /**
   * A third-party, live, UPGRADEABLE program used as the "foreign ProgramData" in T1's case 3.
   * Deliberately not a Dominion id: we retire ours, and a closed program would make case 3 pass
   * for the wrong reason.
   */
  foreignUpgradeableProgram: PublicKey;
}

const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Devnet values, verified in use by the live devnet deployment. */
const DEVNET = {
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Circle devnet USDC
  lazerTreasury: "opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7",
  foreignUpgradeableProgram: "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt", // Pyth Lazer
};

/**
 * Classify from the HOST ONLY, never the whole URL.
 *
 * REVIEW-OF-FIXES P0. The first version of this function tested `/devnet/i` against the entire URL,
 * which the security review broke in three ways, all measured:
 *
 *   https://api.mainnet-beta.solana.com/?tag=devnet-mirror       -> "devnet"
 *   https://mainnet.helius-rpc.com/?api-key=7fdevnet91-aaaa      -> "devnet"
 *   https://rpc.internal/devnet-proxy-to-mainnet                 -> "devnet"
 *
 * A query parameter, a path segment, or six characters appearing by chance inside an API key was
 * enough. And because `_guard.ts::isDevnet` uses the same test, `requireDevnet` returned early, so the
 * DOMINION_ALLOW_MAINNET consent gate never fired: `upgrade-program.ts --execute` would have run
 * `solana program extend` and `solana program deploy` against MAINNET while printing `cluster=devnet`.
 *
 * That is strictly worse than the S-01 it replaced. S-01 could only ever reach devnet; this could reach
 * mainnet while claiming devnet. `verify-cluster-resolution.ts` pinned "unknown host must be mainnet"
 * and never "known mainnet host containing the substring devnet", so the new gate could not fail on it.
 *
 * Host-only matching fixes the class rather than the three examples. The genesis-hash cross-check in
 * `assertClusterMatchesChain` is the belt to this braces: a hostname is a claim, the genesis hash is
 * what the chain actually is.
 */
export function classifyCluster(rpc: string): Cluster {
  let host: string;
  try {
    host = new URL(rpc).hostname.toLowerCase();
  } catch {
    throw new Error(
      `DOMINION_RPC is not a valid URL: ${JSON.stringify(rpc)}.\n` +
        `Refusing to guess a cluster from an unparseable endpoint.`,
    );
  }
  // Exact host or dotted-suffix match, so "devnet.example.com" counts and
  // "mainnet.helius-rpc.com/?k=devnet" does not.
  const hostIs = (needle: string) => host === needle || host.endsWith("." + needle);
  if (host === "127.0.0.1" || host === "localhost" || hostIs("localhost")) return "localnet";
  if (host === "api.devnet.solana.com" || host.startsWith("devnet.") || hostIs("devnet.solana.com")) {
    return "devnet";
  }
  if (host === "api.testnet.solana.com" || host.startsWith("testnet.")) {
    throw new Error(
      "testnet is not a supported cluster for these scripts. Use devnet or mainnet-beta.",
    );
  }
  // Anything else is mainnet. Deliberately the CONSERVATIVE default: an unrecognised RPC is far more
  // likely to be a mainnet provider (Helius, Triton, QuickNode) than a devnet one, and misclassifying
  // mainnet as devnet is the failure this file exists to prevent.
  //
  // A private devnet endpoint therefore needs DOMINION_ALLOW_MAINNET, which is friction in the safe
  // direction: the cost is one env var on an unusual setup, versus a real mainnet deploy believing it
  // is a test.
  return "mainnet-beta";
}

/** Known genesis hashes. The chain's own answer to "which cluster am I". */
const GENESIS: Record<Cluster, string | null> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  localnet: null, // a fresh validator has a random genesis hash; nothing to pin.
};

/**
 * Confirm the CHAIN agrees with the hostname before anything irreversible happens.
 *
 * A hostname is a claim made by whoever set the env var. The genesis hash is what the cluster is. Any
 * proxy, tunnel, typo or copy-paste that points a devnet-looking URL at mainnet is caught here and
 * nowhere else. Cheap: one RPC call, once, before the first transaction.
 */
export async function assertClusterMatchesChain(ctx: ClusterContext): Promise<void> {
  const expected = GENESIS[ctx.cluster];
  if (expected === null) return; // localnet
  const actual = await new Connection(ctx.rpc, "confirmed").getGenesisHash();
  if (actual !== expected) {
    const named = (Object.keys(GENESIS) as Cluster[]).find((k) => GENESIS[k] === actual);
    throw new Error(
      `CLUSTER MISMATCH. ${ctx.rpc} looks like ${ctx.cluster} by hostname, but its genesis hash is\n` +
        `  ${actual}\n` +
        `which is ${named ?? "an unknown cluster"}, not ${ctx.cluster} (${expected}).\n\n` +
        `Refusing to continue. A hostname is a claim; the genesis hash is what the chain is. This check\n` +
        `exists because a URL containing "devnet" anywhere used to be enough to bypass the\n` +
        `DOMINION_ALLOW_MAINNET consent gate entirely.`,
    );
  }
}

/**
 * Read a ceremony value out of `config/mainnet-authorities.json`, the source of truth.
 *
 * Audit finding D-01: the runbook printed premium values that disagreed with this file AND with the
 * script's own literals, three ways, on the same page. Ceremony values must be READ, not retyped,
 * so there is exactly one place to be wrong.
 */
export function mainnetConfig(): Record<string, unknown> {
  const p = path.join(__dirname, "..", "config", "mainnet-authorities.json");
  if (!fs.existsSync(p)) {
    throw new Error(`missing source of truth: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function requiredMainnetAddress(field: string): PublicKey {
  const cfg = mainnetConfig();
  const cc = (cfg.cluster_constants ?? {}) as Record<string, string | undefined>;
  const raw = cc[field];
  if (!raw) {
    throw new Error(
      `cluster_constants.${field} is missing from config/mainnet-authorities.json.\n` +
        `This script refuses to guess a mainnet address, and it will NOT fall back to the devnet\n` +
        `one: that fallback is audit finding S-01, the P0 of the 2026-08-06 external audit.\n` +
        `Add the VERIFIED address to config/mainnet-authorities.json under "cluster_constants",\n` +
        `together with how it was verified, then re-run.`,
    );
  }
  return new PublicKey(raw);
}

/**
 * Resolve the cluster from the environment. `DOMINION_RPC` wins; otherwise devnet.
 *
 * Devnet stays the default so that running a script with no environment set is still the safe,
 * boring thing it always was. What changed is that setting `DOMINION_RPC` now actually works.
 */
export function resolveCluster(): ClusterContext {
  const rpc = process.env.DOMINION_RPC?.trim() || DEFAULT_RPC.devnet;
  const cluster = classifyCluster(rpc);

  if (cluster === "devnet" || cluster === "localnet") {
    return {
      rpc,
      cluster,
      usdcMint: new PublicKey(DEVNET.usdcMint),
      lazerTreasury: new PublicKey(DEVNET.lazerTreasury),
      foreignUpgradeableProgram: new PublicKey(DEVNET.foreignUpgradeableProgram),
    };
  }

  return {
    rpc,
    cluster,
    usdcMint: requiredMainnetAddress("usdc_mint"),
    lazerTreasury: requiredMainnetAddress("lazer_treasury"),
    foreignUpgradeableProgram: requiredMainnetAddress("foreign_upgradeable_program"),
  };
}

/** Convenience: a Connection plus the resolved context, since every caller wants both. */
export function connect(): { conn: Connection; ctx: ClusterContext } {
  const ctx = resolveCluster();
  return { conn: new Connection(ctx.rpc, "confirmed"), ctx };
}

/** One line every script prints before doing anything, so the cluster is never a surprise. */
export function describeCluster(ctx: ClusterContext): string {
  return `cluster=${ctx.cluster} rpc=${ctx.rpc} usdc=${ctx.usdcMint.toBase58()}`;
}
