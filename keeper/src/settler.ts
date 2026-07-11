/** Shared settlement engine: fetch the REAL TxLINE Merkle proof and settle
 *  every open market for a fixture. Used by the live keeper and the demo. */
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ScoresStatValidationV2, TxlineClient } from "@txline-kit/client";
import { epochDayFromTs } from "@txline-kit/client/proofs";
import { STAT } from "@txline-kit/constants";
import {
  dailyScoresRootsPda, marketPda, outcomeFromStats, settleArgsFromProof,
  TXORACLE_PROGRAM_ID, vaultPda, type MarketKindArg,
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
  const proof = (await api.statValidation({
    fixtureId,
    seq: finalSeq,
    statKeys: [STAT.T1_GOALS, STAT.T2_GOALS],
  })) as ScoresStatValidationV2;
  const roots = dailyScoresRootsPda(epochDayFromTs(proof.summary.updateStats.minTimestamp));
  const settlerToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const results: SettleResult[] = [];

  for (const kind of kinds) {
    const pda = marketPda(program.programId, fixtureId, kind);
    const info = await program.provider.connection.getAccountInfo(pda);
    if (!info) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = await (program.account as any).market.fetch(pda);
    if (!("open" in state.state)) continue;

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
    results.push({
      market: pda.toBase58(),
      kindLabel: "winnerDrawLoser" in kind ? "1X2" : `O/U ${kind.totalGoalsOverUnder.lineX2 / 2}`,
      outcome,
      sig,
    });
  }
  return results;
}
