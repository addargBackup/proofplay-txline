"use client";
import { explorer, type MarketView } from "@/lib/client";

/** The settlement receipt: on-chain evidence that a Merkle proof — not an
 *  admin — decided this market. Every value here is read from the chain. */
export function Receipt({
  market: m,
  labels,
  settleTx,
  score,
}: {
  market: MarketView;
  labels: string[];
  settleTx: string | null;
  score: { home: number; away: number } | null;
}) {
  const r = m.receipt!;
  return (
    <div className="card border-grass/40">
      <h2 className="font-semibold text-grass">Settlement receipt — “settled by proof, not by us”</h2>
      <p className="mt-1 text-sm text-neutral-300">
        Outcome <span className="font-semibold text-neutral-100">“{labels[m.outcome!]}”</span>
        {score && (
          <>
            {" "}(final score {score.home}–{score.away})
          </>
        )}{" "}
        was proven with a TxLINE Merkle proof and verified on-chain by the txoracle program via CPI.
        A false outcome cannot pass this check; a mid-match score cannot either (finality period guard).
      </p>

      {/* Merkle path visualization */}
      <div className="mt-4 space-y-1 text-sm">
        <PathNode label="final stats" value={`home goals + away goals (statKeys 1, 2 · period 100 = finalised)`} />
        <Arrow />
        <PathNode label="event-stat root" value={r.eventStatRoot} mono />
        <Arrow />
        <PathNode
          label="daily scores Merkle root (on-chain PDA)"
          value={r.dailyRootsPda}
          mono
          href={explorer(r.dailyRootsPda, "address")}
        />
      </div>

      <div className="mt-4 grid gap-2 text-xs text-neutral-400 sm:grid-cols-2">
        <div>
          proof batch timestamp:{" "}
          <span className="mono text-neutral-300">{new Date(r.minTimestamp).toISOString()}</span>
        </div>
        <div>
          settler (earned {(m.bountyBps / 100).toFixed(1)}% bounty):{" "}
          <a className="mono underline" href={explorer(r.settler, "address")} target="_blank">
            {r.settler.slice(0, 8)}…{r.settler.slice(-6)} ↗
          </a>
        </div>
        {settleTx && (
          <div>
            settlement transaction:{" "}
            <a className="mono underline" href={explorer(settleTx)} target="_blank">
              {settleTx.slice(0, 16)}… ↗
            </a>
          </div>
        )}
        <div>
          verifier program:{" "}
          <a
            className="mono underline"
            href={explorer("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J", "address")}
            target="_blank"
          >
            txoracle (TxLINE) ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function PathNode({ label, value, mono, href }: { label: string; value: string; mono?: boolean; href?: string }) {
  const inner = (
    <div className="rounded-lg border border-line bg-pitch px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`${mono ? "mono" : ""} break-all text-neutral-200`}>{value}</div>
    </div>
  );
  return href ? (
    <a href={href} target="_blank" className="block transition hover:border-grass">
      {inner}
    </a>
  ) : (
    inner
  );
}

function Arrow() {
  return <div className="pl-4 text-neutral-600">↓ Merkle proof</div>;
}
