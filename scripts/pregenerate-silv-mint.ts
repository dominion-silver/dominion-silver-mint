/**
 * Generate the SILV mint keypair AHEAD of the ceremony and print its address, so the token address can
 * be pre-validated (Jupiter, pools, listings, marketing) days before mainnet instead of first appearing
 * in the ceremony's scrollback.
 *
 * Feed it to the ceremony with:
 *   DOMINION_SILV_MINT_KEYPAIR=<path> ... npx tsx scripts/t1-hostile-bootstrap.ts
 *
 * WHY THIS IS OPT-IN AND WHY THE DEFAULT IS THE OTHER WAY. Audit A-30 says the mint secret is never
 * persisted, and the reason is sound: after creation the keypair has NO power over the token. The mint
 * authority is a program PDA; freeze and permanent delegate are the compliance vault. So keeping it
 * buys nothing operationally and only adds a secret to lose.
 *
 * WHAT PRE-GENERATING ACTUALLY RISKS, stated plainly because it is the whole decision: it is NOT a
 * fund risk and it is NOT a rug vector. Whoever holds this secret before the ceremony can create that
 * mint account first, which makes the ceremony's creation step fail and burns the address already
 * announced. That is griefing the launch, not stealing from it. T1 now refuses if the address already
 * exists, so the failure is loud rather than confusing.
 *
 * Consequences to accept: mode 600, on the ceremony machine only, never committed (config/ is tracked,
 * so the default output path is NOT in the repo), and deleted once the mint exists on chain.
 *
 *   npx tsx scripts/pregenerate-silv-mint.ts                       # default path, refuses to overwrite
 *   npx tsx scripts/pregenerate-silv-mint.ts --out <path>
 */
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

function outPath(): string {
  const i = process.argv.indexOf("--out");
  if (i !== -1) {
    const p = process.argv[i + 1];
    if (!p) throw new Error("--out needs a path");
    return p;
  }
  return path.join(os.homedir(), ".config", "solana", "dominion-silv-mint.json");
}

function main() {
  const out = outPath();
  // NEVER overwrite. If a keypair already exists, the address may already be announced, and replacing
  // it silently would mean shipping a token at an address nobody was told about.
  if (fs.existsSync(out)) {
    const existing = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(out, "utf8"))));
    console.log(`a SILV mint keypair ALREADY exists at ${out}`);
    console.log(`  address: ${existing.publicKey.toBase58()}`);
    console.log(
      `\nRefusing to overwrite it. If that address has been announced anywhere, this IS the mint.\n` +
        `To deliberately start over, move the file aside yourself and re-run.`,
    );
    return;
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  fs.chmodSync(out, 0o600);

  console.log("SILV mint pre-generated");
  console.log(`  ADDRESS : ${kp.publicKey.toBase58()}`);
  console.log(`  keypair : ${out} (mode 600)`);
  console.log("");
  console.log("  This is the address the token WILL have, on whichever cluster the ceremony runs.");
  console.log("  It does not exist on chain yet: nothing is minted until T1 creates it.");
  console.log("");
  console.log("  PIN IT FIRST, or T1 will refuse to use it on mainnet. Write the address into");
  console.log("  config/mainnet-authorities.json:");
  console.log(`    mint_creation_ceremony.pregenerated_mint = "${kp.publicKey.toBase58()}"`);
  console.log("  That field is what the ceremony compares this keypair against, so that a stale path or");
  console.log("  a second keypair on the machine cannot rename the token. A keypair that is not the");
  console.log("  pinned one is refused on mainnet, and so is a missing pin.");
  console.log("");
  console.log("  Then use it with:");
  console.log(`    DOMINION_SILV_MINT_KEYPAIR=${out} \\`);
  console.log("      ... npx tsx scripts/t1-hostile-bootstrap.ts");
  console.log("");
  console.log("  Keep the file on this machine only, and delete it once the mint exists.");
  console.log("  If it leaks before the ceremony, someone can create the account first and burn this");
  console.log("  address. T1 refuses in that case rather than failing confusingly. Recovering from a");
  console.log("  leak means a new keypair, a new pin, AND re-announcing: anywhere the old address was");
  console.log("  published is now wrong.");
}

main();
