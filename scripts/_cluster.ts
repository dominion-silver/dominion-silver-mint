/**
 * THE single place a script learns which cluster it is on, and which cluster-specific addresses go with it.
 * No script may hardcode an RPC or a cluster constant: a literal containing "devnet" satisfies the guard on
 * its first line, making the mainnet consent branch dead code. And a cluster-specific value we have no
 * VERIFIED address for must THROW, never fall back to the devnet one: `initialize` succeeds once per
 * program id, so a quiet devnet fallback mid-ceremony costs the deploy.
 */
import { describeUnparseable } from "./_redact";
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
      `DOMINION_RPC is not a valid URL: ${describeUnparseable(rpc)}.\n` +
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

/** EVERY public cluster, including the ones we do not support.
 * The localnet negative check used to be built from `GENESIS`, which is keyed on the `Cluster` type,
 * and `Cluster` has no testnet member because these scripts refuse testnet by hostname. So a tunnel
 *  from 127.0.0.1 to `api.testnet.solana.com` reached the chain, matched nothing in `GENESIS`, and was
 *  accepted as an unknown local validator. Reproduced by the auditor through a local HTTP proxy.
 * The list a denylist needs is "public chains", not "chains we have a Cluster variant for". Tying it
 *  to the type was the defect. Anything reachable and publicly known belongs here. */
const PUBLIC_GENESIS: Record<string, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};

/** Which public cluster a genesis hash belongs to, or null if it is not a public chain we know. */
export function publicClusterOfGenesis(genesis: string): string | null {
  return Object.keys(PUBLIC_GENESIS).find((k) => PUBLIC_GENESIS[k] === genesis) ?? null;
}

/** Confirm the CHAIN agrees with the hostname before anything irreversible happens. A hostname is a claim
 *  by whoever set the env var; the genesis hash is what the cluster IS. Any proxy, tunnel or typo pointing
 *  a devnet-looking URL at mainnet is caught here and nowhere else, for one RPC call. */
export async function assertClusterMatchesChain(ctx: ClusterContext): Promise<void> {
  const expected = GENESIS[ctx.cluster];
  const actual = await new Connection(ctx.rpc, "confirmed").getGenesisHash();

  // localnet used to `return` here BEFORE any RPC call, because a fresh
  // validator has a random genesis hash and there is nothing to pin. But localnet is also exempt from
  // the consent gate (`_guard.ts::guardConsentOnly`) and from the release-pin gate
  // (`upgrade-program.ts::decideUpgradeGate`, which keys on the literal "mainnet-beta"), and any
  // 127.0.0.1, localhost or *.localhost URL classifies as localnet. An SSH tunnel or a local RPC proxy
  // pointed at mainnet therefore reached `solana program deploy` with an unpinned local .so, no
  // consent prompt and no genesis check: three gates off at once through one carve-out.
  // We cannot say what a local genesis hash SHOULD be. We can say what it must NOT be, and that is
  // enough, because the attack needs the tunnel to terminate on a real cluster, and a real cluster has
  // a known hash.
  if (expected === null) {
    const reached = publicClusterOfGenesis(actual);
    if (reached) {
      throw new Error(
        `CLUSTER MISMATCH. ${ctx.rpc} classifies as localnet by hostname, but its genesis hash is\n` +
          `  ${actual}\n` +
          `which is ${reached}. A local address reaching a public cluster is a tunnel or a proxy.\n\n` +
          `Refusing to continue. localnet is exempt from the mainnet consent gate AND from the release\n` +
          `pin gate, so this path would have sent an unattested binary to ${reached} in silence.\n` +
          `Point DOMINION_RPC at the real endpoint and take the gates that come with it.`,
      );
    }
    return;
  }
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
 *  READ, never retyped into a script, so there is exactly one place to be wrong (). */
export function mainnetConfig(): Record<string, unknown> {
  // THERE IS NO OVERRIDE. Not an env var, not a pair of env vars.
  // deleted `DOMINION_RELEASE_MANIFEST` for redirecting which file a gate trusts. This sibling
  // survived one file over, and the previous fix gated it behind a SECOND variable,
  // `DOMINION_CLUSTER_SELFTEST=1`. That was wrong in principle and the audit said so plainly: both
  // variables come from the same environment, so the second one is a textual marker, not a separation
  // of authority and not proof the caller is the test harness. A leftover `.env`, a ceremony shell or
  // a copied command carries both, `t1-hostile-bootstrap.ts` then reads authorities, launch posture,
  // the Lazer treasury and the USDC mint from the redirected file, the consent and genesis checks all
  // pass, and the single irreversible `initialize` writes the wrong values.
  // The test seam moved into the type system instead: `readMainnetConfigFrom` below takes a path, and
  // `mainnetAddressFrom` takes an already-parsed object. The self-test calls those with what it built.
  // Production calls this, which reads one path and cannot be pointed anywhere else.
  return readMainnetConfigFrom(path.join(__dirname, "..", "config", "mainnet-authorities.json"));
}

/** Parse a manifest from an EXPLICIT path. Exported for `verify-cluster-resolution.ts`, which builds a
 *  mutated temp copy and passes it here directly rather than redirecting the production reader. */
export function readMainnetConfigFrom(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) {
    throw new Error(`missing source of truth: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/** The pure half of `requiredMainnetAddress`: same validation, on an object the caller supplies. The
 *  mutation test drives THIS, so the production path keeps exactly one source and no seam. */
export function mainnetAddressFrom(cfg: Record<string, unknown>, field: string): PublicKey {
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

function requiredMainnetAddress(field: string): PublicKey {
  return mainnetAddressFrom(mainnetConfig(), field);
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
