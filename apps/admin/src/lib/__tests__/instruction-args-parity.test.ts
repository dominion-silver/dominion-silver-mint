/**
 * ROUND 8 P1. THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE.
 *
 * `unpause` gained an argument in the program (`expected_readiness_digest: [u8; 32]`, FINAL-03) and
 * SEVEN call sites kept building it with none: the ceremony, the admin panel and five runners. The
 * encoded instruction carried 8 bytes instead of 40, so the one instruction that takes the protocol
 * live would have been rejected before reaching its handler.
 *
 * The account-parity suites already catch a missing ACCOUNT. Nothing caught a missing ARGUMENT, and
 * the two failure modes are identical in cause: the program changed and a builder did not.
 *
 * This builds every affected instruction OFFLINE (Anchor's `.instruction()` never touches the RPC)
 * and compares the encoded data LENGTH against the length the committed IDL says those args occupy.
 * 8 versus 40 is exactly what it catches.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import { readinessDigest } from "../readiness-digest";

const conn = new Connection("http://127.0.0.1:1", "confirmed");
const provider = new AnchorProvider(conn, new Wallet(Keypair.generate()), {});
const program = new Program(idl as any, provider);

/** Serialized size of an IDL arg type. Only the shapes this program actually uses. */
function argSize(t: any): number {
  if (typeof t === "string") {
    const prim: Record<string, number> = {
      bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4,
      u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32,
    };
    if (prim[t] === undefined) throw new Error(`unhandled IDL arg type: ${t}`);
    return prim[t];
  }
  if (t?.array) return argSize(t.array[0]) * Number(t.array[1]);
  if (t?.option) return 1 + argSize(t.option);
  throw new Error(`unhandled IDL arg type: ${JSON.stringify(t)}`);
}

const ANCHOR_DISCRIMINATOR = 8;

function expectedLen(name: string): number {
  const ix = (idl as any).instructions.find((i: any) => i.name === name);
  if (!ix) throw new Error(`${name} is not in the committed IDL`);
  return ANCHOR_DISCRIMINATOR + ix.args.reduce((n: number, a: any) => n + argSize(a.type), 0);
}

describe("built instructions carry the arguments the IDL declares", () => {
  const cfg = PublicKey.unique();
  const admin = PublicKey.unique();
  const guardian = PublicKey.unique();

  it("unpause encodes 8 + 32 bytes, not a bare discriminator", async () => {
    const digest = Array.from(
      readinessDigest({
        admin,
        silvMint: PublicKey.unique(),
        inventoryWallet: PublicKey.unique(),
        publicMintEnabled: true,
        redemptionsEnabled: true,
        guardianCount: 1,
        minPublishers: 2,
        pythLazerFeedId: 3154,
      }),
    );
    const ix = await (program.methods as any)
      .unpause(digest)
      .accountsPartial({ config: cfg, admin, guardian })
      .instruction();

    expect(expectedLen("unpause")).toBe(40);
    expect(
      ix.data.length,
      `unpause encoded ${ix.data.length} bytes, the IDL says ${expectedLen("unpause")}. ` +
        "A bare discriminator here means a call site was not updated when the program gained an " +
        "argument, and the protocol could not be taken live.",
    ).toBe(expectedLen("unpause"));
  });

  /**
   * The general guard, so the NEXT argument added to any instruction is caught too. Only the
   * builders this app exports are covered; the point is that adding one here is one line, whereas
   * discovering the omission on mainnet is a launch.
   */
  const CASES: Array<[string, () => Promise<any>]> = [
    ["pause", () => (program.methods as any).pause().accountsPartial({ config: cfg, signer: admin, guardian }).instruction()],
  ];

  for (const [name, build] of CASES) {
    it(`${name} encodes exactly what the IDL declares`, async () => {
      const ix = await build();
      expect(ix.data.length, `${name} encoded ${ix.data.length}, IDL says ${expectedLen(name)}`).toBe(
        expectedLen(name),
      );
    });
  }

  /**
   * ROUND 8 REVIEW P1. THE SAME FROZEN VECTOR the Rust test asserts, in
   * tools/state-harness/tests/launch_open_posture.rs. This is the ONLY thing tying the TypeScript
   * encoder to the on-chain one. Before it, the only TS assertion was "the output is 32 bytes",
   * which is true of any hash of anything: a field added to `readiness_digest()` regenerates an
   * identical IDL, leaves this suite at 40 bytes, and makes the ceremony build an unpause the chain
   * always rejects. That would have surfaced first at the mainnet go-live.
   */
  it("matches the frozen digest vector the on-chain test asserts", () => {
    const d = readinessDigest({
      admin: new PublicKey(new Uint8Array(32).fill(1)),
      silvMint: new PublicKey(new Uint8Array(32).fill(2)),
      inventoryWallet: new PublicKey(new Uint8Array(32).fill(3)),
      publicMintEnabled: true,
      redemptionsEnabled: true,
      guardianCount: 2,
      minPublishers: 3,
      pythLazerFeedId: 3154,
    });
    expect(
      d.toString("hex"),
      "the TypeScript digest no longer matches the on-chain one. Both this and the Rust test " +
        "the_readiness_digest_matches_the_frozen_cross_language_vector must be updated together, " +
        "and BOTH TypeScript copies of the encoder checked.",
    ).toBe("911edf183b2728a122607a9e70341dfc58a49c1f3391ef8f846429e6b945e33a");
  });

  it("the digest helper produces exactly 32 bytes, the width the IDL declares", () => {
    const d = readinessDigest({
      admin, silvMint: admin, inventoryWallet: admin,
      publicMintEnabled: false, redemptionsEnabled: false,
      guardianCount: 0, minPublishers: 0, pythLazerFeedId: 0,
    });
    expect(d.length).toBe(32);
    expect(argSize((idl as any).instructions.find((i: any) => i.name === "unpause").args[0].type)).toBe(32);
  });
});
