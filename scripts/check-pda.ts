import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID as SHARED_PROGRAM_ID } from "./_program-id";
const PID = SHARED_PROGRAM_ID;
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("silv_mint_authority")], PID);
console.log("silv_mint_authority PDA:", pda.toBase58());
