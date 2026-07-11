/** End-to-end on DEVNET with a REAL TxLINE proof.
 *  Fixture 18209181 France vs Morocco, finished 2-0 (home win, under 2.5? no:
 *  2 goals total -> under 2.5). Flow:
 *   1. create WDL market (kickoff now+40s) + bets from two wallets
 *   2. wait for kickoff -> betting locks
 *   3. settle with the real final-seq proof (claimed_outcome = home) -> ✅
 *   4. negative: settle O/U market claiming OVER with the same proof -> rejected
 *   5. negative: mid-match proof (period=4) -> NotFinal
 *   6. claims: winner paid, loser rejected
 *  Run: pnpm test:devnet   (needs activated TxLINE creds + funded wallet)
 */
import assert from "node:assert";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent, getAccount,
  getAssociatedTokenAddressSync, transfer as splTransfer,
} from "@solana/spl-token";
import { createTxlineClient, type ScoresStatValidationV2 } from "@txline-kit/client";
import { epochDayFromTs } from "@txline-kit/client/proofs";
import { isFinalised, STAT } from "@txline-kit/constants";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  KIND_WDL, kindOverUnder, connection, dailyScoresRootsPda, loadWallet, marketPda,
  positionPda, proofplayProgram, ROOT, settleArgsFromProof, TXORACLE_PROGRAM_ID, vaultPda,
} from "../keeper/src/common.js";

const conn = connection();
const walletA = loadWallet(); // creator + winning bettor + settler
const program = proofplayProgram(walletA);
const mint = new PublicKey(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "pusdc-mint.json"), "utf8")).mint);

const step = (s: string) => console.log(`\n=== ${s}`);

// Pick a FINISHED fixture whose markets don't exist yet (markets settle once,
// forever — that's the point — so each test run consumes a fresh fixture).
step("pick a fresh finished fixture");
const txl = createTxlineClient({ network: "devnet", wallet: walletA });
await txl.auth.ensureActivated();
const today = Math.floor(Date.now() / 86_400_000);
const all = await txl.fixturesSnapshot(72, today - 13);
const now = Date.now();
const candidates = all
  .filter((f) => f.StartTime < now - 6 * 3_600_000 && f.StartTime > now - 13 * 86_400_000)
  .sort((a, b) => b.StartTime - a.StartTime);
let FIXTURE = 0;
let fixtureName = "";
for (const f of candidates) {
  if (!(await conn.getAccountInfo(marketPda(program.programId, f.FixtureId, KIND_WDL)))) {
    FIXTURE = f.FixtureId;
    fixtureName = `${f.Participant1} vs ${f.Participant2}`;
    break;
  }
}
if (!FIXTURE) throw new Error("no unused finished fixture available");

const allUpdates = await txl.scoresHistorical(FIXTURE);
const finalRec = allUpdates.filter(isFinalised).at(-1);
if (!finalRec?.Stats) throw new Error(`fixture ${FIXTURE} has no finalised record`);
const home = finalRec.Stats["1"] ?? 0;
const away = finalRec.Stats["2"] ?? 0;
const trueWdl = home > away ? 0 : home === away ? 1 : 2; // program outcome index
const trueOu = home + away > 2.5 ? 0 : 1;
console.log(`fixture ${FIXTURE} ${fixtureName}: final ${home}-${away} (wdl=${trueWdl}, ou2.5=${trueOu === 0 ? "over" : "under"})`);

// --- funding: second bettor wallet (SOL from A, pUSDC from A's stash) --------
step("fund bettor B");
const walletB = Keypair.generate();
{
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: walletA.publicKey, toPubkey: walletB.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  );
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [walletA]);
}
const ataA = getAssociatedTokenAddressSync(mint, walletA.publicKey);
const ataB = await createAssociatedTokenAccountIdempotent(conn, walletA, mint, walletB.publicKey);
await splTransfer(conn, walletA, ataA, ataB, walletA, 500_000_000n); // 500 pUSDC to B

// --- markets (unique per run impossible: PDA is per fixture+kind; if a prior
// run already settled them, recreate is impossible — use fresh fixture offsets
// is NOT possible either. So: if market exists and is settled, we bail early
// with a hint to redeploy a fresh program for a clean run.) -------------------
step("create markets");
const wdl = marketPda(program.programId, FIXTURE, KIND_WDL);
const ou = marketPda(program.programId, FIXTURE, kindOverUnder(5));
const kickoff = Math.floor(Date.now() / 1000) + 40;

