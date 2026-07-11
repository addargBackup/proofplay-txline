/** ProofPlay keeper: creates preset markets for every World Cup fixture and
 *  settles them permissionlessly the moment TxLINE finalises a match.
 *
 *  Env:
 *    ANCHOR_WALLET       wallet path (default ../.keys/devnet-wallet.json)
 *    REPLAY_BASE_URL     point at a txline-replay server for judge/demo mode
 *    MINT                pool mint (default: .keys/pusdc-mint.json)
 *    BOUNTY_BPS          settler bounty (default 50 = 0.5%)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createTxlineClient, type ScoresStatValidationV2, type TxlineClient } from "@txline-kit/client";
import { epochDayFromTs } from "@txline-kit/client/proofs";
import { isFinalised, STAT } from "@txline-kit/constants";
import {
  KIND_WDL, kindOverUnder, dailyScoresRootsPda, loadWallet, marketPda,
  outcomeFromStats, proofplayProgram, ROOT, settleArgsFromProof,
  TXORACLE_PROGRAM_ID, vaultPda, WORLD_CUP, type MarketKindArg,
} from "./common.js";

const wallet = loadWallet();
const program = proofplayProgram(wallet);
const BOUNTY_BPS = Number(process.env.BOUNTY_BPS ?? 50);

const mint = new PublicKey(
  process.env.MINT ?? JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "pusdc-mint.json"), "utf8")).mint,
);

const replayBase = process.env.REPLAY_BASE_URL;
const tx: TxlineClient = replayBase
  ? createTxlineClient({ network: "replay", baseUrl: replayBase })
  : createTxlineClient({ network: "devnet", wallet });

const log = (msg: string, extra?: unknown) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...(extra ? { extra } : {}) }));

async function marketExists(pda: PublicKey): Promise<boolean> {
  return (await program.provider.connection.getAccountInfo(pda)) !== null;
}

async function createMarket(fixtureId: number, kickoffTsMs: number, kind: MarketKindArg) {
  const pda = marketPda(program.programId, fixtureId, kind);
  if (await marketExists(pda)) return;
  await program.methods
    .createMarket(new BN(fixtureId), new BN(Math.floor(kickoffTsMs / 1000)), kind, BOUNTY_BPS)
    .accounts({
      market: pda,
      vault: vaultPda(program.programId, pda),
      mint,
      creator: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log("market created", { fixtureId, kind, market: pda.toBase58() });
}

async function bootstrapMarkets() {
  await tx.auth.ensureActivated();
  const today = Math.floor(Date.now() / 86_400_000);
  const fixtures = await tx.fixturesSnapshot(WORLD_CUP, today - 1);
  const upcoming = fixtures.filter((f) => f.StartTime > Date.now() + 10 * 60_000);
  log(`bootstrap: ${fixtures.length} fixtures, ${upcoming.length} upcoming`);
  for (const f of upcoming) {
    try {
      await createMarket(f.FixtureId, f.StartTime, KIND_WDL);
      await createMarket(f.FixtureId, f.StartTime, kindOverUnder(5)); // O/U 2.5
    } catch (err) {
      log("market create failed", { fixture: f.FixtureId, err: String(err).slice(0, 200) });
    }
  }
}

async function settleFixture(fixtureId: number, finalSeq: number, stats: Record<string, number>) {
  const proof = (await tx.statValidation({
    fixtureId,
    seq: finalSeq,
    statKeys: [STAT.T1_GOALS, STAT.T2_GOALS],
  })) as ScoresStatValidationV2;
  const roots = dailyScoresRootsPda(epochDayFromTs(proof.summary.updateStats.minTimestamp));
  const settlerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  for (const kind of [KIND_WDL, kindOverUnder(5)]) {
    const pda = marketPda(program.programId, fixtureId, kind);
    if (!(await marketExists(pda))) continue;
    const state = await program.account.market.fetch(pda);
    if (!("open" in state.state)) continue;

    const outcome = outcomeFromStats(stats, kind);
    try {
      const sig = await program.methods
        .settle(settleArgsFromProof(proof, outcome))
        .accounts({
          market: pda,
          vault: vaultPda(program.programId, pda),
          settlerToken,
          settler: wallet.publicKey,
          dailyScoresMerkleRoots: roots,
          txoracleProgram: TXORACLE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .rpc();
      log("SETTLED ✅", { fixtureId, kind, outcome, sig });
    } catch (err) {
      log("settle failed", { fixtureId, kind, err: String(err).slice(0, 300) });
    }
  }
}

async function liveLoop() {
  log(`live loop starting (${replayBase ? "REPLAY " + replayBase : "devnet live"})`);
  for (;;) {
    try {
      for await (const msg of tx.scoresStream()) {
        const u = msg.data;
        if (!u?.FixtureId) continue;
        if (isFinalised(u)) {
          log("fixture finalised", { fixtureId: u.FixtureId, seq: u.Seq, stats: u.Stats });
          await settleFixture(u.FixtureId, u.Seq, u.Stats ?? {});
        }
      }
    } catch (err) {
      log("stream loop error; restarting in 5s", { err: String(err).slice(0, 200) });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await bootstrapMarkets();
await liveLoop();
