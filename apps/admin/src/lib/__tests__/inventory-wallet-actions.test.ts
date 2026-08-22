/**
 * The operator path for the inventory wallet, after option A deleted the instant one.
 * WHY THIS FILE EXISTS AND WHAT WOULD NOT COUNT. acceptance criterion is explicit that
 * asserting a string is present in `EXEC_METHODS` is not enough: that proves a constant, not a
 * capability. So every test below builds a REAL instruction with the real Anchor builders in
 * `admin-actions.ts`, decodes it with the real IDL coder, and checks the bytes and the account list.
 * The catalog test drives the descriptor `AdminActions.tsx` actually renders, through its own
 * `build` closure, so a card that was left pointing at a deleted builder fails here.
 * Everything is offline. `.instruction()` never touches the RPC; the only read the propose path
 * performs is `config.next_timelock_nonce`, and the fake connection below answers it with a
 * zero-filled account, which Borsh decodes as every pubkey default, every bool false, every Option
 * None and every integer 0. That makes the nonce deterministically 0 and the timelock PDA
 * predictable, which is what lets the account assertions be exact rather than approximate.
 */
import { describe, it, expect } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "../idl/dominion_silver_mint.json";
import * as actions from "../admin-actions";
import { ACTIONS } from "../../components/AdminActions";
import { configPda, timelockPda } from "../pdas";

/* eslint-disable @typescript-eslint/no-explicit-any */

const IDL = idl as any;
const CONFIG_ACCOUNT_BYTES = 800;

const idlIx = (name: string) =>
  IDL.instructions.find((i: any) => i.name === name);

/** A Connection that answers exactly one question: "what is in the config account?". The answer is
 *  zeros behind the real discriminator, so `next_timelock_nonce` is 0. */
function fakeConnection(): Connection {
  const disc: number[] = IDL.accounts.find(
    (a: any) => a.name === "ConfigAccount",
  ).discriminator;
  const data = Buffer.alloc(CONFIG_ACCOUNT_BYTES);
  Buffer.from(disc).copy(data, 0);
  const account = {
    data,
    executable: false,
    lamports: 1,
    owner: new PublicKey(IDL.address),
    rentEpoch: 0,
  };
  // A REAL Connection with the two reads stubbed, not a hand-rolled stand-in: `rpcEndpoint` and
  // `commitment` are getters on the prototype, and Anchor reads both. Nothing here ever dials out,
  // because these two methods are the only ones an offline `.instruction()` build reaches.
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  (conn as any).getAccountInfo = async () => account;
  (conn as any).getAccountInfoAndContext = async () => ({
    context: { slot: 0 },
    value: account,
  });
  return conn;
}

const ADMIN = PublicKey.unique();
const ctx = (): actions.BuildCtx => ({
  connection: fakeConnection(),
  admin: ADMIN,
});

/**
 * Look a builder up by name and FAIL with the requirement rather than crash on `undefined is not a
 * function`. This is what makes the red phase legible: run against the pre-option-A tree these tests
 * must report which capability is missing, in a line an operator can act on. A TypeError from a
 * builder that does not exist yet is a true failure and a useless message.
 */
function catalog(): typeof ACTIONS {
  if (!Array.isArray(ACTIONS)) {
    throw new Error(
      "FAIL: the admin catalog still exposes an instant inventory setter " +
        "(AdminActions.tsx exports no ACTIONS, so its descriptor cannot be inspected)",
    );
  }
  return ACTIONS;
}

function builder(name: string): (...a: any[]) => Promise<any> {
  const fn = (actions as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`FAIL: ${name} builder is absent from admin-actions.ts`);
  }
  return fn as (...a: any[]) => Promise<any>;
}

/** Decode an instruction's name and args with the real coder. */
function decode(data: Buffer) {
  const program = new anchor.Program(
    IDL,
    new anchor.AnchorProvider(
      fakeConnection(),
      {
        publicKey: PublicKey.default,
        signTransaction: async (t: unknown) => t,
        signAllTransactions: async (t: unknown) => t,
      } as any,
      {},
    ),
  );
  return (program.coder.instruction as any).decode(data);
}

