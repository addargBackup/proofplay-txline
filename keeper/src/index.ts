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
import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createTxlineClient, type TxlineClient } from "@txline-kit/client";
import { isFinalised } from "@txline-kit/constants";
import {
  KIND_WDL, kindOverUnder, loadWallet, marketPda, proofplayProgram, ROOT,
  vaultPda, WORLD_CUP, type MarketKindArg,
} from "./common.js";
import { settleAllForFixture } from "./settler.js";

const wallet = loadWallet();
const program = proofplayProgram(wallet);
const BOUNTY_BPS = Number(process.env.BOUNTY_BPS ?? 50);

const mint = new PublicKey(
  process.env.MINT ?? JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "pusdc-mint.json"), "utf8")).mint,
);

const replayBase = process.env.REPLAY_BASE_URL;
/** Stream source: replay server in judge/demo mode, live devnet otherwise. */
const tx: TxlineClient = replayBase
  ? createTxlineClient({ network: "replay", baseUrl: replayBase })
  : createTxlineClient({ network: "devnet", wallet });
/** Proofs + fixtures ALWAYS come from the real API — a replay server replays
 *  streams; Merkle proofs must be fetched fresh from TxLINE. */
const api: TxlineClient = replayBase ? createTxlineClient({ network: "devnet", wallet }) : tx;

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
  await api.auth.ensureActivated();
  const today = Math.floor(Date.now() / 86_400_000);
  const fixtures = await api.fixturesSnapshot(WORLD_CUP, today - 1);
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
  try {
    const results = await settleAllForFixture({
      program, wallet, api, mint, fixtureId, finalSeq, stats,
      kinds: [KIND_WDL, kindOverUnder(5)],
    });
    for (const r of results) log("SETTLED ✅", r);
    if (results.length === 0) log("no open markets for fixture", { fixtureId });
  } catch (err) {
    log("settle failed", { fixtureId, err: String(err).slice(0, 300) });
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

/** Boot-time catch-up: settle any open market whose fixture finished while the
 *  keeper was offline (the live loop only sees NEW game_finalised events).
 *  Uses the historical endpoint (~6h–2wk window) to recover the final record. */
async function sweepUnsettled() {
  const today = Math.floor(Date.now() / 86_400_000);
  const fixtures = await api.fixturesSnapshot(WORLD_CUP, today - 13);
  const finished = fixtures.filter((f) => f.StartTime < Date.now() - 2 * 3600_000);
  for (const f of finished) {
    const anyOpen = (await Promise.all(
      [KIND_WDL, kindOverUnder(5)].map(async (kind) => {
        const pda = marketPda(program.programId, f.FixtureId, kind);
        if (!(await marketExists(pda))) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = await (program.account as any).market.fetch(pda);
        return "open" in m.state;
      }),
    )).some(Boolean);
    if (!anyOpen) continue;
    try {
      const updates = await api.scoresHistorical(f.FixtureId);
      const final = updates.filter(isFinalised).at(-1);
      if (!final?.Stats) {
        log("sweep: fixture finished but no finalised record yet", { fixtureId: f.FixtureId });
        continue;
      }
      log("sweep: settling missed fixture", { fixtureId: f.FixtureId, seq: final.Seq });
      await settleFixture(f.FixtureId, final.Seq, final.Stats);
    } catch (err) {
      log("sweep failed for fixture", { fixtureId: f.FixtureId, err: String(err).slice(0, 200) });
    }
  }
}

if (replayBase) log("replay mode: skipping market bootstrap (create demo markets via pnpm demo)");
else {
  await bootstrapMarkets();
  await sweepUnsettled();
}
await liveLoop();
