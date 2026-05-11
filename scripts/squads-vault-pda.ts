// Off-chain helper: derive the Squads v4 vault PDA for a given multisig + vault index.
// Used at `initialize` time to set `permanent_delegate_expected = sqds_vault_pda(multisig, 0)`.
// The vault PDA is permanent for the life of the Squads multisig; signer member rotation
// does not change its address. SAFE to bake into config.permanent_delegate_expected.
//
// Usage:
//   ts-node scripts/squads-vault-pda.ts <multisig_pubkey> [vault_index=0]

import { PublicKey } from "@solana/web3.js";

const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

function sqdsVaultPda(multisig: PublicKey, vaultIndex = 0): PublicKey {
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      multisig.toBuffer(),
      Buffer.from("vault"),
      Buffer.from([vaultIndex]),
    ],
    SQUADS_PROGRAM_ID,
  );
  return vaultPda;
}

function main() {
  const [multisigArg, vaultIndexArg] = process.argv.slice(2);
  if (!multisigArg) {
    console.error("Usage: ts-node scripts/squads-vault-pda.ts <multisig_pubkey> [vault_index=0]");
    process.exit(1);
  }
  const multisig = new PublicKey(multisigArg);
  const vaultIndex = vaultIndexArg ? parseInt(vaultIndexArg, 10) : 0;
  const vaultPda = sqdsVaultPda(multisig, vaultIndex);
  console.log(JSON.stringify({
    multisig: multisig.toBase58(),
    vault_index: vaultIndex,
    vault_pda: vaultPda.toBase58(),
  }, null, 2));
}

if (require.main === module) {
  main();
}

export { sqdsVaultPda, SQUADS_PROGRAM_ID };
