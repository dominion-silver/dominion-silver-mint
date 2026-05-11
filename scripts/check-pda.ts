import { PublicKey } from "@solana/web3.js";
const PID = new PublicKey("J9cwPQ7Pp23a58wA39jfQNdnW7Nm1pXtFRe8cWM1zfd5");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PID);
console.log("silv_mint_authority PDA:", pda.toBase58());
