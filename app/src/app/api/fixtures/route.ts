import { NextResponse } from "next/server";
import { fixturesById } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Upcoming fixtures (for the market builder). */
export async function GET() {
  try {
    const fixtures = [...(await fixturesById()).values()]
      .filter((f) => f.StartTime > Date.now() + 10 * 60_000)
      .sort((a, b) => a.StartTime - b.StartTime)
      .map((f) => ({
        fixtureId: f.FixtureId,
        home: f.Participant1,
        away: f.Participant2,
        startTime: f.StartTime,
        competition: f.Competition,
      }));
    return NextResponse.json({ fixtures });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
