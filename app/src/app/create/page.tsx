"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fmtTime, postJson, sendServerTx } from "@/lib/client";

interface FixtureRow {
  fixtureId: number;
  home: string;
  away: string;
  startTime: number;
  competition: string;
}

const METRICS = [
  { label: "Goals", bases: [1, 2] },
  { label: "Corners", bases: [7, 8] },
  { label: "Yellow cards", bases: [3, 4] },
  { label: "Red cards", bases: [5, 6] },
] as const;
const PERIODS = [
  { label: "Full match", prefix: 0 },
  { label: "1st half", prefix: 1000 },
  { label: "2nd half", prefix: 3000 },
] as const;
const SCOPES = ["Both teams", "Home only", "Away only"] as const;

export default function CreateMarket() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const router = useRouter();
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [fixtureId, setFixtureId] = useState<number | null>(null);
  const [mode, setMode] = useState<"wdl" | "ou" | "prop">("wdl");
  const [line, setLine] = useState("2.5");
  const [metric, setMetric] = useState(1); // index into METRICS
  const [scope, setScope] = useState(0); // index into SCOPES
  const [period, setPeriod] = useState(0); // index into PERIODS
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/fixtures")
      .then((r) => r.json())
      .then((d) => {
        setFixtures(d.fixtures ?? []);
        if (d.fixtures?.[0]) setFixtureId(d.fixtures[0].fixtureId);
      });
  }, []);

  const f = fixtures.find((x) => x.fixtureId === fixtureId);
  const lineX2 = Math.round(parseFloat(line || "0") * 2);
  const lineValid = lineX2 % 2 === 1 && lineX2 > 0 && lineX2 < 100;

  // Compose the on-chain kind + its human-readable settlement contract.
  const { kind, spec } = useMemo(() => {
    const home = f?.home ?? "Home";
    const away = f?.away ?? "Away";
    if (mode === "wdl") {
      return {
        kind: { winnerDrawLoser: {} },
        spec: [
          { outcome: home, rule: "goals(key 1) − goals(key 2) > 0" },
          { outcome: "Draw", rule: "goals(key 1) − goals(key 2) = 0" },
          { outcome: away, rule: "goals(key 1) − goals(key 2) < 0" },
        ],
      };
    }
    if (mode === "ou") {
      return {
        kind: { totalGoalsOverUnder: { lineX2 } },
        spec: [
          { outcome: `Over ${lineX2 / 2}`, rule: `goals(1) + goals(2) > ${(lineX2 - 1) / 2}` },
          { outcome: `Under ${lineX2 / 2}`, rule: `goals(1) + goals(2) < ${(lineX2 + 1) / 2}` },
        ],
      };
    }
    // Custom prop: metric × scope × period × line -> stat keys
    const m = METRICS[metric];
    const prefix = PERIODS[period].prefix;
    const keyHome = prefix + m.bases[0];
    const keyAway = prefix + m.bases[1];
    const name = m.label.toLowerCase();
    const per = PERIODS[period].label;
    if (scope === 0) {
      return {
        kind: { twoStatSumOverUnder: { keyA: keyHome, keyB: keyAway, lineX2 } },
        spec: [
          { outcome: `Over ${lineX2 / 2}`, rule: `${name}(key ${keyHome}) + ${name}(key ${keyAway}) > ${(lineX2 - 1) / 2}  · ${per}` },
          { outcome: `Under ${lineX2 / 2}`, rule: `${name}(key ${keyHome}) + ${name}(key ${keyAway}) < ${(lineX2 + 1) / 2}  · ${per}` },
        ],
      };
    }
    const key = scope === 1 ? keyHome : keyAway;
    const team = scope === 1 ? home : away;
    return {
      kind: { statOverUnder: { statKey: key, lineX2 } },
      spec: [
        { outcome: `Over ${lineX2 / 2}`, rule: `${team} ${name}(key ${key}) > ${(lineX2 - 1) / 2}  · ${per}` },
        { outcome: `Under ${lineX2 / 2}`, rule: `${team} ${name}(key ${key}) < ${(lineX2 + 1) / 2}  · ${per}` },
      ],
    };
  }, [mode, lineX2, f, metric, scope, period]);

  const needsLine = mode !== "wdl";

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Create a market</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Markets are data, not promises: the settlement rule you compose here is stored on-chain and
          can only be satisfied by a TxLINE Merkle proof of the final stats. You never resolve it. Nobody does.
        </p>
      </div>

      <div className="card space-y-4">
        <label className="block text-sm">
          <span className="text-neutral-400">Fixture</span>
          <select
            className="mt-1 w-full rounded border border-line bg-pitch px-2 py-2"
            value={fixtureId ?? ""}
            onChange={(e) => setFixtureId(Number(e.target.value))}
          >
            {fixtures.map((x) => (
              <option key={x.fixtureId} value={x.fixtureId}>
                {x.home} vs {x.away} — {fmtTime(x.startTime)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-2">
          <button className={mode === "wdl" ? "btn-green" : "btn-outline"} onClick={() => setMode("wdl")}>
            Match result (1X2)
          </button>
          <button className={mode === "ou" ? "btn-green" : "btn-outline"} onClick={() => { setMode("ou"); setLine("2.5"); }}>
            Total goals O/U
          </button>
          <button className={mode === "prop" ? "btn-green" : "btn-outline"} onClick={() => { setMode("prop"); setMetric(1); setLine("9.5"); }}>
            Custom prop
          </button>
        </div>

        {mode === "prop" && (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-neutral-400">Stat</span>
              <select className="mt-1 w-full rounded border border-line bg-pitch px-2 py-2" value={metric} onChange={(e) => setMetric(Number(e.target.value))}>
                {METRICS.map((m, i) => <option key={m.label} value={i}>{m.label}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-neutral-400">Scope</span>
              <select className="mt-1 w-full rounded border border-line bg-pitch px-2 py-2" value={scope} onChange={(e) => setScope(Number(e.target.value))}>
                {SCOPES.map((s, i) => <option key={s} value={i}>{s === "Home only" ? f?.home ?? s : s === "Away only" ? f?.away ?? s : s}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-neutral-400">Period</span>
              <select className="mt-1 w-full rounded border border-line bg-pitch px-2 py-2" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                {PERIODS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            </label>
          </div>
        )}

        {needsLine && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-neutral-400">Line</span>
            <input
              className="w-24 rounded border border-line bg-pitch px-2 py-1 mono"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder="2.5"
            />
            {!lineValid && <span className="text-xs text-yellow-400">half lines only (0.5, 1.5, 9.5 …) so no result can push</span>}
          </div>
        )}

        {/* Live predicate preview — the market language made visible */}
        <div className="rounded-lg border border-line bg-pitch p-3">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">
            On-chain settlement contract (TxLINE stat-key language)
          </div>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {spec.map((row) => (
                <tr key={row.outcome} className="border-t border-line/50">
                  <td className="py-1 pr-3 font-medium">{row.outcome}</td>
                  <td className="mono py-1 text-neutral-400">{row.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-xs text-neutral-500">
            stat keys = TxLINE base (1-8) + period prefix (1000=H1, 3000=H2) · proofs accepted only from
            the finalised record (period = 100) · unsettled after 72h → everyone refunded
          </div>
        </div>

        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          className="btn-green w-full"
          disabled={busy || !wallet.publicKey || !fixtureId || (needsLine && !lineValid)}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const { tx, market } = await postJson<{ tx: string; market: string }>("/api/tx/create", {
                fixtureId, kind, creator: wallet.publicKey!.toBase58(),
              });
              await sendServerTx(wallet, connection, tx);
              router.push(`/market/${market}`);
            } catch (e) {
              setErr(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "confirm in wallet…" : wallet.publicKey ? "Deploy market" : "Connect a wallet to deploy"}
        </button>
      </div>
    </div>
  );
}
