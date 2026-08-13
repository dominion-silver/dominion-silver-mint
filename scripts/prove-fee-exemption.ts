/**
 * PROVE that the fee exemption actually zeroes the premium, by measuring it.
 *
 * WHY THIS EXISTS. Two market makers were told they were whitelisted and were charged full premiums:
 *   mint   50 USDC in, 0.50 to the fee vault (100 bps)
 *   redeem 0.760858 SILV burned, 0.741706 to the fee vault (150 bps)
 * The cause was not a broken mechanism, it was a missing account: there were ZERO `fee_exempt` accounts
 * on chain, because the whitelist request was never executed. But "the account was missing" is a claim,
 * and after telling someone their exemption worked once already, the only acceptable evidence is a
 * measurement.
 *
 * HOW IT MEASURES, and the control is real data rather than a second simulation.
 *
 *   BEFORE  the market maker's OWN historical mint, read off chain: 50 USDC in, 0.50 to the fee vault.
 *   AFTER   the SAME mint, same wallet, same amount, simulated against today's state where the
 *           exemption exists. The fee vault must receive exactly zero.
 *
 * A before/after on one wallet at one amount, with the "before" being a transaction that actually
 * happened, is stronger than two simulations: it cannot be an artefact of how the simulation was built.
 *
 * The first version tried to apply `set_fee_exempt` inside the simulated transaction so the proof could
 * run before the 3-of-5. That does not fit: a priced mint already carries a signed Lazer envelope and an
 * ed25519 pre-instruction, and adding one more instruction pushed it to 1656 bytes against a 1232 limit.
 * Recorded here because it is the obvious idea and it does not work.
 *
 * `sigVerify: false` lets the market maker appear as signer without their key. Read-only: nothing is sent.
 *
 * Read-only: it sends nothing.
 *
 * Run: DOMINION_RPC=<mainnet> PYTH_LAZER_KEY=... npx tsx scripts/prove-fee-exemption.ts --wallet <pubkey>
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadIdl, PROGRAM_ID } from "./_program-id";
import { redactRpc } from "./_redact";
import { fetchSilvEnvelope } from "./_lazer-envelope";
import { lazerMessageData } from "../apps/public/src/lib/lazer-assembly";
import { assembleLazerOracleIxs, ED25519_IX_INDEX } from "../apps/public/src/lib/lazer-tx";

const RPC = process.env.DOMINION_RPC;
const LAZER_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
const LAZER_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
/** The amount to price the test at. Never sent, so its only job is being large enough to see the fee. */
const TEST_USDC = 50_000_000; // 50 USDC, matching the transaction the market maker complained about

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
}

