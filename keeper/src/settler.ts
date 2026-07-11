/** Shared settlement engine: fetch the REAL TxLINE Merkle proof and settle
 *  every open market for a fixture. Used by the live keeper and the demo. */
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ScoresStatValidationV2, TxlineClient } from "@txline-kit/client";
import { epochDayFromTs } from "@txline-kit/client/proofs";
import {
  dailyScoresRootsPda, kindStatKeys, marketPda, outcomeFromStats,
  settleArgsFromProof, TXORACLE_PROGRAM_ID, vaultPda, type MarketKindArg,
} from "./common.js";

export interface SettleResult {
  market: string;
  kindLabel: string;
  outcome: number;
  sig: string;
}

export async function settleAllForFixture(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: anchor.Program<any>;
  wallet: Keypair;
  api: TxlineClient; // REAL API client — proofs never come from a replay
  mint: PublicKey;
  fixtureId: number;
  finalSeq: number;
  stats: Record<string, number>;
  kinds: MarketKindArg[];
}): Promise<SettleResult[]> {
  const { program, wallet, api, mint, fixtureId, finalSeq, stats, kinds } = opts;
  const settlerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const results: SettleResult[] = [];
  // One proof fetch per distinct key-set (kinds share proofs where possible).
  const proofCache = new Map<string, ScoresStatValidationV2>();
  const proofFor = async (keys: number[]) => {
    const cacheKey = keys.join(",");
    if (!proofCache.has(cacheKey)) {
      proofCache.set(
        cacheKey,
        (await api.statValidation({ fixtureId, seq: finalSeq, statKeys: keys })) as ScoresStatValidationV2,
      );
    }
    return proofCache.get(cacheKey)!;
  };

  for (const kind of kinds) {
    const pda = marketPda(program.programId, fixtureId, kind);
    const info = await program.provider.connection.getAccountInfo(pda);
    if (!info) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (program.account as any).market.fetch(pda);
    if (!("open" in state.state)) continue;

    const proof = await proofFor(kindStatKeys(kind));
    const roots = dailyScoresRootsPda(epochDayFromTs(proof.summary.updateStats.minTimestamp));
    const outcome = outcomeFromStats(stats, kind);
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
    const kindLabel = "winnerDrawLoser" in kind
      ? "1X2"
      : "totalGoalsOverUnder" in kind
        ? `Goals O/U ${kind.totalGoalsOverUnder.lineX2 / 2}`
        : "statOverUnder" in kind
          ? `Stat ${kind.statOverUnder.statKey} O/U ${kind.statOverUnder.lineX2 / 2}`
          : `Stats ${kind.twoStatSumOverUnder.keyA}+${kind.twoStatSumOverUnder.keyB} O/U ${kind.twoStatSumOverUnder.lineX2 / 2}`;
    results.push({ market: pda.toBase58(), kindLabel, outcome, sig });
  }
  return results;
}
