import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  parseSolanaMessage,
  buildLazerEd25519Instruction,
  assembleLazerTx,
  lazerMessageData,
  SOLANA_FORMAT_MAGIC,
  ED25519_PROGRAM_ID,
} from "../lazer-assembly";
import { base64ToBytes } from "../lazer-client";

// Build a SYNTHETIC, validly-signed Pyth Lazer SolanaMessage envelope:
//   magic u32 (LE) | signature (64) | public_key (32) | payload_len u16 (LE) | payload
function makeSignedEnvelope(payload: Uint8Array): {
  envelope: Uint8Array;
  publicKey: Uint8Array;
  signature: Uint8Array;
} {
  const priv = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(priv);
  const signature = ed25519.sign(payload, priv); // signs the inner payload
  const env = new Uint8Array(4 + 64 + 32 + 2 + payload.length);
  const dv = new DataView(env.buffer);
  dv.setUint32(0, SOLANA_FORMAT_MAGIC, true);
  env.set(signature, 4);
  env.set(publicKey, 68);
  dv.setUint16(100, payload.length, true);
  env.set(payload, 102);
  return { envelope: env, publicKey, signature };
}

// Synthesize the serialized data of a dominion `mint_silv`-style instruction,
// which carries the envelope as its 3rd arg (message_data: Vec<u8>):
//   discriminator(8) | amount_usdc u64(8) | min_silv_out u64(8) | vec_len u32(4) | <envelope> | ed_idx u16(2) | sig u8(1)
// => the envelope begins at byte 28.
const MINT_ENVELOPE_OFFSET = 8 + 8 + 8 + 4;
function makeMintDominionIxData(envelope: Uint8Array): Uint8Array {
  const tail = 2 + 1; // ed25519_instruction_index + signature_index
  const d = new Uint8Array(MINT_ENVELOPE_OFFSET + envelope.length + tail);
  // disc + two u64 + vec_len left as placeholder bytes (the assembler locates
  // the envelope by content, but set the vec_len correctly for realism).
  new DataView(d.buffer).setUint32(8 + 8 + 8, envelope.length, true);
  d.set(envelope, MINT_ENVELOPE_OFFSET);
  return d;
}

const PAYLOAD = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe("Lazer envelope parsing", () => {
  it("round-trips signature / pubkey / payload + the signature verifies", () => {
    const { envelope, publicKey, signature } = makeSignedEnvelope(PAYLOAD);
    const parsed = parseSolanaMessage(envelope);
    expect(Array.from(parsed.signature)).toEqual(Array.from(signature));
    expect(Array.from(parsed.publicKey)).toEqual(Array.from(publicKey));
    expect(Array.from(parsed.payload)).toEqual(Array.from(PAYLOAD));
    expect(ed25519.verify(parsed.signature, parsed.payload, parsed.publicKey)).toBe(true);
  });

  it("rejects a wrong magic + a truncated envelope", () => {
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const bad = envelope.slice();
    new DataView(bad.buffer).setUint32(0, 12345, true);
    expect(() => parseSolanaMessage(bad)).toThrow(/magic/);
    expect(() => parseSolanaMessage(envelope.slice(0, 50))).toThrow(/too short/);
  });
});

describe("lazerMessageData", () => {
  it("is the WHOLE envelope, not the inner payload", () => {
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const md = lazerMessageData(envelope);
    expect(Array.from(md)).toEqual(Array.from(envelope));
    // The contract reads message_data[0..4] as SOLANA_FORMAT_MAGIC.
    expect(new DataView(md.buffer, md.byteOffset).getUint32(0, true)).toBe(SOLANA_FORMAT_MAGIC);
  });
});

