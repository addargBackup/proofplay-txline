import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { faucetTo } from "@/lib/server";

/** Devnet demo faucet: sends 500 pUSDC (worthless demo tokens) to the caller. */
export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    const sig = await faucetTo(new PublicKey(wallet), 500);
    return NextResponse.json({ sig, amount: 500 });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 400 });
  }
}