for (const [pda, kind] of [[wdl, KIND_WDL], [ou, kindOverUnder(5)]] as const) {
  if (await conn.getAccountInfo(pda)) {
    const m = await program.account.market.fetch(pda);
    if (!("open" in m.state)) throw new Error("Market already settled from a previous run — redeploy for a clean test");
    console.log("market exists, reusing:", pda.toBase58());
    continue;
  }
  await program.methods
    .createMarket(new BN(FIXTURE), new BN(kickoff), kind, 50)
    .accounts({
      market: pda, vault: vaultPda(program.programId, pda), mint,
      creator: walletA.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("created:", pda.toBase58());
}

// --- bets --------------------------------------------------------------------
const loseWdl = (trueWdl + 1) % 3;
step(`bets: A -> outcome ${trueWdl} (100, true), B -> outcome ${loseWdl} (50, false)`);
const betAccounts = (market: PublicKey, bettor: Keypair, bettorToken: PublicKey) => ({
  market, position: positionPda(program.programId, market, bettor.publicKey),
  vault: vaultPda(program.programId, market), bettorToken,
  bettor: bettor.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
});
await program.methods.bet(trueWdl, new BN(100_000_000)).accounts(betAccounts(wdl, walletA, ataA)).rpc();
await program.methods.bet(loseWdl, new BN(50_000_000)).accounts(betAccounts(wdl, walletB, ataB)).signers([walletB]).rpc();
const pools = (await program.account.market.fetch(wdl)).pools.map(String);
console.log("pools:", pools);
assert(pools[trueWdl] === "100000000" && pools[loseWdl] === "50000000", "pools should reflect both bets");

step("wait for kickoff lock");
await new Promise((r) => setTimeout(r, 45_000));
try {
  await program.methods.bet(trueWdl, new BN(1_000_000)).accounts(betAccounts(wdl, walletA, ataA)).rpc();
  throw new Error("bet after kickoff should have failed");
} catch (e) {
  assert(String(e).includes("BettingClosed"), `expected BettingClosed, got: ${String(e).slice(0, 120)}`);
  console.log("betting locked at kickoff ✅");
}

// --- real proof ---------------------------------------------------------------
step("fetch real final proof from TxLINE");
const updates = allUpdates;
const finalUpdate = finalRec;
console.log(`final: seq=${finalUpdate.Seq} score=${home}-${away}`);
const proof = (await txl.statValidation({ fixtureId: FIXTURE, seq: finalUpdate.Seq, statKeys: [STAT.T1_GOALS, STAT.T2_GOALS] })) as ScoresStatValidationV2;
const roots = dailyScoresRootsPda(epochDayFromTs(proof.summary.updateStats.minTimestamp));
const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
const settleAccounts = (market: PublicKey) => ({
  market, vault: vaultPda(program.programId, market), settlerToken: ataA,
  settler: walletA.publicKey, dailyScoresMerkleRoots: roots,
  txoracleProgram: TXORACLE_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
});

step(`settle WDL claiming outcome ${trueWdl} (true) — expect success`);
const sig = await program.methods
  .settle(settleArgsFromProof(proof, trueWdl))
  .accounts(settleAccounts(wdl))
  .preInstructions([budget])
  .rpc();
console.log("SETTLED ✅", sig);
const settled = await program.account.market.fetch(wdl);
assert("settled" in settled.state && settled.outcome === trueWdl, "market should be settled to the true outcome");

step(`negative: settle O/U claiming ${trueOu === 0 ? "UNDER" : "OVER"} (false) — expect ProofRejected`);
try {
  await program.methods.settle(settleArgsFromProof(proof, 1 - trueOu)).accounts(settleAccounts(ou)).preInstructions([budget]).rpc();
  throw new Error("false outcome should have failed");
} catch (e) {
  assert(String(e).includes("ProofRejected"), `expected ProofRejected, got: ${String(e).slice(0, 200)}`);
  console.log("false outcome rejected by CPI ✅");
}

step("negative: mid-match proof — expect NotFinal");
const mid = updates.find((u) => (u.StatusId as number) === 4 && u.Seq > 0)!;
const midProof = (await txl.statValidation({ fixtureId: FIXTURE, seq: mid.Seq, statKeys: [STAT.T1_GOALS, STAT.T2_GOALS] })) as ScoresStatValidationV2;
try {
  await program.methods.settle(settleArgsFromProof(midProof, trueOu)).accounts(settleAccounts(ou)).preInstructions([budget]).rpc();
  throw new Error("mid-match proof should have failed");
} catch (e) {
  assert(String(e).includes("NotFinal"), `expected NotFinal, got: ${String(e).slice(0, 200)}`);
  console.log("mid-match proof blocked by period==100 guard ✅");
}

step(`settle O/U claiming ${trueOu === 0 ? "OVER" : "UNDER"} (true) — expect success`);
await program.methods.settle(settleArgsFromProof(proof, trueOu)).accounts(settleAccounts(ou)).preInstructions([budget]).rpc();
console.log("O/U settled ✅");

// --- claims -------------------------------------------------------------------
step("claims");
const before = (await getAccount(conn, ataA)).amount;
await program.methods.claim().accounts({
  market: wdl, position: positionPda(program.programId, wdl, walletA.publicKey),
  vault: vaultPda(program.programId, wdl), claimerToken: ataA,
  claimer: walletA.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
}).rpc();
const won = (await getAccount(conn, ataA)).amount - before;
// pool 150, bounty 0.5% = 0.75 -> A (sole winner) gets 149.25
console.log(`winner claimed ${Number(won) / 1e6} pUSDC (staked 100)`);
assert(won === 149_250_000n, `expected 149.25 pUSDC, got ${won}`);

try {
  await program.methods.claim().accounts({
    market: wdl, position: positionPda(program.programId, wdl, walletB.publicKey),
    vault: vaultPda(program.programId, wdl), claimerToken: ataB,
    claimer: walletB.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([walletB]).rpc();
  throw new Error("loser claim should have failed");
} catch (e) {
  assert(String(e).includes("NotAWinner"), `expected NotAWinner, got: ${String(e).slice(0, 120)}`);
  console.log("loser claim rejected ✅");
}

console.log("\nALL DEVNET TESTS PASSED 🎉 — parimutuel lifecycle settled by a real TxLINE Merkle proof");
