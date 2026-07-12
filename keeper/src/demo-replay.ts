/** ONE-COMMAND JUDGE DEMO (`pnpm demo`): the full trustless market lifecycle
 *  against a REAL recorded World Cup match, in about a minute.
 *
 *  1. starts a wire-compatible TxLINE replay of the committed corpus sample
 *  2. creates 1X2 + O/U 2.5 markets for that fixture (short betting window)
 *  3. two demo bettors take opposite sides
 *  4. betting locks at kickoff; the replay fast-forwards to full time
 *  5. on game_finalised, the settler fetches the REAL Merkle proof from
 *     TxLINE's live API and settles both markets on devnet via CPI
 *  6. prints the receipt + app URLs
 *
 *  Needs: funded devnet wallet (../.keys/devnet-wallet.json), pUSDC mint
 *  (pnpm setup-mint), TxLINE devnet activation (automatic on first run).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, getAssociatedTokenAddressSync,
  transfer as splTransfer,
} from "@solana/spl-token";
import { createTxlineClient } from "@txline-kit/client";
import { isFinalised } from "@txline-kit/constants";
import { startReplayServer } from "@txline-kit/replay";
import {
  KIND_WDL, kindOverUnder, connection, loadWallet, marketPda, positionPda,
  proofplayProgram, ROOT, vaultPda, type MarketKindArg,
} from "./common.js";
import { settleAllForFixture } from "./settler.js";

const PORT = Number(process.env.REPLAY_PORT ?? 8788);
const corpusDir = process.env.CORPUS_DIR ?? path.join(ROOT, "corpus-sample");
const FIXTURE = Number(process.env.DEMO_FIXTURE ?? fs.readdirSync(corpusDir).find((d) => /^\d+$/.test(d)));
const conn = connection();
const keeper = loadWallet();
const program = proofplayProgram(keeper);
const mint = new PublicKey(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "pusdc-mint.json"), "utf8")).mint);
const step = (s: string) => console.log(`\n=== ${s}`);

// --- 1. replay server ---------------------------------------------------------
step(`replay: fixture ${FIXTURE} from ${corpusDir}`);
startReplayServer({ fixtureId: FIXTURE, corpusDir, speed: 60, port: PORT });
const control = (action: string, value?: number) =>
  fetch(`http://localhost:${PORT}/control`, { method: "POST", body: JSON.stringify({ action, value }) });
await control("pause");

// --- 2. demo bettors -----------------------------------------------------------
step("funding two demo bettors");
const alice = Keypair.generate();
const bob = Keypair.generate();
{
  const t = new Transaction();
  for (const w of [alice, bob]) {
    t.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: w.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL }));
  }
  await anchor.web3.sendAndConfirmTransaction(conn, t, [keeper], { commitment: "confirmed" });
}
const keeperAta = getAssociatedTokenAddressSync(mint, keeper.publicKey);
const atas: Record<string, PublicKey> = {};
for (const [name, w] of [["alice", alice], ["bob", bob]] as const) {
  atas[name] = await createAssociatedTokenAccountIdempotent(conn, keeper, mint, w.publicKey);
  await splTransfer(conn, keeper, keeperAta, atas[name], keeper, 200_000_000n); // 200 pUSDC each
}

// --- 3. markets + bets ----------------------------------------------------------
// Markets are one-per-(fixture, kind) FOREVER (that's the protocol working) —
// so each demo run auto-selects kinds nobody has used yet: 1X2 if free, then
// unused goals-O/U lines, then unused corners-prop lines. Re-runnable ~forever.
const kickoff = Math.floor(Date.now() / 1000) + 30;
const { kindTwoStatSum } = await import("./common.js");
const candidates: MarketKindArg[] = [
  KIND_WDL,
  ...[5, 7, 3, 9, 11, 13].map((l) => kindOverUnder(l)),
  ...[21, 19, 23, 17, 25, 15].map((l) => kindTwoStatSum(7, 8, l)),
];
const kinds: MarketKindArg[] = [];
for (const kind of candidates) {
  if (kinds.length >= 2) break;
  if (!(await conn.getAccountInfo(marketPda(program.programId, FIXTURE, kind)))) kinds.push(kind);
}
if (kinds.length === 0) {
  console.log("every candidate market kind is already settled for this fixture — set DEMO_FIXTURE to another corpus fixture");
  process.exit(1);
}
step(`creating ${kinds.length} unused markets, 30s betting window`);
for (const kind of kinds) {
  const pda = marketPda(program.programId, FIXTURE, kind);
  await program.methods
    .createMarket(new BN(FIXTURE), new BN(kickoff), kind, 50)
    .accounts({
      market: pda, vault: vaultPda(program.programId, pda), mint,
      creator: keeper.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  market: ${pda.toBase58()} (${JSON.stringify(kind)})`);
}

step("bets: alice -> outcome 0 (75), bob -> last outcome (40) on the first market");
const wdl = marketPda(program.programId, FIXTURE, kinds[0]);
const wdlOutcomes = "winnerDrawLoser" in kinds[0] ? 3 : 2;
const bet = (bettor: Keypair, ata: PublicKey, outcome: number, amount: number) =>
  program.methods
    .bet(outcome, new BN(amount * 1e6))
    .accounts({
      market: wdl, position: positionPda(program.programId, wdl, bettor.publicKey),
      vault: vaultPda(program.programId, wdl), bettorToken: ata,
      bettor: bettor.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([bettor])
    .rpc();
await bet(alice, atas.alice, 0, 75);
await bet(bob, atas.bob, wdlOutcomes - 1, 40);
console.log("  pools:", (await (program.account as any).market.fetch(wdl)).pools.map(String));

step("waiting for kickoff lock…");
await new Promise((r) => setTimeout(r, 32_000));

// --- 4. fast-forward the match to the closing minutes ---------------------------
const frames = fs.readFileSync(path.join(corpusDir, String(FIXTURE), "scores.jsonl"), "utf8").split("\n").filter(Boolean);
const lastTs = JSON.parse(frames[frames.length - 1]).ts;
await control("seek", lastTs - 3 * 60_000); // 3 match-minutes before the final record
await control("resume");
step("replaying the final minutes at 60x — watching for game_finalised");

// --- 5. autonomous settlement ----------------------------------------------------
const replay = createTxlineClient({ network: "replay", baseUrl: `http://localhost:${PORT}/api` });
const api = createTxlineClient({ network: "devnet", wallet: keeper }); // proofs = real API, always
await api.auth.ensureActivated();

for await (const msg of replay.scoresStream()) {
  const u = msg.data;
  if (!isFinalised(u)) continue;
  console.log(`  FINALISED: seq=${u.Seq} score=${u.Stats?.["1"]}-${u.Stats?.["2"]}`);
  const results = await settleAllForFixture({
    program, wallet: keeper, api, mint, fixtureId: FIXTURE, finalSeq: u.Seq, stats: u.Stats ?? {}, kinds,
  });
  step("SETTLED — receipts");
  for (const r of results) {
    console.log(`  ${r.kindLabel}: outcome ${r.outcome} — tx ${r.sig}`);
    console.log(`    app: http://localhost:3040/market/${r.market}`);
  }
  break;
}

console.log("\nDemo complete. Open the app to inspect pools, receipts, and claims.");
process.exit(0);
