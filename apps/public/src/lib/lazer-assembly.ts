// Pyth Lazer (Pyth Pro) Solana message + ed25519 instruction assembly: the client-side counterpart of
// the on-chain `verify_message` (pyth-lazer-solana-contract 0.8.0 signature.rs) and of dominion's
// verify_and_get_payload (lazer_cpi.rs), replicated to the byte so the on-chain cross-check passes.
//
// THE CONVENTION:
//   - The dominion ix's `message_data` is the WHOLE envelope, never the inner payload: verify_message
//     reads message_data[0..4] as SOLANA_FORMAT_MAGIC and slice_eq's it against the bytes the ed25519
//     instruction verified.
//   - The ed25519 precompile ix carries only [num_sigs, pad, offsets], no envelope copy; its offsets
//     point into the DOMINION ix, so every instruction_index it holds is that ix's position in the tx.
//   - The tx is [ed25519 ix, dominion ix]: the ed25519 ix MUST precede.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

// First 4 bytes (LE) of a Solana-targeted Lazer update (ed25519-signed).
export const SOLANA_FORMAT_MAGIC = 2_182_742_457;

// The Solana ed25519 signature-verification precompile.
export const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111",
);

// SolanaMessage envelope layout (all little-endian):
//   magic u32 (4) | signature (64) | public_key (32) | payload_len u16 (2) | payload
const MAGIC_LEN = 4;
const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
const MESSAGE_SIZE_LEN = 2;
const ENVELOPE_HEADER_LEN = MAGIC_LEN + SIGNATURE_LEN + PUBKEY_LEN + MESSAGE_SIZE_LEN; // 102

// Ed25519SignatureOffsets: 7 x u16, #[repr(C, packed)] = 14 bytes, preceded in the ed25519 instruction
// data by a 2-byte header (num_signatures, padding).
const OFFSETS_LEN = 14;
const ED25519_HEADER_LEN = 2;

export interface ParsedSolanaMessage {
  /** The 64-byte ed25519 signature. */
  signature: Uint8Array;
  /** The 32-byte signer public key. */
  publicKey: Uint8Array;
  /** The inner signed payload (the Lazer PayloadData) - what the price comes from. */
  payload: Uint8Array;
}

/** Parse + validate a Pyth Lazer `SolanaMessage` envelope. */
export function parseSolanaMessage(envelope: Uint8Array): ParsedSolanaMessage {
  if (envelope.length < ENVELOPE_HEADER_LEN) {
    throw new Error("Lazer envelope too short");
  }
  const dv = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  );
  const magic = dv.getUint32(0, true);
  if (magic !== SOLANA_FORMAT_MAGIC) {
    throw new Error(`Lazer envelope magic mismatch (got ${magic})`);
  }
  let off = MAGIC_LEN;
  const signature = envelope.slice(off, off + SIGNATURE_LEN);
  off += SIGNATURE_LEN;
  const publicKey = envelope.slice(off, off + PUBKEY_LEN);
  off += PUBKEY_LEN;
  const payloadLen = dv.getUint16(off, true);
  off += MESSAGE_SIZE_LEN;
  const payload = envelope.slice(off, off + payloadLen);
  if (payload.length !== payloadLen) {
    throw new Error("Lazer envelope payload truncated");
  }
  return { signature, publicKey, payload };
}

/** Find the first index of `needle` in `haystack`, or -1. */
function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * The dominion ix's `message_data` argument: the WHOLE envelope, validated. Pass exactly the bytes the
 * Pyth proxy returned, with NO trailing slack beyond `102 + payload_len`: the on-chain
 * `slice_eq(envelope, message_data)` compares lengths, so extra bytes revert InvalidMessageData.
 */
export function lazerMessageData(envelope: Uint8Array): Uint8Array {
  parseSolanaMessage(envelope);
  return envelope;
}

/**
 * Build the ed25519 precompile instruction for a Lazer signature. Its offsets point at the envelope
 * WITHIN `dominionIxData`.
 *
 * @param dominionIxData serialized data of the dominion ix (must contain the envelope)
 * @param envelope the SolanaMessage envelope (== the dominion ix's message_data arg)
 * @param dominionInstructionIndex the dominion ix's position in the tx (e.g. 1)
 */
export function buildLazerEd25519Instruction(
  dominionIxData: Uint8Array,
  envelope: Uint8Array,
  dominionInstructionIndex: number,
): TransactionInstruction {
  const { payload } = parseSolanaMessage(envelope); // validates magic + lengths

  const startingOffset = indexOfSubarray(dominionIxData, envelope);
  if (startingOffset < 0) {
    throw new Error(
      "Lazer envelope not found in the dominion instruction data (message_data must be the envelope)",
    );
  }
  // Mirror Ed25519SignatureOffsets::new(message, dominionInstructionIndex, startingOffset).
  const signatureOffset = startingOffset + MAGIC_LEN;
  const publicKeyOffset = signatureOffset + SIGNATURE_LEN;
  const messageDataSizeOffset = publicKeyOffset + PUBKEY_LEN;
  const messageDataOffset = messageDataSizeOffset + MESSAGE_SIZE_LEN;
  const messageDataSize = payload.length;

  const data = Buffer.alloc(ED25519_HEADER_LEN + OFFSETS_LEN);
  let p = 0;
  p = data.writeUInt8(1, p); // num_signatures
  p = data.writeUInt8(0, p); // padding
  // Ed25519SignatureOffsets (7 u16 LE), all instruction indices = the dominion ix.
  p = data.writeUInt16LE(signatureOffset, p);
  p = data.writeUInt16LE(dominionInstructionIndex, p); // signature_instruction_index
  p = data.writeUInt16LE(publicKeyOffset, p);
  p = data.writeUInt16LE(dominionInstructionIndex, p); // public_key_instruction_index
  p = data.writeUInt16LE(messageDataOffset, p);
  p = data.writeUInt16LE(messageDataSize, p);
  data.writeUInt16LE(dominionInstructionIndex, p); // message_instruction_index

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data,
  });
}

export interface LazerOracleTx {
  /** Prepend this ed25519 precompile ix; it MUST precede the dominion ix. */
  ed25519Ix: TransactionInstruction;
  /** The value to pass as the dominion ix `ed25519_instruction_index` arg. */
  ed25519InstructionIndex: number;
  /** The value to pass as the dominion ix `signature_index` arg. */
  signatureIndex: number;
}

/**
 * Assemble the ed25519 instruction for an already-built dominion oracle ix.
 *
 * Caller contract: build the dominion ix (mint_silv / redeem_silv / claim_redemption) with
 * `message_data = lazerMessageData(envelope)`, `ed25519_instruction_index = ed25519InstructionIndex`,
 * `signature_index = 0`, and its 5 Lazer accounts (lazer_program, lazer_storage, lazer_treasury,
 * lazer_fee_payer PDA, instructions_sysvar). Then call this with that ix's `.data` and its tx position,
 * and send `[result.ed25519Ix, dominionIx]`.
 */
export function assembleLazerTx(
  dominionIxData: Uint8Array,
  envelope: Uint8Array,
  opts: { dominionInstructionIndex?: number; ed25519InstructionIndex?: number } = {},
): LazerOracleTx {
  const dominionInstructionIndex = opts.dominionInstructionIndex ?? 1;
  const ed25519InstructionIndex = opts.ed25519InstructionIndex ?? 0;
  return {
    ed25519Ix: buildLazerEd25519Instruction(
      dominionIxData,
      envelope,
      dominionInstructionIndex,
    ),
    ed25519InstructionIndex,
    signatureIndex: 0,
  };
}
