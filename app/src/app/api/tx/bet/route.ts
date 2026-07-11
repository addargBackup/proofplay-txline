import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildBetTx } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const { market, bettor, outcome, amount } = await req.json();
    if (!(amount > 0 && amount <= 10_000)) throw new Error("amount must be 0-10000 pUSDC");
    const tx = await buildBetTx(new PublicKey(market), new PublicKey(bettor), Number(outcome), Number(amount));
    return NextResponse.json({ tx });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
