import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCreateMarketTx, fixturesById, parseKind } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const { fixtureId, kind, creator } = await req.json();
    const fixtures = await fixturesById();
    const f = fixtures.get(Number(fixtureId));
    if (!f) throw new Error(`unknown fixture ${fixtureId}`);
    const k = parseKind(kind); // validates half lines + stat keys
    const out = await buildCreateMarketTx(Number(fixtureId), f.StartTime, k, 50, new PublicKey(creator));
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
