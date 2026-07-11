"use client";
import { Connection, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export interface FixtureMeta {
  home: string;
  away: string;
  startTime: number;
  competition: string;
}

export interface MarketView {
  address: string;
  fixtureId: number;
  kickoffTs: number;
  kind: { type: "wdl" } | { type: "ou"; lineX2: number };
  state: "open" | "settled" | "voided";
  outcome: number | null;
  numOutcomes: number;
  pools: number[];
  totalPool: number;
  bountyBps: number;
  receipt: {
    eventStatRoot: string;
    minTimestamp: number;
    settler: string;
    dailyRootsPda: string;
  } | null;
  fixture: FixtureMeta | null;
}

export function outcomeLabels(m: MarketView): string[] {
  if (m.kind.type === "wdl") {
    return [m.fixture?.home ?? "Home", "Draw", m.fixture?.away ?? "Away"];
  }
  const line = m.kind.lineX2 / 2;
  return [`Over ${line}`, `Under ${line}`];
}

export function kindLabel(m: MarketView): string {
  return m.kind.type === "wdl" ? "Match result (90 min)" : `Total goals O/U ${m.kind.lineX2 / 2}`;
}

/** Parimutuel payout multiplier for one outcome at current pools. */
export function multiplier(m: MarketView, i: number): number | null {
  const distributable = m.totalPool * (1 - m.bountyBps / 10_000);
  if (!m.pools[i]) return null;
  return distributable / m.pools[i];
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Sign + send a server-built base64 transaction with the connected wallet. */
export async function sendServerTx(
  wallet: WalletContextState,
  connection: Connection,
  txBase64: string,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("connect a wallet first");
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export const explorer = (sigOrAddr: string, type: "tx" | "address" = "tx") =>
  `https://explorer.solana.com/${type === "tx" ? "tx" : "address"}/${sigOrAddr}?cluster=devnet`;

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const fmtUsd = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
