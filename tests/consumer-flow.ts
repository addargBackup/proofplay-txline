/** Headless consumer-flow smoke: drives the SAME HTTP routes the web app's
 *  wallet flow uses — faucet -> unsigned bet tx -> local sign -> devnet ->
 *  position visible -> settle-route error hygiene on an unfinished match.
 *  Run (app on :3040 + funded keeper wallet):  pnpm tsx tests/consumer-flow.ts */
import assert from "node:assert";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { connection, loadWallet } from "../keeper/src/common.js";

const APP = process.env.APP_URL ?? "http://127.0.0.1:3040";
const conn = connection();
const keeper = loadWallet();
const judge = Keypair.generate();
const step = (s: string) => console.log(`\n=== ${s}`);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APP}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.error}`);
  return data as T;
}

step("fund judge wallet with fee SOL");
await anchor.web3.sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: judge.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
), [keeper], { commitment: "confirmed" });

step("faucet route: +500 pUSDC");
const faucet = await api<{ sig: string; amount: number }>("/api/faucet", { wallet: judge.publicKey.toBase58() });
assert(faucet.amount === 500, "faucet should send 500");
console.log("faucet tx:", faucet.sig.slice(0, 20) + "…");

step("find an OPEN market with a future kickoff");
const { markets } = await api<{ markets: Array<{ address: string; state: string; kickoffTs: number; fixture: { home: string; away: string } | null; pools: number[] }> }>("/api/markets");
const open = markets.find((m) => m.state === "open" && m.kickoffTs > Date.now() + 60_000);
assert(open, "no open future market — run the keeper bootstrap first");
console.log(`market: ${open!.fixture?.home} vs ${open!.fixture?.away} (${open!.address.slice(0, 8)}…)`);

step("bet route -> unsigned tx -> local sign -> devnet");
const { tx: b64 } = await api<{ tx: string }>("/api/tx/bet", {
  market: open!.address, bettor: judge.publicKey.toBase58(), outcome: 0, amount: 25,
});
const tx = Transaction.from(Buffer.from(b64, "base64"));
tx.partialSign(judge);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, "confirmed");
console.log("bet landed:", sig.slice(0, 20) + "…");

step("position visible via market route");
const detail = await api<{ position: { outcome: number; amount: number } | null; market: { pools: number[] } }>(
  `/api/market/${open!.address}?wallet=${judge.publicKey.toBase58()}`);
assert(detail.position?.outcome === 0 && detail.position.amount === 25, `position mismatch: ${JSON.stringify(detail.position)}`);
console.log("position:", detail.position, "pools:", detail.market.pools);

step("settle route on an UNFINISHED match -> clean 400, no crash");
try {
  await api("/api/tx/settle", { market: open!.address, settler: judge.publicKey.toBase58() });
  throw new Error("settle should have been rejected");
} catch (e) {
  assert(String(e).includes("400"), `expected 400, got ${String(e).slice(0, 120)}`);
  console.log("rejected cleanly:", String(e).slice(0, 100));
}

console.log("\nCONSUMER FLOW PASSED ✅ — faucet, bet-build/sign/send, position read, settle hygiene");
process.exit(0);