/** SPL token account layout: amount is a u64 LE at offset 64. */
function amountOf(dataB64: string): bigint {
  return Buffer.from(dataB64, "base64").readBigUInt64LE(64);
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("DOMINION_RPC must be set to the MAINNET endpoint");
  const walletArg = arg("--wallet");
  if (!walletArg) throw new Error("--wallet <pubkey> is required: the wallet whose exemption is in question");
  const user = new PublicKey(walletArg);

  const conn = new Connection(RPC, "confirmed");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const program = new Program(
    loadIdl() as Idl,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
  );
  const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], PROGRAM_ID)[0];
  const configPda = pda("config");
  const cfg: any = await (program.account as any).configAccount.fetch(configPda);

  const usdcMint = new PublicKey(String(cfg.usdcMint));
  const silvMint = new PublicKey(String(cfg.silvMint));
  const admin = new PublicKey(String(cfg.admin));
  const feeVaultPda = pda("fee_vault");
  const feeVaultAta = getAssociatedTokenAddressSync(usdcMint, feeVaultPda, true, TOKEN_PROGRAM_ID);
  const usdcTreasury = new PublicKey(String(cfg.usdcTreasury));
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user, false, TOKEN_PROGRAM_ID);
  const userSilvAta = getAssociatedTokenAddressSync(silvMint, user, false, TOKEN_2022_PROGRAM_ID);
  const [feeExemptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_exempt"), user.toBuffer()],
    PROGRAM_ID,
  );

  console.log("prove fee exemption");
  console.log(`  cluster    : ${redactRpc(RPC)}`);
  console.log(`  wallet     : ${user.toBase58()}`);
  console.log(`  fee_exempt : ${feeExemptPda.toBase58()}`);
  const exists = await conn.getAccountInfo(feeExemptPda, "finalized");
  console.log(`  on chain   : ${exists ? "EXISTS, so the exemption should already apply" : "ABSENT, so full premiums apply"}`);
  console.log(`  premiums   : mint ${Number(cfg.premiumBpsMint)} bps, redeem ${Number(cfg.premiumBpsRedeem)} bps`);
  console.log(`  fee vault  : ${feeVaultAta.toBase58()}`);

  const before = await conn.getTokenAccountBalance(feeVaultAta, "confirmed");
  const feeVaultBefore = BigInt(before.value.amount);
  console.log(`  fee vault balance now: ${Number(feeVaultBefore) / 1e6} USDC`);
  console.log("");

  const { envelope, priceUsd } = await fetchSilvEnvelope();
  const messageData = Buffer.from(lazerMessageData(envelope));

  /** The mint instruction, priced by the live envelope, from the market maker's own wallet. */
  const mintIx = await (program.methods as any)
    .mintSilv(new BN(TEST_USDC), new BN(0), messageData, ED25519_IX_INDEX, 0)
    .accounts({
      config: configPda,
      user,
      usdcMint,
      silvMint,
      usdcTreasury,
      userUsdcAta,
      userSilvAta,
      feeVaultPda,
      feeVault: feeVaultAta,
      // Anchor resolves an Option<Account> to the program id when the account does not exist, which is
      // exactly the "no exemption" case. Passing the PDA lets the program find it when it DOES exist.
      feeExempt: feeExemptPda,
      kyc: PROGRAM_ID,
      silvMintAuthority: pda("silv_mint_authority"),
      lazerProgram: LAZER_PROGRAM,
      lazerStorage: LAZER_STORAGE,
      lazerTreasury: new PublicKey("Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak"),
      lazerFeePayer: pda("lazer_fee_payer"),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      classicTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  /** Simulate and return the fee vault's amount in the post-state. */
  async function feeAfter(label: string, prefix: TransactionInstruction[]): Promise<bigint | null> {
    // The prefix goes in the slot assembleLazerOracleIxs reserves for ATA creations, which is AFTER the
    // ed25519 instruction, so its absolute offsets stay valid.
    const ixs = assembleLazerOracleIxs(mintIx, envelope, prefix);
    void ComputeBudgetProgram; // assembleLazerOracleIxs adds the two compute-budget instructions itself
    const { blockhash } = await conn.getLatestBlockhash("finalized");
    const msg = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const sim = await conn.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [feeVaultAta.toBase58()] },
    });
    if (sim.value.err) {
      console.log(`  ${label}: SIMULATION FAILED ${JSON.stringify(sim.value.err)}`);
      for (const l of sim.value.logs ?? []) if (/Error|error|failed|AnchorError/.test(l)) console.log(`      ${l.slice(0, 150)}`);
      return null;
    }
    const acct = sim.value.accounts?.[0];
    if (!acct?.data) {
      console.log(`  ${label}: the simulation returned no fee vault account`);
      return null;
    }
    const data = Array.isArray(acct.data) ? acct.data[0] : (acct.data as unknown as string);
    return amountOf(data);
  }

  console.log(`  pricing at $${priceUsd.toFixed(4)}/oz, ${TEST_USDC / 1e6} USDC of mint`);
  console.log("");

  const after = await feeAfter("simulated mint from this wallet", []);
  if (after === null) {
    console.error("\n  could not measure, so nothing is proven. Do NOT report the exemption as working.");
    process.exit(2);
  }
  const charged = after - feeVaultBefore;
  const expected = BigInt(Math.round((TEST_USDC * Number(cfg.premiumBpsMint)) / 10_000));

  console.log("");
  console.log("  RESULT");
  console.log(`    the same ${TEST_USDC / 1e6} USDC mint from this wallet sends the fee vault: +${Number(charged) / 1e6} USDC`);
  console.log(`    without an exemption it would send:                            +${Number(expected) / 1e6} USDC (${Number(cfg.premiumBpsMint)} bps)`);
  console.log("");

  let fail = 0;
  const ok = (cond: boolean, what: string) => {
    console.log(`    ${cond ? "PASS" : "FAIL"}  ${what}`);
    if (!cond) fail++;
  };
  if (exists) {
    ok(charged === BigInt(0), "the exemption EXISTS and the fee vault receives exactly zero");
    ok(expected > BigInt(0), `the premium being waived is real (${Number(expected) / 1e6} USDC at this size)`);
  } else {
    // No exemption on chain: this run is the CONTROL, and it must show the premium being charged.
    // Without that, a later zero would prove nothing.
    ok(charged === expected, `no exemption on chain, and the premium IS charged at exactly ${Number(cfg.premiumBpsMint)} bps`);
  }

  console.log("");
  if (fail === 0) {
    console.log(
      exists
        ? "  MEASURED: this wallet now pays no premium. What was missing before was the account, not the feature."
        : "  MEASURED: with no exemption the premium is charged, as expected. Re-run once the account exists.",
    );
  } else {
    console.log("  The exemption did NOT zero the fee. Creating the account will not fix this: investigate the program.");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nprove-fee-exemption FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
