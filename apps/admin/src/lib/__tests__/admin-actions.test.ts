import { describe, it, expect } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import { oracleGuardsArgsObject } from "../admin-actions";

// Fable audit P1-A regression guard. proposeSetOracleGuards is the launch
// GO-gate instruction; it was silently dropping 6 of 7 fields because the arg
// object used snake_case keys while Anchor camelCases the IDL at runtime.
// This builds the instruction OFFLINE (no network) with the real coder, decodes
// it back, and asserts every provided field round-trips as Some.

function buildProgram() {
  const conn = new Connection("http://127.0.0.1:8899");
  const kp = Keypair.generate();
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (t: unknown) => t,
    signAllTransactions: async (t: unknown) => t,
  };
  const provider = new anchor.AnchorProvider(
    conn,
    wallet as anchor.Wallet,
    {},
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new anchor.Program(idl as any, provider);
}

// Encode argsObj into a real proposeSetOracleGuards ix and decode the args back.
async function roundtripArgs(
  argsObj: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  const program = buildProgram();
  const ix = await program.methods
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .proposeSetOracleGuards(argsObj as any)
    .accountsPartial({
      config: PublicKey.default,
      admin: PublicKey.default,
      timelock: PublicKey.default,
      systemProgram: PublicKey.default,
    })
    .instruction();
  // `.decode` exists at runtime but is absent from the InstructionCoder type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoded = (program.coder.instruction as any).decode(ix.data);
  expect(decoded.name).toBe("proposeSetOracleGuards");
  return decoded.data.args;
}

const ALL_FIELDS = [
  "staleness",
  "confBps",
  "minPriceScaled",
  "maxPriceScaled",
  "maxDeltaBps",
  "decaySeconds",
  "dustFilterMinUsdc",
  "minPublishers",
];

describe("proposeSetOracleGuards encoding (Fable P1-A camelCase guard)", () => {
  it("encodes every provided field as Some (no silent drop)", async () => {
    const obj = oracleGuardsArgsObject({
      stalenessSeconds: 20,
      confBps: 100,
      minPriceScaled: 5_000_000_000n,
      maxPriceScaled: 200_000_000_000n,
      maxDeltaBps: 500,
      decaySeconds: 3600,
      dustFilterMinUsdc: 1_000_000_000n,
      minPublishers: 2,
    });
    const args = await roundtripArgs(obj);
    for (const f of ALL_FIELDS) {
      expect(args[f], `${f} must round-trip as Some, not None`).not.toBeNull();
    }
    // u16 decodes as a plain number; u64 fields decode as BN.
    expect(args.minPublishers).toBe(2);
    expect(args.minPriceScaled.toString()).toBe("5000000000");
  });

  it("leaves unset fields as None (partial update)", async () => {
    const obj = oracleGuardsArgsObject({ minPublishers: 2 });
    const args = await roundtripArgs(obj);
    expect(args.minPublishers).not.toBeNull();
    expect(args.confBps).toBeNull();
    expect(args.staleness).toBeNull();
    expect(args.minPriceScaled).toBeNull();
  });

  it("documents the regression: snake_case keys drop every casing-variant field", async () => {
    // What the bug looked like (the OLD builder). Kept as executable
    // documentation so the failure mode can never silently return.
    const snake = {
      staleness: 20,
      conf_bps: 100,
      min_price_scaled: new anchor.BN(5_000_000_000),
      max_price_scaled: new anchor.BN(200_000_000_000),
      max_delta_bps: 500,
      decay_seconds: 3600,
      dust_filter_min_usdc: new anchor.BN(1_000_000_000),
      min_publishers: 2,
    };
    const args = await roundtripArgs(snake);
    expect(args.staleness).not.toBeNull(); // single-word, casing-invariant
    expect(args.confBps).toBeNull();
    expect(args.minPriceScaled).toBeNull();
    expect(args.minPublishers).toBeNull();
  });
});
