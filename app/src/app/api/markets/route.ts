import { NextResponse } from "next/server";
import { accounts, fixturesById, marketToJson } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [marketAccounts, fixtures] = await Promise.all([accounts.market.all(), fixturesById()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markets = marketAccounts.map((a: any) => {
      const m = marketToJson(a.publicKey, a.account);
      const f = fixtures.get(m.fixtureId);
      return {
        ...m,
        fixture: f
          ? { home: f.Participant1, away: f.Participant2, startTime: f.StartTime, competition: f.Competition }
          : null,
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markets.sort((a: any, b: any) => (a.fixture?.startTime ?? a.kickoffTs) - (b.fixture?.startTime ?? b.kickoffTs));
    return NextResponse.json({ markets });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
