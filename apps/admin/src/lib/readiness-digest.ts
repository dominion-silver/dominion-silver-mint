/**
 * THE ONE TypeScript implementation of `ConfigAccount::readiness_digest`.
 * The program's `unpause` now takes `expected_readiness_digest: [u8; 32]`. Every caller
 * outside the program kept building an argument-less instruction: 8 bytes of discriminator instead
 * of 40. The unpause would have been REJECTED before reaching the handler, on the one instruction
 * that takes the protocol live.
 * That is my named recurring defect, the one that cost passes 1 to 3: correcting the source without
 * propagating to the real path. It exists here as ONE exported function, imported by the ceremony,
 * the admin panel and every devnet runner, so there is a single place to be wrong and
 * `apps/admin/src/lib/__tests__/instruction-args-parity.test.ts` fails if any builder's encoded
 * length stops matching the IDL.
 * BYTE ORDER IS LOAD-BEARING and mirrors state/config.rs exactly. A mismatch is not a silent
 * weakening: the on-chain comparison fails and the unpause is refused, which is loud. But it is
 * refused at the ceremony, so it must be right.
 */
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

/** The config fields the go-live decision reads. `paused` is excluded: the unpause is what changes it. */
export interface ReadinessDigestInput {
  admin: PublicKey;
  silvMint: PublicKey;
  inventoryWallet: PublicKey;
  publicMintEnabled: boolean;
  redemptionsEnabled: boolean;
  guardianCount: number;
  minPublishers: number;
  pythLazerFeedId: number;
}

export function readinessDigest(c: ReadinessDigestInput): Buffer {
  const buf = Buffer.concat([
    new PublicKey(c.admin).toBuffer(),
    new PublicKey(c.silvMint).toBuffer(),
    new PublicKey(c.inventoryWallet).toBuffer(),
    Buffer.from([c.publicMintEnabled ? 1 : 0]),
    Buffer.from([c.redemptionsEnabled ? 1 : 0]),
    Buffer.from([Number(c.guardianCount)]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(Number(c.minPublishers));
      return b;
    })(),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(Number(c.pythLazerFeedId));
      return b;
    })(),
  ]);
  return createHash("sha256").update(buf).digest();
}

/** Read it straight off a decoded `ConfigAccount`, which is what every call site actually holds. */
export function readinessDigestFromConfig(c: any): number[] {
  return Array.from(
    readinessDigest({
      admin: c.admin,
      silvMint: c.silvMint,
      inventoryWallet: c.inventoryWallet,
      publicMintEnabled: c.publicMintEnabled === true,
      redemptionsEnabled: c.redemptionsEnabled === true,
      guardianCount: Number(c.guardianCount),
      minPublishers: Number(c.minPublishers),
      pythLazerFeedId: Number(c.pythLazerFeedId),
    }),
  );
}

/**
 * Fetch the config and return the digest, for the call sites that hold a program handle rather than
 * a decoded account. One line at each site, so nobody hand-rolls the field list a second time.
 */
export async function currentReadinessDigest(
  program: any,
  configPda: PublicKey,
): Promise<number[]> {
  const c = await program.account.configAccount.fetch(configPda);
  return readinessDigestFromConfig(c);
}
