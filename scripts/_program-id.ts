/**
 * The one place a script learns which program to talk to.
 *
 * AUDIT review of daac4ac (P2): 18 scripts each hardcoded a program id, and most held
 * an id retired one or two generations earlier (`GDN5ktEm88...`, `J9cwPQ7Pp2...`).
 * A script pointed at a dead program does not fail in an obvious way: it fails with
 * AccountNotInitialized or "program does not exist", which reads as a broken protocol
 * rather than a stale constant. The same class already produced a false "the oracle
 * CPI is broken" signal from the Lazer harness.
 *
 * Resolution order:
 *   1. DOMINION_PROGRAM_ID, for deliberately targeting a throwaway id
 *   2. the generated IDL's `address`, which scripts/verify-constants-consistency.sh
 *      pins to `declare_id!` in CI
 *   3. the IDL copies COMMITTED under apps/*, added 2026-08-13
 *
 * There is deliberately NO hardcoded fallback: a missing IDL is an error, not a
 * silent default to whatever was current when the file was written. Step 3 is not
 * that: it reads a real IDL out of the repository.
 *
 * WHY STEP 3 EXISTS. `target/` is gitignored, so a plain checkout has no generated
 * IDL, and every script that imports this module dies on a message telling the reader
 * to run `anchor idl build`. That is correct advice for a developer and useless for a
 * scheduled job: the RedeemEvent monitor failed on its very first run for exactly this
 * reason, and it is the compensating control for the redemption risk, so it would have
 * failed silently every ten minutes. Standing up a Rust and Solana toolchain to build
 * an IDL for a ten-minute cron is absurd.
 *
 * WHY IT IS SAFE. The committed copies are not a second source of truth.
 * `verify-constants-consistency.sh` asserts, on every gate run, that all present IDL
 * copies are BYTE-IDENTICAL and that their `address` equals `declare_id!`. So reading
 * apps/public's copy cannot disagree with target/'s without the gate going red first.
 * The generated one still wins whenever it exists, so a developer mid-change always
 * sees their own build rather than the committed snapshot.
 */
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

/** The generated IDL. Preferred whenever it exists, so a developer sees their own build. */
export const GENERATED_IDL_PATH = path.join(
  __dirname,
  "..",
  "target",
  "idl",
  "dominion_silver_mint.json",
);

/** The committed copies, in preference order. The gate proves they are byte-identical to the
 *  generated one, which is the whole reason falling back to them is not a second truth. */
const COMMITTED_IDL_PATHS = [
  path.join(__dirname, "..", "apps", "public", "src", "lib", "idl", "dominion_silver_mint.json"),
  path.join(__dirname, "..", "apps", "admin", "src", "lib", "idl", "dominion_silver_mint.json"),
];

/** The path actually in use, resolved once. Exported under the old name so no call site changes. */
export const IDL_PATH: string =
  [GENERATED_IDL_PATH, ...COMMITTED_IDL_PATHS].find((p) => fs.existsSync(p)) ?? GENERATED_IDL_PATH;

function resolve(): PublicKey {
  const override = process.env.DOMINION_PROGRAM_ID;
  if (override) return new PublicKey(override);
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(
      `cannot resolve the program id: no IDL found. Looked at, in order:\n` +
        [GENERATED_IDL_PATH, ...COMMITTED_IDL_PATHS].map((p) => `  ${p}`).join("\n") +
        `\nBuild the generated one:\n` +
        `  (cd programs/dominion_silver_mint_v2 && anchor idl build -- --locked)\n` +
        `or set DOMINION_PROGRAM_ID explicitly.`,
    );
  }
  const addr = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")).address;
  if (!addr) throw new Error(`${IDL_PATH} has no "address" field`);
  return new PublicKey(addr);
}

export const PROGRAM_ID: PublicKey = resolve();

/** Load the generated IDL, with its address forced to the resolved program id. */
export function loadIdl(): Record<string, unknown> {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(
      `no IDL found. Looked at, in order:\n` +
        [GENERATED_IDL_PATH, ...COMMITTED_IDL_PATHS].map((p) => `  ${p}`).join("\n") +
        `\nBuild the generated one:\n` +
        `  cd programs/dominion_silver_mint_v2 && anchor idl build\n` +
        `A raw ENOENT here reads like a missing dependency; it is a missing build step.`,
    );
  }
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  return idl;
}
