/**
 * ROUND 8 L1-01. The mainnet initialiser must actually send `inventory_wallet`.
 *
 * THE DEFECT THIS PINS. `initialize` gained a required `inventory_wallet` argument, and the script
 * that performs the real ceremony never read it from the manifest. Nothing failed loudly: Anchor's
 * client coder encodes an absent Pubkey as 32 zero bytes, so the transaction is well-formed, is
 * signed, is sent, and the program reverts InventoryWalletNotSet. By then T1 has already created the
 * real Token-2022 mint, which is irreversible, and the runbook says a green T1 IS the mainnet
 * initialisation and says not to edit the script.
 *
 * WHY IT IS THIS TEST AND NOT A GREP. It calls `buildT1InitializeArgs`, the function the ceremony
 * itself calls, and encodes the result with the REAL IDL coder, then reads the trailing 32 bytes. A
 * test that rebuilt the argument list would have agreed with the omission, because the omission was
 * in the list. Reading the encoded BYTES is what makes the zero-pubkey visible.
 *
 * The posture half is here too: T1 read the config back and counted the CLOSED flags as success, so
 * a correct round-8 initialisation would have ended on two red lines after an irreversible step.
 *
 *   npx tsx scripts/test-t1-initialize-args.ts
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import idl from "../target/idl/dominion_silver_mint.json";
import {
  buildT1InitializeArgs,
  EXPECTED_POST_INITIALIZE,
} from "./t1-hostile-bootstrap";

/* eslint-disable @typescript-eslint/no-explicit-any */

let failures = 0;
const ok = (m: string) => console.log(`ok: ${m}`);
const fail = (m: string) => {
  console.log(`FAIL: ${m}`);
  failures += 1;
};
const check = (c: boolean, okMsg: string, failMsg: string) => (c ? ok(okMsg) : fail(failMsg));

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config", "mainnet-authorities.json"), "utf8"),
) as Record<string, unknown>;

/** Encode an InitializeArgs with the real coder and hand back the instruction data. */
function encode(args: unknown): Buffer {
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const kp = Keypair.generate();
  const provider = new anchor.AnchorProvider(
    conn,
    {
      publicKey: kp.publicKey,
      signTransaction: async (t: unknown) => t,
      signAllTransactions: async (t: unknown) => t,
    } as any,
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl as anchor.Idl, provider);
  return (program.coder.instruction as any).encode("initialize", { args });
}

function main(): void {
  const manifestInventory = new PublicKey(
    ((MANIFEST.authorities as any)?.inventory_wallet?.pubkey as string) ?? "",
  );
  const manifestGuardian = new PublicKey(
    ((MANIFEST.authorities as any)?.guardian?.pubkey as string) ?? "",
  );
  const signer = PublicKey.unique();

  // ---- 1. the production builder reads the manifest's pre-mint destination
  const args = buildT1InitializeArgs(MANIFEST, "mainnet-beta", PublicKey.unique(), signer);
  check(
    args.inventoryWallet.equals(manifestInventory),
    `the ceremony args carry the manifest inventory wallet ${manifestInventory.toBase58()}`,
    "the ceremony args do not carry authorities.inventory_wallet.pubkey",
  );
  check(
    args.guardian.equals(manifestGuardian) && !args.guardian.equals(args.admin),
    `the ceremony args appoint the manifest guardian ${manifestGuardian.toBase58()}, distinct from the admin`,
    "the ceremony args do not appoint an independent first guardian",
  );

  // ---- 1b. and the ceremony refuses to start with no guardian named, for the same reason as the
  // inventory wallet: there is nothing to fall back to when the value is bound for good.
  const noGuardian = JSON.parse(JSON.stringify(MANIFEST));
  delete noGuardian.authorities.guardian;
  let guardianThrew = false;
  try {
    buildT1InitializeArgs(noGuardian, "mainnet-beta", PublicKey.unique(), signer);
  } catch {
    guardianThrew = true;
  }
  check(
    guardianThrew,
    "a manifest naming no guardian stops the ceremony BEFORE it creates the mint",
    "a manifest naming no guardian still produced args, so the brake would be chosen later and alone",
  );

  // ---- 2. and both APPENDED fields survive ENCODING, which is the half a field list cannot show
  //
  // Read by OFFSET FROM THE END, because both are appended last and that is the only property the
  // layout guarantees. The size is pinned too: this test caught its own staleness when `guardian`
  // was appended, reporting 214 bytes against the 182 it expected, which is the behaviour wanted
  // from a test whose whole job is to notice that the wire format moved.
  const data = encode(args);
  const guardianTail = data.subarray(data.length - 32);
  const inventoryTail = data.subarray(data.length - 64, data.length - 32);
  check(
    inventoryTail.equals(manifestInventory.toBuffer()),
    "the encoded instruction carries that exact 32-byte inventory wallet",
    `the encoded inventory wallet is ${inventoryTail.toString("hex")}, not the manifest's`,
  );
  check(
    !inventoryTail.equals(Buffer.alloc(32)),
    "the encoded inventory wallet is not the 32 zero bytes an omitted field produces",
    "the encoded inventory wallet is all zeros, which is exactly what the omission produced",
  );
  check(
    guardianTail.equals(manifestGuardian.toBuffer()) && !guardianTail.equals(Buffer.alloc(32)),
    "the encoded instruction ends with the manifest's first guardian",
    `the encoded guardian is ${guardianTail.toString("hex")}, not the manifest's`,
  );
  // 8-byte discriminator + 206-byte InitializeArgs (142-byte prefix + inventory + guardian).
  check(
    data.length === 8 + 206,
    `the encoded instruction is ${8 + 206} bytes (8 discriminator + 206 args)`,
    `the encoded instruction is ${data.length} bytes, expected ${8 + 206}`,
  );

  // ---- 3. the ceremony refuses to start when the destination is unknown
  const stripped = JSON.parse(JSON.stringify(MANIFEST));
  delete stripped.authorities.inventory_wallet;
  let threw = false;
  try {
    buildT1InitializeArgs(stripped, "mainnet-beta", PublicKey.unique(), signer);
  } catch {
    threw = true;
  }
  check(
    threw,
    "a manifest with no inventory wallet stops the ceremony BEFORE it creates the mint",
    "a manifest with no inventory wallet still produced args, so the ceremony would revert after the mint",
  );

  // ---- 4. the posture T1 reads back is the one the program writes
  check(
    EXPECTED_POST_INITIALIZE.paused === true &&
      EXPECTED_POST_INITIALIZE.publicMintEnabled === true &&
      EXPECTED_POST_INITIALIZE.redemptionsEnabled === true,
    "T1 expects paused=true with mint and redeem OPEN (round 8 posture)",
    "T1 still expects the pre-round-8 closed posture and would report a correct ceremony as failed",
  );
  // The manifest has to agree with it, or the ceremony evidence contradicts the ceremony.
  const posture = (MANIFEST.launch_posture ?? {}) as Record<string, unknown>;
  check(
    posture.public_mint_enabled === EXPECTED_POST_INITIALIZE.publicMintEnabled &&
      posture.redemptions_enabled === EXPECTED_POST_INITIALIZE.redemptionsEnabled &&
      posture.paused === EXPECTED_POST_INITIALIZE.paused,
    "config/mainnet-authorities.json declares the same posture T1 asserts",
    "the manifest and T1 disagree about the launch posture",
  );

  if (failures > 0) {
    console.log(`\nT1 INITIALIZE ARGS TEST FAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log("\nT1 INITIALIZE ARGS TEST OK: the ceremony binds the manifest's pre-mint destination");
}

main();
