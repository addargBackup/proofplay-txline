"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  explorer, fmtTime, fmtUsd, kindLabel, multiplier, outcomeLabels,
  postJson, sendServerTx, type MarketView,
} from "@/lib/client";
import { Receipt } from "@/components/Receipt";

interface Detail {
  market: MarketView;
  score: { home: number; away: number; statusId: number | null } | null;
  position: { outcome: number; amount: number; claimed: boolean } | null;
  settleTx: string | null;
}

export default function MarketPage() {
  const { address } = useParams<{ address: string }>();
  const wallet = useWallet();
  const { connection } = useConnection();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("25");
  const [lastSig, setLastSig] = useState<string | null>(null);

  const load = useCallback(() => {
    const q = wallet.publicKey ? `?wallet=${wallet.publicKey.toBase58()}` : "";
    fetch(`/api/market/${address}${q}`)
      .then((r) => r.json())
      .then((data) => (data.error ? setError(data.error) : (setD(data), setError(null))))
      .catch((e) => setError(String(e)));
  }, [address, wallet.publicKey]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="card border-red-900 text-red-300">Error: {error}</div>;
  if (!d) return <div className="text-neutral-400">Loading market…</div>;

  const m = d.market;
  const labels = outcomeLabels(m);
  const locked = Date.now() > m.kickoffTs;
  const finished = d.score?.statusId === 100 || d.score?.statusId === 5;

  const act = async (name: string, url: string, body: Record<string, unknown>) => {
    setBusy(name);
    try {
      const { tx } = await postJson<{ tx: string }>(url, body);
      const sig = await sendServerTx(wallet, connection, tx);
      setLastSig(sig);
      load();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">
              {m.fixture ? `${m.fixture.home} vs ${m.fixture.away}` : `Fixture ${m.fixtureId}`}
            </h1>
            <div className="mt-1 text-sm text-neutral-400">
              {kindLabel(m)} · kickoff {fmtTime(m.kickoffTs)} ·{" "}
              <a className="underline" href={explorer(m.address, "address")} target="_blank">
                market account ↗
              </a>
            </div>
          </div>
          {d.score && (
            <div className="text-2xl font-bold">
              {d.score.home}<span className="text-neutral-500">–</span>{d.score.away}
              <span className="ml-2 text-xs font-normal text-neutral-400">
                {d.score.statusId === 100 ? "final" : d.score.statusId === 5 ? "FT" : "live"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Outcomes: pool share · parimutuel multiplier */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Pools — {fmtUsd(m.totalPool)} pUSDC total</h2>
          <span className="text-xs text-neutral-500">
            {m.state === "open" ? (locked ? "locked at kickoff — awaiting settlement proof" : "open for bets") : m.state}
          </span>
        </div>
        <div className={`grid gap-3 ${m.numOutcomes === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {labels.map((label, i) => {
            const share = m.totalPool ? (m.pools[i] / m.totalPool) * 100 : 0;
            const won = m.state === "settled" && m.outcome === i;
            return (
              <div key={i} className={`rounded-lg border p-3 ${won ? "border-grass bg-grass/10" : "border-line"}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{label}</span>
                  {won && <span className="text-xs text-grass">winner ✓</span>}
                </div>
                <div className="mt-1 text-sm text-neutral-300">
                  {fmtUsd(m.pools[i])} pUSDC · {share.toFixed(0)}% of pool
                </div>
                <div className="text-xs text-neutral-500">
                  pays {multiplier(m, i) ? `${multiplier(m, i)!.toFixed(2)}x` : "— (no backers yet)"}
                </div>
                {m.state === "open" && !locked && (
                  <button
                    className="btn-green mt-2 w-full"
                    disabled={busy !== null || !wallet.publicKey}
                    onClick={() =>
                      act(`bet${i}`, "/api/tx/bet", {
                        market: m.address,
                        bettor: wallet.publicKey!.toBase58(),
                        outcome: i,
                        amount: Number(amount),
                      })
                    }
                  >
                    {busy === `bet${i}` ? "confirm in wallet…" : `Back ${label}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {m.state === "open" && !locked && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-neutral-400">Stake</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 rounded border border-line bg-pitch px-2 py-1 mono"
              inputMode="decimal"
            />
            <span className="text-neutral-400">pUSDC {!wallet.publicKey && "· connect a wallet to bet"}</span>
          </div>
        )}
      </div>

      {/* Position + claim */}
      {d.position && (
        <div className="card">
          <h2 className="font-semibold">Your position</h2>
          <div className="mt-1 text-sm text-neutral-300">
            {fmtUsd(d.position.amount)} pUSDC on “{labels[d.position.outcome]}”
            {d.position.claimed && " · claimed ✓"}
          </div>
          {(m.state === "settled" || m.state === "voided") && !d.position.claimed && (
            <button
              className="btn-green mt-2"
              disabled={busy !== null}
              onClick={() => act("claim", "/api/tx/claim", { market: m.address, claimer: wallet.publicKey!.toBase58() })}
            >
              {busy === "claim"
                ? "confirm in wallet…"
                : m.state === "voided" || m.outcome === d.position.outcome
                  ? "Claim payout"
                  : "Claim (will fail — you lost, this is on-chain honesty)"}
            </button>
          )}
        </div>
      )}

      {/* Permissionless settle */}
      {m.state === "open" && finished && (
        <div className="card border-gold/40">
          <h2 className="font-semibold text-gold">Match finished — settle it yourself</h2>
          <p className="mt-1 text-sm text-neutral-300">
            Anyone can settle this market by submitting TxLINE&apos;s Merkle proof of the final score.
            The settler earns {(m.bountyBps / 100).toFixed(1)}% of the pool. Your wallet signs the
            settlement transaction; the proof is fetched from TxLINE and verified on-chain by txoracle.
          </p>
          <button
            className="btn-green mt-2"
            disabled={busy !== null || !wallet.publicKey}
            onClick={() => act("settle", "/api/tx/settle", { market: m.address, settler: wallet.publicKey!.toBase58() })}
          >
            {busy === "settle" ? "building proof + confirm in wallet…" : "Settle with proof (earn bounty)"}
          </button>
        </div>
      )}

      {/* Receipt */}
      {m.state === "settled" && m.receipt && (
        <Receipt market={m} labels={labels} settleTx={d.settleTx} score={d.score} />
      )}

      {lastSig && (
        <div className="text-xs text-neutral-400">
          last tx:{" "}
          <a className="mono underline" href={explorer(lastSig)} target="_blank">
            {lastSig.slice(0, 20)}… ↗
          </a>
        </div>
      )}
    </div>
  );
}
