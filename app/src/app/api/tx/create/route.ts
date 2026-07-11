import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildCreateMarketTx, fixturesById, KIND_WDL, kindOverUnder } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const { fixtureId, kind, lineX2, creator } = await req.json();
    const fixtures = await fixturesById();
    const f = fixtures.get(Number(fixtureId));
    if (!f) throw new Error(`unknown fixture ${fixtureId}`);
    const k = kind === "wdl" ? KIND_WDL : kindOverUnder(Number(lineX2));
    if (kind === "ou" && !(Number(lineX2) % 2 === 1 && Number(lineX2) < 40)) {
      throw new Error("line must be a half line (odd lineX2), e.g. 5 for 2.5 goals");
    }
    const out = await buildCreateMarketTx(Number(fixtureId), f.StartTime, k, 50, new PublicKey(creator));
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
