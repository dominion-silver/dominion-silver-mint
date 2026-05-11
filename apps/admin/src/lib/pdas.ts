import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants";

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.config)], PROGRAM_ID)[0];
}

export function treasuryPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.treasury)], PROGRAM_ID)[0];
}

export function silvMintAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.silvMintAuthority)], PROGRAM_ID)[0];
}

export function dailyPda(dayEpoch: number): PublicKey {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(dayEpoch, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.daily), buf], PROGRAM_ID)[0];
}

export function hourlyPda(hourEpoch: number): PublicKey {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(hourEpoch, 0);
  return PublicKey.findProgramAddressSync([Buffer.from(SEEDS.hourly), buf], PROGRAM_ID)[0];
}

export function currentDayEpoch(): number {
  return Math.floor(Date.now() / 1000 / 86400);
}

export function currentHourEpoch(): number {
  return Math.floor(Date.now() / 1000 / 3600);
}
