/**
 * THE single place a script learns which cluster it is on, and which cluster-specific addresses go with it.
 * No script may hardcode an RPC or a cluster constant: a literal containing "devnet" satisfies the guard on
 * its first line, making the mainnet consent branch dead code. And a cluster-specific value we have no
 * VERIFIED address for must THROW, never fall back to the devnet one: `initialize` succeeds once per
 * program id, so a quiet devnet fallback mid-ceremony costs the deploy.
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
  /** A third-party, live, UPGRADEABLE program: the "foreign ProgramData" in T1's case 3. Never a Dominion
   *  id, since we retire ours and a closed program makes case 3 pass for the wrong reason. */
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

/** Classify from the HOST ONLY, never the whole URL: a query parameter, a path segment or six characters
 *  inside an API key make a mainnet endpoint match /devnet/i, and `_guard.ts::isDevnet` turns on this
 *  result, so a substring match here silently disables the mainnet consent gate. */
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
  // Exact host or dotted-suffix match: "devnet.example.com" counts, "mainnet.helius-rpc.com/?k=devnet" does not.
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
  // Anything else is mainnet, the CONSERVATIVE default: misclassifying mainnet as devnet is the failure this
  // file prevents. A private devnet endpoint therefore needs DOMINION_ALLOW_MAINNET, friction the safe way.
  return "mainnet-beta";
}

/** Known genesis hashes. The chain's own answer to "which cluster am I". */
const GENESIS: Record<Cluster, string | null> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  localnet: null, // a fresh validator has a random genesis hash; nothing to pin.
};

/** Confirm the CHAIN agrees with the hostname before anything irreversible happens. A hostname is a claim
 *  by whoever set the env var; the genesis hash is what the cluster IS. Any proxy, tunnel or typo pointing
 *  a devnet-looking URL at mainnet is caught here and nowhere else, for one RPC call. */
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

/** Read a ceremony value out of `config/mainnet-authorities.json`, the source of truth. Ceremony values are
 *  READ, never retyped into a script, so there is exactly one place to be wrong (audit D-01). */
export function mainnetConfig(): Record<string, unknown> {
  // `DOMINION_MAINNET_CONFIG` lets the cluster gate test against a TEMP COPY. Nothing else sets it.
  const p =
    process.env.DOMINION_MAINNET_CONFIG ||
    path.join(__dirname, "..", "config", "mainnet-authorities.json");
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

/** Resolve the cluster from the environment: `DOMINION_RPC` wins, otherwise devnet, so a bare run is safe. */
export function resolveCluster(): ClusterContext {
  const explicit = process.env.DOMINION_RPC?.trim();
  // Two env vars that contradict each other must not both be honoured silently. Refusing beats picking a
  // winner: guessing mainnet deploys somewhere the operator did not name, and guessing devnet runs the
  // whole mainnet ceremony on devnet.
  if (!explicit && process.env.DOMINION_ALLOW_MAINNET) {
    throw new Error(
      "DOMINION_ALLOW_MAINNET is set but DOMINION_RPC is not.\n" +
        "Those two say opposite things: the first means you intend to touch a real cluster, the second\n" +
        "defaulting to devnet means you do not. This script will not choose for you.\n\n" +
        "Set DOMINION_RPC explicitly, e.g.\n" +
        "  DOMINION_RPC=https://api.mainnet-beta.solana.com\n" +
        "  DOMINION_RPC=https://api.devnet.solana.com",
    );
  }
  const rpc = explicit || DEFAULT_RPC.devnet;
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

/** The context for an ARBITRARY rpc: `resolveCluster()` reads DOMINION_RPC, while the guard validates a URL
 *  handed to it. Both share this classifier and address table, so they cannot disagree about the cluster. */
export function resolveClusterFor(rpc: string): ClusterContext {
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

export function connect(): { conn: Connection; ctx: ClusterContext } {
  const ctx = resolveCluster();
  return { conn: new Connection(ctx.rpc, "confirmed"), ctx };
}

/** One line every script prints before doing anything, so the cluster is never a surprise. */
export function describeCluster(ctx: ClusterContext): string {
  return `cluster=${ctx.cluster} rpc=${ctx.rpc} usdc=${ctx.usdcMint.toBase58()}`;
}