describe("ed25519 instruction assembly (matches signature.rs)", () => {
  it("offsets point into the DOMINION ix at the envelope, per Ed25519SignatureOffsets::new", () => {
    const { envelope, publicKey, signature } = makeSignedEnvelope(PAYLOAD);
    const ixData = makeMintDominionIxData(envelope);
    const dominionInstructionIndex = 1; // tx = [ed25519=0, dominion=1]
    const ix = buildLazerEd25519Instruction(ixData, envelope, dominionInstructionIndex);

    expect(ix.programId.equals(ED25519_PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(0);
    // The ed25519 ix carries ONLY [num(1), pad(1), offsets(14)] - no envelope copy.
    expect(ix.data.length).toBe(16);

    const d = ix.data;
    expect(d[0]).toBe(1); // num_signatures
    expect(d[1]).toBe(0); // padding
    const u16 = (off: number) => d.readUInt16LE(off);

    // Independently re-derive the expected offsets from the envelope's actual
    // position in the dominion ix data (NOT from the implementation's constants).
    const starting = MINT_ENVELOPE_OFFSET; // 28
    expect(u16(2)).toBe(starting + 4); // signature_offset
    expect(u16(4)).toBe(dominionInstructionIndex); // signature_instruction_index
    expect(u16(6)).toBe(starting + 4 + 64); // public_key_offset
    expect(u16(8)).toBe(dominionInstructionIndex); // public_key_instruction_index
    expect(u16(10)).toBe(starting + 4 + 64 + 32 + 2); // message_data_offset
    expect(u16(12)).toBe(PAYLOAD.length); // message_data_size
    expect(u16(14)).toBe(dominionInstructionIndex); // message_instruction_index

    // The bytes those offsets point at - INSIDE the dominion ix data - are the
    // real signature / pubkey / payload. A wrong offset would make the on-chain
    // ed25519 verify fail.
    const sigOff = u16(2);
    const pkOff = u16(6);
    const msgOff = u16(10);
    expect(Array.from(ixData.subarray(sigOff, sigOff + 64))).toEqual(Array.from(signature));
    expect(Array.from(ixData.subarray(pkOff, pkOff + 32))).toEqual(Array.from(publicKey));
    const msg = ixData.subarray(msgOff, msgOff + PAYLOAD.length);
    expect(Array.from(msg)).toEqual(Array.from(PAYLOAD));
    expect(ed25519.verify(ixData.subarray(sigOff, sigOff + 64), msg, ixData.subarray(pkOff, pkOff + 32))).toBe(true);
  });

  it("locates the envelope at the claim layout (offset 12) too", () => {
    // claim_redemption has message_data as the FIRST arg -> envelope at byte 12.
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const CLAIM_OFFSET = 8 + 4; // disc + vec_len
    const d = new Uint8Array(CLAIM_OFFSET + envelope.length + 3);
    new DataView(d.buffer).setUint32(8, envelope.length, true);
    d.set(envelope, CLAIM_OFFSET);
    const ix = buildLazerEd25519Instruction(d, envelope, 1);
    expect(ix.data.readUInt16LE(2)).toBe(CLAIM_OFFSET + 4); // signature_offset
    expect(ix.data.readUInt16LE(10)).toBe(CLAIM_OFFSET + 4 + 64 + 32 + 2); // message_data_offset
    const sigOff = ix.data.readUInt16LE(2);
    expect(Array.from(d.subarray(sigOff, sigOff + 64))).toEqual(
      Array.from(parseSolanaMessage(envelope).signature),
    );
  });

  it("throws if the envelope is not in the dominion ix data", () => {
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const other = makeSignedEnvelope(new Uint8Array([99, 98, 97])).envelope;
    expect(() => buildLazerEd25519Instruction(other, envelope, 1)).toThrow(/not found/);
  });
});

describe("assembleLazerTx + base64ToBytes", () => {
  it("returns the ed25519 ix + the dominion-arg indices", () => {
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const ixData = makeMintDominionIxData(envelope);
    const a = assembleLazerTx(ixData, envelope, {
      dominionInstructionIndex: 1,
      ed25519InstructionIndex: 0,
    });
    expect(a.ed25519Ix.programId.equals(ED25519_PROGRAM_ID)).toBe(true);
    expect(a.ed25519InstructionIndex).toBe(0);
    expect(a.signatureIndex).toBe(0);
  });

  it("base64ToBytes decodes + rejects bad input", () => {
    // The Pyth Lazer proxy returns the envelope base64-encoded (solana.data).
    expect(Array.from(base64ToBytes(Buffer.from([0, 1, 2]).toString("base64")))).toEqual([0, 1, 2]);
    expect(Array.from(base64ToBytes(Buffer.from([222, 173, 190, 239]).toString("base64")))).toEqual([222, 173, 190, 239]);
    expect(() => base64ToBytes("")).toThrow(/invalid base64/);
    expect(() => base64ToBytes("!!!!")).toThrow(/invalid base64/);
    // end-to-end: a base64 envelope (the real proxy format) feeds the assembler.
    const { envelope } = makeSignedEnvelope(PAYLOAD);
    const ixData = makeMintDominionIxData(envelope);
    const b64 = Buffer.from(envelope).toString("base64");
    const ix = buildLazerEd25519Instruction(ixData, base64ToBytes(b64), 1);
    expect(ix.data.length).toBe(16);
  });
});

describe("real Pyth Lazer envelope (captured live fixture, feed 1 / BTC, 2026-06-10)", () => {
  // A GENUINE ed25519-signed SolanaMessage from the live latest_price API. The
  // signature is deterministic, so it verifies forever. Proves the parser +
  // assembly handle the real wire format, not just synthetic test envelopes.
  const REAL_ENVELOPE_HEX =
    "b9011a820f98e6c363c858e8e826da18ce92c3c6822be8ff4d0c20b0c8807a75f4fc11b3c2e3058a140b3780af362b2ceb3dab97b7ba88d6baec1492357b78ba0103bc0080efc1f480c5615af3fb673d42287e993da9fbc3506b6e41dfa32950820c2e6c350075d3c793c04bd6c9085406000401010000000500525a2a96b705000004f8ff031200057a0d7028010000000c01c04bd6c908540600";
  const realEnvelope = () => Uint8Array.from(Buffer.from(REAL_ENVELOPE_HEX, "hex"));

  it("parses, the signature verifies over the payload, and there is no trailing slack", () => {
    const env = realEnvelope();
    const { signature, publicKey, payload } = parseSolanaMessage(env);
    expect(env.length).toBe(102 + payload.length); // the on-chain slice_eq length check
    expect(ed25519.verify(signature, payload, publicKey)).toBe(true);
    expect(Array.from(lazerMessageData(env))).toEqual(Array.from(env));
  });

  it("the ed25519 ix offsets reference the real sig + pubkey inside the dominion ix", () => {
    const env = realEnvelope();
    const ixData = makeMintDominionIxData(env);
    const ix = buildLazerEd25519Instruction(ixData, env, 1);
    const sigOff = ix.data.readUInt16LE(2);
    const pkOff = ix.data.readUInt16LE(6);
    expect(Array.from(Buffer.from(ixData).subarray(sigOff, sigOff + 64))).toEqual(Array.from(env.subarray(4, 68)));
    expect(Array.from(Buffer.from(ixData).subarray(pkOff, pkOff + 32))).toEqual(Array.from(env.subarray(68, 100)));
  });
});
