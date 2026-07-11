import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildSettleTx } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const { market, settler } = await req.json();
    const tx = await buildSettleTx(new PublicKey(market), new PublicKey(settler));
    return NextResponse.json({ tx });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
