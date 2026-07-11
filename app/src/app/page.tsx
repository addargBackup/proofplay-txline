"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtTime, fmtUsd, kindLabel, multiplier, outcomeLabels, type MarketView } from "@/lib/client";

function StateBadge({ m }: { m: MarketView }) {
  if (m.state === "settled")
    return <span className="rounded bg-grass/20 px-2 py-0.5 text-xs text-grass">settled by proof ✓</span>;
  if (m.state === "voided")
    return <span className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">voided · refunds open</span>;
  if (Date.now() > m.kickoffTs)
    return <span className="rounded bg-orange-500/20 px-2 py-0.5 text-xs text-orange-300">locked · awaiting proof</span>;
  return <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300">open</span>;
}

export default function Home() {
  const [markets, setMarkets] = useState<MarketView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/markets")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          if (d.error) setError(d.error);
          else setMarkets(d.markets);
        })
        .catch((e) => alive && setError(String(e)));
    load();
    const t = setInterval(load, 12_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const byFixture = new Map<number, MarketView[]>();
  for (const m of markets ?? []) {
    byFixture.set(m.fixtureId, [...(byFixture.get(m.fixtureId) ?? []), m]);
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">World Cup 2026 — trustless markets</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Parimutuel pools settled on-chain by TxLINE Merkle proofs. Anyone can create a market,
          anyone can settle one with a valid proof — <span className="text-neutral-200">nobody can lie</span>.
        </p>
      </div>

      {error && <div className="card border-red-900 text-sm text-red-300">API error: {error}</div>}
      {!markets && !error && <div className="text-neutral-400">Loading markets…</div>}
      {markets?.length === 0 && (
        <div className="card text-sm text-neutral-300">
          No markets yet. Run the keeper (<span className="mono">pnpm keeper</span>) or{" "}
          <Link href="/create" className="text-grass underline">create one</Link>.
        </div>
      )}

      <div className="space-y-4">
        {[...byFixture.entries()].map(([fixtureId, group]) => {
          const f = group[0].fixture;
          return (
            <div key={fixtureId} className="card">
              <div className="mb-3 flex items-baseline justify-between">
                <div>
                  <span className="text-base font-semibold">
                    {f ? `${f.home} vs ${f.away}` : `Fixture ${fixtureId}`}
                  </span>
                  <span className="ml-3 text-xs text-neutral-400">
                    {f ? fmtTime(f.startTime) : ""} · fixture {fixtureId}
                  </span>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.map((m) => (
                  <Link
                    key={m.address}
                    href={`/market/${m.address}`}
                    className="rounded-lg border border-line p-3 transition hover:border-grass"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{kindLabel(m)}</span>
                      <StateBadge m={m} />
                    </div>
                    <div className="mt-2 flex gap-3 text-xs text-neutral-300">
                      {outcomeLabels(m).map((label, i) => (
                        <span key={i} className={m.state === "settled" && m.outcome === i ? "text-grass" : ""}>
                          {label}{" "}
                          <span className="text-neutral-500">
                            {multiplier(m, i) ? `${multiplier(m, i)!.toFixed(2)}x` : "—"}
                          </span>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-neutral-500">pool {fmtUsd(m.totalPool)} pUSDC</div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
