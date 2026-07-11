/** Shared plumbing for the keeper + tests: wallet, anchor program, PDAs,
 *  proof -> SettleArgs conversion, outcome derivation from final stats. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { STAT, statKey } from "@txline-kit/constants";
import type { ScoresStatValidationV2 } from "@txline-kit/client";
import { toBytes32, toProofNodes } from "@txline-kit/client/proofs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

export const TXORACLE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
export const WORLD_CUP = 72;

export function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function loadWallet(): Keypair {
  const p = process.env.ANCHOR_WALLET ?? path.resolve(ROOT, "..", ".keys", "devnet-wallet.json");
  return loadKeypair(p);
}

export function connection(): Connection {
  return new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function proofplayProgram(wallet: Keypair): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", "proofplay.json"), "utf8"));
  const provider = new anchor.AnchorProvider(
    connection(),
    new anchor.Wallet(wallet),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  return new anchor.Program(idl, provider);
}

export type MarketKindArg =
  | { winnerDrawLoser: Record<string, never> }
  | { totalGoalsOverUnder: { lineX2: number } }
  | { statOverUnder: { statKey: number; lineX2: number } }
  | { twoStatSumOverUnder: { keyA: number; keyB: number; lineX2: number } };

export const KIND_WDL: MarketKindArg = { winnerDrawLoser: {} };
export const kindOverUnder = (lineX2: number): MarketKindArg => ({ totalGoalsOverUnder: { lineX2 } });
export const kindStatOverUnder = (statKeyNum: number, lineX2: number): MarketKindArg => ({
  statOverUnder: { statKey: statKeyNum, lineX2 },
});
export const kindTwoStatSum = (keyA: number, keyB: number, lineX2: number): MarketKindArg => ({
  twoStatSumOverUnder: { keyA, keyB, lineX2 },
});

export function kindSeed(kind: MarketKindArg): Buffer {
  if ("winnerDrawLoser" in kind) return Buffer.from([0, 0, 0]);
  if ("totalGoalsOverUnder" in kind) {
    const b = Buffer.alloc(3);
    b[0] = 1;
    b.writeUInt16LE(kind.totalGoalsOverUnder.lineX2, 1);
    return b;
  }
  if ("statOverUnder" in kind) {
    const b = Buffer.alloc(5);
    b[0] = 2;
    b.writeUInt16LE(kind.statOverUnder.statKey, 1);
    b.writeUInt16LE(kind.statOverUnder.lineX2, 3);
    return b;
  }
  const b = Buffer.alloc(7);
  b[0] = 3;
  b.writeUInt16LE(kind.twoStatSumOverUnder.keyA, 1);
  b.writeUInt16LE(kind.twoStatSumOverUnder.keyB, 3);
  b.writeUInt16LE(kind.twoStatSumOverUnder.lineX2, 5);
  return b;
}

/** TxLINE stat keys the settlement proof must cover, in order (a, b?). */
export function kindStatKeys(kind: MarketKindArg): number[] {
  if ("winnerDrawLoser" in kind || "totalGoalsOverUnder" in kind) {
    return [STAT.T1_GOALS, STAT.T2_GOALS];
  }
  if ("statOverUnder" in kind) return [kind.statOverUnder.statKey];
  return [kind.twoStatSumOverUnder.keyA, kind.twoStatSumOverUnder.keyB];
}

export function marketPda(programId: PublicKey, fixtureId: number, kind: MarketKindArg): PublicKey {
  const fid = Buffer.alloc(8);
  fid.writeBigInt64LE(BigInt(fixtureId));
  return PublicKey.findProgramAddressSync([Buffer.from("market"), fid, kindSeed(kind)], programId)[0];
}

export function vaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
}

export function positionPda(programId: PublicKey, market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()],
    programId,
  )[0];
}

export function dailyScoresRootsPda(epochDay: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toBuffer("le", 2)],
    TXORACLE_PROGRAM_ID,
  )[0];
}

/** Map a V2 proof bundle (fetched with EXACTLY the kind's statKeys, in order)
 *  to the program's SettleArgs. statB is null for single-stat kinds. */
export function settleArgsFromProof(v2: ScoresStatValidationV2, claimedOutcome: number) {
  const statTerm = (i: number) => ({
    statToProve: v2.statsToProve[i],
    eventStatRoot: toBytes32(v2.eventStatRoot),
    statProof: toProofNodes(v2.statProofs[i]),
  });
  return {
    claimedOutcome,
    ts: new BN(v2.summary.updateStats.minTimestamp),
    summary: {
      fixtureId: new BN(v2.summary.fixtureId),
      updateStats: {
        updateCount: v2.summary.updateStats.updateCount,
        minTimestamp: new BN(v2.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v2.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: toBytes32(v2.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: toProofNodes(v2.subTreeProof),
    mainTreeProof: toProofNodes(v2.mainTreeProof),
    statA: statTerm(0),
    statB: v2.statsToProve.length > 1 ? statTerm(1) : null,
  };
}

/** Derive the true outcome index from a final Stats map. */
export function outcomeFromStats(stats: Record<string, number>, kind: MarketKindArg): number {
  const val = (k: number) => stats[String(k)] ?? 0;
  if ("winnerDrawLoser" in kind) {
    const home = val(STAT.T1_GOALS);
    const away = val(STAT.T2_GOALS);
    return home > away ? 0 : home === away ? 1 : 2;
  }
  if ("totalGoalsOverUnder" in kind) {
    return val(STAT.T1_GOALS) + val(STAT.T2_GOALS) > kind.totalGoalsOverUnder.lineX2 / 2 ? 0 : 1;
  }
  if ("statOverUnder" in kind) {
    return val(kind.statOverUnder.statKey) > kind.statOverUnder.lineX2 / 2 ? 0 : 1;
  }
  const { keyA, keyB, lineX2 } = kind.twoStatSumOverUnder;
  return val(keyA) + val(keyB) > lineX2 / 2 ? 0 : 1;
}
