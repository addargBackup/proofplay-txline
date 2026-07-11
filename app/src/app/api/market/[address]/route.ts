import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { accounts, conn, fixturesById, marketToJson, positionPda, txline } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { address: string } }) {
  try {
    const address = new PublicKey(params.address);
    const account = await accounts.market.fetch(address);
    const m = marketToJson(address, account);
    const fixtures = await fixturesById();
    const f = fixtures.get(m.fixtureId);

    // Live score (works in-play and just after; ignore errors quietly).
    let score: { home: number; away: number; statusId: number | null } | null = null;
    try {
      const snap = await txline().scoresSnapshot(m.fixtureId);
      if (snap?.Stats) {
        score = {
          home: snap.Stats["1"] ?? 0,
          away: snap.Stats["2"] ?? 0,
          statusId: (snap.StatusId as number) ?? null,
        };
      }
    } catch {
      /* pre-match or outside window */
    }

    // Caller's position, if a wallet was supplied.
    const wallet = req.nextUrl.searchParams.get("wallet");
    let position: { outcome: number; amount: number; claimed: boolean } | null = null;
    if (wallet) {
      try {
        const p = await accounts.position.fetch(positionPda(address, new PublicKey(wallet)));
        position = { outcome: p.outcome as number, amount: Number(p.amount) / 1e6, claimed: p.claimed as boolean };
      } catch {
        /* no position */
      }
    }

    // Settlement transaction signature (for the receipt's explorer link).
    let settleTx: string | null = null;
    if (m.state === "settled") {
      const sigs = await conn.getSignaturesForAddress(address, { limit: 25 });
      settleTx = sigs.find((s) => !s.err)?.signature ?? null;
    }

    return NextResponse.json({
      market: {
        ...m,
        fixture: f
          ? { home: f.Participant1, away: f.Participant2, startTime: f.StartTime, competition: f.Competition }
          : null,
      },
      score,
      position,
      settleTx,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