describe("T8-06: the inventory wallet has a delayed operator path and no instant one", () => {
  it("proposeSetInventoryWallet encodes the requested wallet and exact IDL accounts", async () => {
    const target = PublicKey.unique();
    const built = await builder("proposeSetInventoryWallet")(ctx(), target);
    expect(built).toHaveLength(1);

    const d = decode(built[0].data);
    expect(d.name).toBe("proposeSetInventoryWallet");
    // The WALLET, not merely "a pubkey": a builder that passed the admin or a default would still
    // produce a well-formed instruction.
    expect(new PublicKey(d.data.newWallet ?? d.data.wallet).toBase58()).toBe(
      target.toBase58(),
    );

    const declared = idlIx("propose_set_inventory_wallet").accounts;
    expect(built[0].keys).toHaveLength(declared.length);
    const byName = Object.fromEntries(
      declared.map((a: any, i: number) => [a.name, built[0].keys[i]]),
    );
    expect(byName.config.pubkey.toBase58()).toBe(configPda().toBase58());
    expect(byName.admin.pubkey.toBase58()).toBe(ADMIN.toBase58());
    // The nonce read above is 0, so this is the PDA the proposal will actually init.
    expect(byName.timelock.pubkey.toBase58()).toBe(timelockPda(0n).toBase58());
  });

  it("executeSetInventoryWallet encodes nonce, timelock PDA and rent recipient", async () => {
    const nonce = 7n;
    const rent = PublicKey.unique();
    expect(
      actions.EXEC_METHODS as readonly string[],
      "FAIL: executeSetInventoryWallet is absent from EXEC_METHODS",
    ).toContain("executeSetInventoryWallet");
    const built = await actions.executeTimelocked(
      ctx(),
      "executeSetInventoryWallet" as actions.ExecMethod,
      nonce,
      rent,
    );
    expect(built).toHaveLength(1);

    const d = decode(built[0].data);
    expect(d.name).toBe("executeSetInventoryWallet");
    expect(BigInt(d.data.nonce.toString())).toBe(nonce);

    const declared = idlIx("execute_set_inventory_wallet").accounts;
    expect(built[0].keys).toHaveLength(declared.length);
    const byName = Object.fromEntries(
      declared.map((a: any, i: number) => [a.name, built[0].keys[i]]),
    );
    expect(byName.config.pubkey.toBase58()).toBe(configPda().toBase58());
    expect(byName.admin.pubkey.toBase58()).toBe(ADMIN.toBase58());
    // The PDA of the nonce under execution, NOT the next-nonce read: a builder that derived it from
    // config would send the wrong account and fail ConstraintSeeds at the worst possible moment.
    expect(byName.timelock.pubkey.toBase58()).toBe(timelockPda(nonce).toBase58());
    expect(byName.rent_recipient.pubkey.toBase58()).toBe(rent.toBase58());
  });

  it("admin catalog exposes delayed propose/execute and no instant setter", async () => {
    const cards = catalog();
    expect(
      cards.some((a) => a.id === "set-inventory-wallet"),
      "FAIL: the admin catalog still exposes an instant inventory setter",
    ).toBe(false);
    const card = cards.find((a) => a.id === "propose-inventory-wallet");
    expect(
      card,
      "FAIL: the delayed inventory-wallet card is missing from the panel",
    ).toBeDefined();
    expect(card!.group).toBe("Delayed (24h)");

    // The card's OWN build closure, so this fails if it still points at a deleted builder.
    const target = PublicKey.unique();
    const built = await card!.build(ctx(), { wallet: target.toBase58() }, ADMIN);
    const d = decode(built[0].data);
    expect(d.name).toBe("proposeSetInventoryWallet");
    expect(new PublicKey(d.data.newWallet ?? d.data.wallet).toBase58()).toBe(
      target.toBase58(),
    );

    // And the instant BUILDER is gone too, not merely unreferenced by a card: leaving it exported
    // would let a future card wire itself back to a discriminator the program no longer dispatches.
    expect(
      (actions as Record<string, unknown>).setInventoryWallet,
      "FAIL: the instant setInventoryWallet builder is still exported",
    ).toBeUndefined();

    // And the execute half is reachable from the generic execute card's option list.
    expect(actions.EXEC_METHODS).toContain("executeSetInventoryWallet");
  });

  it("the IDL these builders encode against no longer declares the instant setter", () => {
    expect(idlIx("set_inventory_wallet")).toBeUndefined();
    expect(idlIx("propose_set_inventory_wallet")).toBeDefined();
    expect(idlIx("execute_set_inventory_wallet")).toBeDefined();
  });
});
