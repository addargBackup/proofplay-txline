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

export default function CreateMarket() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const router = useRouter();
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [fixtureId, setFixtureId] = useState<number | null>(null);
  const [kind, setKind] = useState<"wdl" | "ou">("wdl");
  const [line, setLine] = useState("2.5");
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
  const lineValid = lineX2 % 2 === 1 && lineX2 > 0 && lineX2 < 40;

  // The settlement contract, shown to the creator BEFORE deploying — this is
  // the "market language" made visible: outcome -> predicate over TxLINE keys.
  const spec = useMemo(() => {
    if (kind === "wdl") {
      return [
        { outcome: f ? f.home : "Home", rule: "goals(statKey 1) − goals(statKey 2) > 0" },
        { outcome: "Draw", rule: "goals(statKey 1) − goals(statKey 2) = 0" },
        { outcome: f ? f.away : "Away", rule: "goals(statKey 1) − goals(statKey 2) < 0" },
      ];
    }
    const l = lineX2;
    return [
      { outcome: `Over ${l / 2}`, rule: `goals(1) + goals(2) > ${(l - 1) / 2}` },
      { outcome: `Under ${l / 2}`, rule: `goals(1) + goals(2) < ${(l + 1) / 2}` },
    ];
  }, [kind, lineX2, f]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Create a market</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Markets are data, not promises: the settlement rule you pick here is stored on-chain and can
          only be satisfied by a TxLINE Merkle proof of the final stats. You never resolve it. Nobody does.
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

        <div className="flex gap-2">
          <button className={kind === "wdl" ? "btn-green" : "btn-outline"} onClick={() => setKind("wdl")}>
            Match result (1X2)
          </button>
          <button className={kind === "ou" ? "btn-green" : "btn-outline"} onClick={() => setKind("ou")}>
            Total goals O/U
          </button>
          {kind === "ou" && (
            <input
              className="w-20 rounded border border-line bg-pitch px-2 mono"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder="2.5"
            />
          )}
        </div>
        {kind === "ou" && !lineValid && (
          <div className="text-xs text-yellow-400">Line must be a half line (0.5, 1.5, 2.5 …) so no result can push.</div>
        )}

        {/* Live predicate preview */}
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
            statKey 1 = home goals, statKey 2 = away goals · 90-minute result · proofs accepted only from
            the finalised record (period = 100) · unsettled after 72h → everyone refunded
          </div>
        </div>

        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          className="btn-green w-full"
          disabled={busy || !wallet.publicKey || !fixtureId || (kind === "ou" && !lineValid)}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const { tx, market } = await postJson<{ tx: string; market: string }>("/api/tx/create", {
                fixtureId, kind, lineX2, creator: wallet.publicKey!.toBase58(),
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
