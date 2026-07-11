import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildClaimTx } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const { market, claimer } = await req.json();
    const tx = await buildClaimTx(new PublicKey(market), new PublicKey(claimer));
    return NextResponse.json({ tx });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
