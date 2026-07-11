"use client";
import { Connection, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export interface FixtureMeta {
  home: string;
  away: string;
  startTime: number;
  competition: string;
}

export type MarketKindView =
  | { type: "wdl" }
  | { type: "ou"; lineX2: number }
  | { type: "statOu"; statKey: number; lineX2: number }
  | { type: "sumOu"; keyA: number; keyB: number; lineX2: number };

export interface MarketView {
  address: string;
  fixtureId: number;
  kickoffTs: number;
  kind: MarketKindView;
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

const STAT_BASE_NAMES: Record<number, [string, string]> = {
  1: ["goals", "home"], 2: ["goals", "away"],
  3: ["yellow cards", "home"], 4: ["yellow cards", "away"],
  5: ["red cards", "home"], 6: ["red cards", "away"],
  7: ["corners", "home"], 8: ["corners", "away"],
};
const PERIOD_NAMES: Record<number, string> = {
  0: "", 1000: "H1 ", 2000: "HT ", 3000: "H2 ", 4000: "ET1 ", 5000: "ET2 ", 6000: "pens ", 7000: "ET ",
};

/** "3007" -> "H2 home corners" — human name for a composed TxLINE stat key. */
export function statKeyName(key: number, fixture?: FixtureMeta | null): string {
  const base = key % 1000;
  const period = key - base;
  const [metric, side] = STAT_BASE_NAMES[base] ?? ["stat " + base, ""];
  const team = side === "home" ? fixture?.home ?? "home" : fixture?.away ?? "away";
  return `${PERIOD_NAMES[period] ?? ""}${team} ${metric}`;
}

export function outcomeLabels(m: MarketView): string[] {
  if (m.kind.type === "wdl") {
    return [m.fixture?.home ?? "Home", "Draw", m.fixture?.away ?? "Away"];
  }
  const line = m.kind.lineX2 / 2;
  return [`Over ${line}`, `Under ${line}`];
}

export function kindLabel(m: MarketView): string {
  switch (m.kind.type) {
    case "wdl":
      return "Match result (90 min)";
    case "ou":
      return `Total goals O/U ${m.kind.lineX2 / 2}`;
    case "statOu":
      return `${statKeyName(m.kind.statKey, m.fixture)} O/U ${m.kind.lineX2 / 2}`;
    case "sumOu": {
      const baseA = m.kind.keyA % 1000;
      const metric = STAT_BASE_NAMES[baseA]?.[0] ?? "stats";
      const period = PERIOD_NAMES[m.kind.keyA - baseA] ?? "";
      return `${period}Total ${metric} O/U ${m.kind.lineX2 / 2}`;
    }
  }
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
