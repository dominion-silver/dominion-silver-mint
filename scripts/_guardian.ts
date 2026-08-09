/**
 * ROUND 8 L1-03. Finding the guardian account `unpause` now demands.
 *
 * `unpause` takes a MANDATORY `guardian` account whose PDA seed is the guardian's own key. Nothing
 * on chain enumerates guardians: `config` holds only a COUNT, so the key cannot be derived and every
 * caller has to discover it. Four scripts and the admin panel each kept their old two-account list
 * and broke at once when the ABI changed; this is the single place the eligibility rule now lives so
 * the next ABI change has one call site to fix, not five.
 *
 * ELIGIBLE means what the PROGRAM means: `cooldown_until == 0` (not removed, not in cooldown) AND a
 * key different from the current `config.admin`. A guardian slot held by the admin is a brake wired
 * to the same lever, and `unpause` refuses it with GuardianNotIndependent.
 */
import { Connection, PublicKey } from "@solana/web3.js";

/** GuardianAccount layout after the 8-byte discriminator: guardian(32) added_at(8) cooldown_until(8). */
const OFF_GUARDIAN = 8;
const OFF_COOLDOWN = 8 + 32 + 8;

export interface EligibleGuardian {
  /** The guardian's own key. */
  key: PublicKey;
  /** The PDA to pass in the `guardian` account slot. */
  account: PublicKey;
}

export function guardianPda(key: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("guardian"), key.toBuffer()], programId)[0];
}

/**
 * Every guardian the program would accept for `unpause`, read straight off the cluster.
 *
 * Decoded by OFFSET rather than through Anchor, so this helper works in the scripts that build a
 * Program lazily or not at all, and so it cannot be broken by an unrelated IDL regeneration.
 */
export async function eligibleGuardians(
  connection: Connection,
  programId: PublicKey,
  admin: PublicKey,
): Promise<EligibleGuardian[]> {
  // GuardianAccount::SIZE. Filtering by length rather than by discriminator keeps this independent of
  // the IDL; the offsets below then confirm what was read.
  const rows = await connection.getProgramAccounts(programId, {
    filters: [{ dataSize: 98 }],
  });
  const out: EligibleGuardian[] = [];
  for (const r of rows) {
    const d = r.account.data;
    if (d.length < OFF_COOLDOWN + 8) continue;
    const key = new PublicKey(d.subarray(OFF_GUARDIAN, OFF_GUARDIAN + 32));
    const cooldown = d.readBigInt64LE(OFF_COOLDOWN);
    if (cooldown !== 0n) continue;
    if (key.equals(admin)) continue;
    if (key.equals(PublicKey.default)) continue;
    out.push({ key, account: r.pubkey });
  }
  return out;
}

/**
 * The one to present, or a refusal that says what to do. Callers get the program's own precondition
 * as a readable sentence instead of `Unresolved accounts: guardian`, which names a client symbol and
 * says nothing about the protocol.
 */
export async function requireEligibleGuardian(
  connection: Connection,
  programId: PublicKey,
  admin: PublicKey,
): Promise<EligibleGuardian> {
  const found = await eligibleGuardians(connection, programId, admin);
  if (found.length === 0) {
    throw new Error(
      "unpause needs an ACTIVE guardian whose key is not the current admin, and none is registered " +
        "on this cluster. Register one with add_guardian first: the protocol may not leave pause " +
        "before an independent party can pause it again.",
    );
  }
  return found[0];
}
