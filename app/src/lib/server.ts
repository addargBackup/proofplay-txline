/** Server-only: anchor program reads, unsigned-tx builders, TxLINE access.
 *  The browser never touches Anchor or TxLINE — API routes return JSON and
 *  base64 unsigned transactions that the wallet signs (Solana Pay pattern). */
import "server-only";
import * as fs from "node:fs";
import * as path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createTxlineClient, type Fixture, type ScoresStatValidationV2, type TxlineClient } from "@txline-kit/client";
import { epochDayFromTs, toBytes32, toProofNodes } from "@txline-kit/client/proofs";
import idl from "../idl/proofplay.json";

export const TXORACLE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
export const WORLD_CUP = 72;
export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const conn = new Connection(RPC_URL, "confirmed");

// --- keeper wallet (faucet + fallback fee payer targets) ---------------------
function loadKeeperWallet(): Keypair | null {
  if (process.env.KEEPER_WALLET_JSON) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEEPER_WALLET_JSON)));
  }
  const p = process.env.ANCHOR_WALLET ?? path.resolve(process.cwd(), "..", "..", ".keys", "devnet-wallet.json");
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  } catch {
    return null;
  }
}
export const keeperWallet = loadKeeperWallet();

export function mintAddress(): PublicKey {
  if (process.env.MINT) return new PublicKey(process.env.MINT);
  const p = path.resolve(process.cwd(), "..", ".keys", "pusdc-mint.json");
  const alt = path.resolve(process.cwd(), "..", "..", ".keys", "pusdc-mint.json");
  const file = fs.existsSync(p) ? p : alt;
  return new PublicKey(JSON.parse(fs.readFileSync(file, "utf8")).mint);
}

// --- anchor program (read-only provider; txs are returned unsigned) ----------
// Plain wallet-interface object: anchor's Wallet class isn't exported from the
// ESM entry, and this provider never signs anything anyway.
const dummyKey = Keypair.generate();
const readonlyWallet = {
  publicKey: dummyKey.publicKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: async (t: any) => t,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signAllTransactions: async (t: any) => t,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readonlyProvider = new anchor.AnchorProvider(conn, readonlyWallet as any, { commitment: "confirmed" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const program = new anchor.Program(idl as any, readonlyProvider);
// Anchor account namespace is untyped with a generic Idl — expose it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accounts: any = program.account;

// --- TxLINE client (server singleton; env-token or persisted creds) ----------
let txlineSingleton: TxlineClient | null = null;
export function txline(): TxlineClient {
  if (!txlineSingleton) {
    txlineSingleton = createTxlineClient({ network: "devnet", wallet: keeperWallet ?? undefined });
  }
  return txlineSingleton;
}

// --- kinds + PDAs (mirror of programs/proofplay) ------------------------------
export type MarketKindArg =
  | { winnerDrawLoser: Record<string, never> }
  | { totalGoalsOverUnder: { lineX2: number } }
  | { statOverUnder: { statKey: number; lineX2: number } }
  | { twoStatSumOverUnder: { keyA: number; keyB: number; lineX2: number } };

export const KIND_WDL: MarketKindArg = { winnerDrawLoser: {} };
export const kindOverUnder = (lineX2: number): MarketKindArg => ({ totalGoalsOverUnder: { lineX2 } });

export function validStatKey(key: number): boolean {
  const base = key % 1000;
  const period = key - base;
  return base >= 1 && base <= 8 && period % 1000 === 0 && period <= 7000;
}
export const validHalfLine = (lineX2: number) => lineX2 % 2 === 1 && lineX2 > 0 && lineX2 < 100;

/** Validate an untrusted kind payload from the client. */
export function parseKind(raw: unknown): MarketKindArg {
  const k = raw as MarketKindArg;
  if (k && typeof k === "object") {
    if ("winnerDrawLoser" in k) return KIND_WDL;
    if ("totalGoalsOverUnder" in k && validHalfLine(Number(k.totalGoalsOverUnder?.lineX2))) {
      return kindOverUnder(Number(k.totalGoalsOverUnder.lineX2));
    }
    if ("statOverUnder" in k) {
      const { statKey, lineX2 } = k.statOverUnder ?? {};
      if (validStatKey(Number(statKey)) && validHalfLine(Number(lineX2))) {
        return { statOverUnder: { statKey: Number(statKey), lineX2: Number(lineX2) } };
      }
    }
    if ("twoStatSumOverUnder" in k) {
      const { keyA, keyB, lineX2 } = k.twoStatSumOverUnder ?? {};
      if (validStatKey(Number(keyA)) && validStatKey(Number(keyB)) && keyA !== keyB && validHalfLine(Number(lineX2))) {
        return { twoStatSumOverUnder: { keyA: Number(keyA), keyB: Number(keyB), lineX2: Number(lineX2) } };
      }
    }
  }
  throw new Error("invalid market kind (half lines only; stat keys = base 1-8 + period prefix)");
}

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
  if ("winnerDrawLoser" in kind || "totalGoalsOverUnder" in kind) return [1, 2];
  if ("statOverUnder" in kind) return [kind.statOverUnder.statKey];
  return [kind.twoStatSumOverUnder.keyA, kind.twoStatSumOverUnder.keyB];
}

export function marketPda(fixtureId: number, kind: MarketKindArg): PublicKey {
  const fid = Buffer.alloc(8);
  fid.writeBigInt64LE(BigInt(fixtureId));
  return PublicKey.findProgramAddressSync([Buffer.from("market"), fid, kindSeed(kind)], PROGRAM_ID)[0];
}
export function vaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];
}
export function positionPda(market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), market.toBuffer(), bettor.toBuffer()], PROGRAM_ID)[0];
}
export function dailyScoresRootsPda(epochDay: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toBuffer("le", 2)],
    TXORACLE_PROGRAM_ID,
  )[0];
}

