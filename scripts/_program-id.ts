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
 *
 * There is deliberately NO hardcoded fallback: a missing IDL is an error, not a
 * silent default to whatever was current when the file was written.
 */
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

export const IDL_PATH = path.join(
  __dirname,
  "..",
  "target",
  "idl",
  "dominion_silver_mint.json",
);

function resolve(): PublicKey {
  const override = process.env.DOMINION_PROGRAM_ID;
  if (override) return new PublicKey(override);
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(
      `cannot resolve the program id: ${IDL_PATH} does not exist.\n` +
        `Build the IDL first:\n` +
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
      `no IDL at ${IDL_PATH}. Build it first:\n` +
        `  cd programs/dominion_silver_mint_v2 && anchor idl build\n` +
        `A raw ENOENT here reads like a missing dependency; it is a missing build step.`,
    );
  }
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  idl.address = PROGRAM_ID.toBase58();
  return idl;
}
