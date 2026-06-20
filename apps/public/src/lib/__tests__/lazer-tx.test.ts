import { describe, it, expect } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import idl from "../idl/dominion_silver_mint.json";
import { assembleLazerOracleIxs, ED25519_IX_INDEX } from "../lazer-tx";
import { SOLANA_FORMAT_MAGIC, ED25519_PROGRAM_ID } from "../lazer-assembly";

// A synthetic signed Lazer envelope (magic|sig64|pk32|len2|payload).
function makeEnvelope(payload: Uint8Array): Uint8Array {
  const priv = ed25519.utils.randomPrivateKey();
  const env = new Uint8Array(4 + 64 + 32 + 2 + payload.length);
  const dv = new DataView(env.buffer);
  dv.setUint32(0, SOLANA_FORMAT_MAGIC, true);
  env.set(ed25519.sign(payload, priv), 4);
  env.set(ed25519.getPublicKey(priv), 68);
  dv.setUint16(100, payload.length, true);
  env.set(payload, 102);
  return env;
}

function program() {
  const conn = new Connection("http://127.0.0.1:8899");
  const kp = Keypair.generate();
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown) => t,
  };
  const provider = new anchor.AnchorProvider(conn, wallet as anchor.Wallet, {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new anchor.Program(idl as any, provider);
}

// Build a real mint_silv dominion ix offline (no network) carrying the envelope
// as message_data + the 5 Lazer accounts.
async function buildMintDominionIx(envelope: Uint8Array) {
  const p = program();
  const k = () => Keypair.generate().publicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (p.methods as any)
    .mintSilv(new anchor.BN(1000), new anchor.BN(1), Buffer.from(envelope), ED25519_IX_INDEX, 0)
    .accountsPartial({
      config: k(),
      user: k(),
      usdcMint: k(),
      silvMint: k(),
      usdcTreasury: k(),
      userUsdcAta: k(),
      userSilvAta: k(),
      silvMintAuthority: k(),
      lazerProgram: k(),
      lazerStorage: k(),
      lazerTreasury: k(),
      lazerFeePayer: k(),
      instructionsSysvar: k(),
      classicTokenProgram: k(),
      token2022Program: k(),
      associatedTokenProgram: k(),
      systemProgram: PublicKey.default,
    })
    .instruction();
}

const PAYLOAD = new Uint8Array([10, 20, 30, 40, 50]);

describe("assembleLazerOracleIxs", () => {
  it("orders [cb_limit, cb_price, ed25519, ...ataIxs, dominion] (compute-budget FIRST so wallets can't shift the offsets)", async () => {
    const envelope = makeEnvelope(PAYLOAD);
    const dominionIx = await buildMintDominionIx(envelope);

    // Mint has 2 ATA creations -> [cb, cb, ed25519(2), ata, ata, dominion(5)].
    const ataIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), // stand-ins for the 2 ATA ixs
      ComputeBudgetProgram.setComputeUnitLimit({ units: 2 }),
    ];
    const ixs = assembleLazerOracleIxs(dominionIx, envelope, ataIxs);

    expect(ixs.length).toBe(6);
    expect(ixs[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true); // cb_limit
    expect(ixs[1].programId.equals(ComputeBudgetProgram.programId)).toBe(true); // cb_price
    expect(ixs[ED25519_IX_INDEX].programId.equals(ED25519_PROGRAM_ID)).toBe(true); // ed25519 at index 2
    expect(ixs.slice(3, 5)).toEqual(ataIxs); // the ata ixs after ed25519
    expect(ixs[5]).toBe(dominionIx); // dominion last

    // The ed25519 offsets reference the dominion ix's FINAL index (5).
    const ed = ixs[ED25519_IX_INDEX].data;
    const dominionInstructionIndex = 5;
    expect(ed.readUInt16LE(4)).toBe(dominionInstructionIndex); // signature_instruction_index
    expect(ed.readUInt16LE(8)).toBe(dominionInstructionIndex); // public_key_instruction_index
    expect(ed.readUInt16LE(14)).toBe(dominionInstructionIndex); // message_instruction_index

    // The signature_offset points at the real signature INSIDE the dominion ix.
    const sigOff = ed.readUInt16LE(2);
    const sigInDominion = Buffer.from(dominionIx.data).subarray(sigOff, sigOff + 64);
    expect(Array.from(sigInDominion)).toEqual(Array.from(envelope.subarray(4, 68)));
  });

  it("recomputes the index when there is 1 ATA ix (redeem/claim) -> dominion at 4", async () => {
    const envelope = makeEnvelope(PAYLOAD);
    const dominionIx = await buildMintDominionIx(envelope); // shape is irrelevant here
    const ataIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })];
    const ixs = assembleLazerOracleIxs(dominionIx, envelope, ataIxs);
    expect(ixs.length).toBe(5); // cb, cb, ed25519, ata, dominion
    expect(ixs[ED25519_IX_INDEX].programId.equals(ED25519_PROGRAM_ID)).toBe(true); // ed25519 at 2
    expect(ixs[ED25519_IX_INDEX].data.readUInt16LE(14)).toBe(4); // dominion now at index 4
  });
});

describe("mint dominion ix shape", () => {
  it("carries the 5 Lazer accounts + decodes message_data = envelope, ed25519 index = 2", async () => {
    const envelope = makeEnvelope(PAYLOAD);
    const p = program();
    const dominionIx = await buildMintDominionIx(envelope);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded = (p.coder.instruction as any).decode(dominionIx.data);
    expect(decoded.name).toBe("mintSilv");
    expect(Array.from(decoded.data.messageData)).toEqual(Array.from(envelope));
    expect(decoded.data.ed25519InstructionIndex).toBe(ED25519_IX_INDEX);
    expect(decoded.data.signatureIndex).toBe(0);

    // The IDL account order includes the 5 Lazer accounts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mintIxDef = (idl as any).instructions.find((i: { name: string }) => i.name === "mint_silv");
    const names = mintIxDef.accounts.map((a: { name: string }) => a.name);
    for (const n of ["lazer_program", "lazer_storage", "lazer_treasury", "lazer_fee_payer", "instructions_sysvar"]) {
      expect(names).toContain(n);
    }
  });
});