// --- serialization ------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function marketToJson(address: PublicKey, m: any) {
  const kind = "winnerDrawLoser" in m.kind
    ? { type: "wdl" as const }
    : "totalGoalsOverUnder" in m.kind
      ? { type: "ou" as const, lineX2: m.kind.totalGoalsOverUnder.lineX2 as number }
      : "statOverUnder" in m.kind
        ? {
            type: "statOu" as const,
            statKey: m.kind.statOverUnder.statKey as number,
            lineX2: m.kind.statOverUnder.lineX2 as number,
          }
        : {
            type: "sumOu" as const,
            keyA: m.kind.twoStatSumOverUnder.keyA as number,
            keyB: m.kind.twoStatSumOverUnder.keyB as number,
            lineX2: m.kind.twoStatSumOverUnder.lineX2 as number,
          };
  const state = "open" in m.state ? "open" : "settled" in m.state ? "settled" : "voided";
  return {
    address: address.toBase58(),
    fixtureId: Number(m.fixtureId),
    kickoffTs: Number(m.kickoffTs) * 1000,
    kind,
    state,
    outcome: state === "settled" ? (m.outcome as number) : null,
    numOutcomes: m.numOutcomes as number,
    pools: (m.pools as BN[]).slice(0, m.numOutcomes).map((p) => Number(p) / 1e6),
    totalPool: Number(m.totalPool) / 1e6,
    bountyBps: m.bountyBps as number,
    mint: (m.mint as PublicKey).toBase58(),
    receipt: state === "settled"
      ? {
          eventStatRoot: Buffer.from(m.receiptEventStatRoot as number[]).toString("hex"),
          minTimestamp: Number(m.receiptMinTimestamp),
          settler: (m.settler as PublicKey).toBase58(),
          dailyRootsPda: dailyScoresRootsPda(epochDayFromTs(Number(m.receiptMinTimestamp))).toBase58(),
        }
      : null,
  };
}
export type MarketJson = ReturnType<typeof marketToJson>;

// --- fixture cache -------------------------------------------------------------
let fixtureCache: { at: number; byId: Map<number, Fixture> } | null = null;
export async function fixturesById(): Promise<Map<number, Fixture>> {
  if (fixtureCache && Date.now() - fixtureCache.at < 60_000) return fixtureCache.byId;
  const tx = txline();
  await tx.auth.ensureActivated();
  const today = Math.floor(Date.now() / 86_400_000);
  const [past, future] = await Promise.all([
    tx.fixturesSnapshot(WORLD_CUP, today - 14),
    tx.fixturesSnapshot(WORLD_CUP, today),
  ]);
  const byId = new Map<number, Fixture>();
  for (const f of [...past, ...future]) byId.set(f.FixtureId, f);
  fixtureCache = { at: Date.now(), byId };
  return byId;
}

// --- tx builders (unsigned, base64) --------------------------------------------
async function finalize(tx: Transaction, feePayer: PublicKey): Promise<string> {
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export async function buildBetTx(marketAddr: PublicKey, bettor: PublicKey, outcome: number, amountUi: number): Promise<string> {
  const mint = mintAddress();
  const bettorToken = getAssociatedTokenAddressSync(mint, bettor);
  const ix = await program.methods
    .bet(outcome, new BN(Math.round(amountUi * 1e6)))
    .accounts({
      market: marketAddr,
      position: positionPda(marketAddr, bettor),
      vault: vaultPda(marketAddr),
      bettorToken,
      bettor,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return finalize(new Transaction().add(ix), bettor);
}

export async function buildClaimTx(marketAddr: PublicKey, claimer: PublicKey): Promise<string> {
  const mint = mintAddress();
  const ix = await program.methods
    .claim()
    .accounts({
      market: marketAddr,
      position: positionPda(marketAddr, claimer),
      vault: vaultPda(marketAddr),
      claimerToken: getAssociatedTokenAddressSync(mint, claimer),
      claimer,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return finalize(new Transaction().add(ix), claimer);
}

export async function buildCreateMarketTx(
  fixtureId: number, kickoffTsMs: number, kind: MarketKindArg, bountyBps: number, creator: PublicKey,
): Promise<{ tx: string; market: string }> {
  const market = marketPda(fixtureId, kind);
  const ix = await program.methods
    .createMarket(new BN(fixtureId), new BN(Math.floor(kickoffTsMs / 1000)), kind, bountyBps)
    .accounts({
      market,
      vault: vaultPda(market),
      mint: mintAddress(),
      creator,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { tx: await finalize(new Transaction().add(ix), creator), market: market.toBase58() };
}

/** Faucet: keeper wallet sends devnet pUSDC (demo money) to the user. */
export async function faucetTo(dest: PublicKey, amountUi: number): Promise<string> {
  if (!keeperWallet) throw new Error("faucet unavailable: no keeper wallet configured");
  const mint = mintAddress();
  const from = getAssociatedTokenAddressSync(mint, keeperWallet.publicKey);
  const to = getAssociatedTokenAddressSync(mint, dest);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(keeperWallet.publicKey, to, dest, mint),
    createTransferInstruction(from, to, keeperWallet.publicKey, BigInt(Math.round(amountUi * 1e6))),
  );
  return anchor.web3.sendAndConfirmTransaction(conn, tx, [keeperWallet], { commitment: "confirmed" });
}

/** Settle-tx builder so ANY connected wallet can be the settler from the UI. */
export async function buildSettleTx(marketAddr: PublicKey, settler: PublicKey): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await accounts.market.fetch(marketAddr);
  const fixtureId = Number(m.fixtureId);
  const tx = txline();
  await tx.auth.ensureActivated();
  // Future fixtures return an empty body here — map parse noise to human copy.
  const updates = await tx.scoresHistorical(fixtureId).catch(() => []);
  const finalRec = updates.filter((u) => u.Action === "game_finalised").at(-1);
  if (!finalRec?.Stats) throw new Error("match not finished yet (settlement needs the final TxLINE record)");
  const stats = finalRec.Stats;
  const val = (k: number) => stats[String(k)] ?? 0;
  const home = val(1);
  const away = val(2);
  let outcome: number;
  if ("winnerDrawLoser" in m.kind) outcome = home > away ? 0 : home === away ? 1 : 2;
  else if ("totalGoalsOverUnder" in m.kind) outcome = home + away > m.kind.totalGoalsOverUnder.lineX2 / 2 ? 0 : 1;
  else if ("statOverUnder" in m.kind) outcome = val(m.kind.statOverUnder.statKey) > m.kind.statOverUnder.lineX2 / 2 ? 0 : 1;
  else {
    const { keyA, keyB, lineX2 } = m.kind.twoStatSumOverUnder;
    outcome = val(keyA) + val(keyB) > lineX2 / 2 ? 0 : 1;
  }

  const statKeys = kindStatKeys(m.kind as MarketKindArg);
  const proof = (await tx.statValidation({ fixtureId, seq: finalRec.Seq, statKeys })) as ScoresStatValidationV2;
  const statTerm = (i: number) => ({
    statToProve: proof.statsToProve[i],
    eventStatRoot: toBytes32(proof.eventStatRoot),
    statProof: toProofNodes(proof.statProofs[i]),
  });
  const args = {
    claimedOutcome: outcome,
    ts: new BN(proof.summary.updateStats.minTimestamp),
    summary: {
      fixtureId: new BN(proof.summary.fixtureId),
      updateStats: {
        updateCount: proof.summary.updateStats.updateCount,
        minTimestamp: new BN(proof.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(proof.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: toBytes32(proof.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: toProofNodes(proof.subTreeProof),
    mainTreeProof: toProofNodes(proof.mainTreeProof),
    statA: statTerm(0),
    statB: statKeys.length > 1 ? statTerm(1) : null,
  };
  const ix = await program.methods
    .settle(args)
    .accounts({
      market: marketAddr,
      vault: vaultPda(marketAddr),
      settlerToken: getAssociatedTokenAddressSync(mintAddress(), settler),
      settler,
      dailyScoresMerkleRoots: dailyScoresRootsPda(epochDayFromTs(proof.summary.updateStats.minTimestamp)),
      txoracleProgram: TXORACLE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
  return finalize(t, settler);
}
