# ProofPlay

**Permissionless parimutuel prediction markets for the 2026 World Cup, settled
trustlessly by TxLINE Merkle proofs on Solana devnet.**

No admin resolves markets. Anyone can create a market, anyone can join its USDC
pool, and anyone holding TxLINE's cryptographic proof of the final score can
settle it (and earn a bounty for doing so). The program CPIs into TxLINE's
`txoracle` program to verify the proof against the on-chain daily Merkle root —
the market maker cannot lie, and neither can the settler.

**📄 [Full technical documentation](docs/README.md)** — how every fact in this
app traces back to TxLINE, core idea, technical/business highlights, endpoints
used, and the judge runbook.

- Program (devnet): `DDLwN6s1mswd7wiXFHy76eTahw4VYPAUrvEHZNdcHaRw`
- Oracle: TxLINE `txoracle` (devnet) `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Data: [TxLINE](https://txline.txodds.com) World Cup feeds via the vendored
  [`txline-kit`](packages/txline-kit) SDK (free devnet tier, 0s delay)

## The market language

A market is data: a `MarketKind` stored on-chain whose settlement predicate the
program reconstructs at settle time. Four kinds ship, spanning the whole
TxLINE team-level stat vocabulary (8 base stats × 8 period prefixes × any
half line):

| Kind | Example | Proof keys |
|---|---|---|
| `WinnerDrawLoser` | 1X2, 90-minute result | goals 1, 2 (Subtract vs 0) |
| `TotalGoalsOverUnder{line_x2}` | total goals O/U 2.5 | goals 1+2 (Add vs line) |
| `StatOverUnder{stat_key,line_x2}` | "H2 home corners O/U 5.5" = key **3007** | any single composed key |
| `TwoStatSumOverUnder{key_a,key_b,line_x2}` | **"Team A corners + Team B corners > 10"** (the track's parametric example) = keys 7+8 | any pair (Add vs line) |

The builder UI composes these (stat × scope × period × line) and previews the
exact on-chain rule before deploying. All four are covered by the devnet test
suite, including a corners prop settled with a keys-7+8 Merkle proof.

## Why this can't cheat (the soundness story)

1. **The settler picks WHICH outcome to prove; the program builds the predicate.**
   `settle(claimed_outcome, proof)` reconstructs the txoracle predicate from the
   on-chain market spec — e.g. WinnerDrawLoser outcome 0 becomes
   `(home_goals − away_goals) > 0` over TxLINE stat keys 1 and 2. A false claim
   simply fails CPI validation (test-verified).
2. **Mid-match scores cannot settle a market.** TxLINE stats prove with
   `period == phase_id` during play and `period == 100` only in the
   `game_finalised` record. The program requires `period == 100`
   (live-verified: a real mid-match proof at 1-0 was rejected while the real
   final 2-1 proof settled).
3. **Abandoned matches refund without permission.** Any market unsettled 72h
   after kickoff can be voided by anyone; stakes reclaim pro-rata.
4. **Payouts are arithmetic.** Winner payout = stake × (pool − bounty) / winning
   side. No pricing model, no oracle of oracles, no discretion.

## Layout
- `programs/proofplay/` — the Anchor program (market/position accounts,
  `create_market`, `bet`, `settle` w/ CPI, `void_market`, `claim`)
- `keeper/` — autonomous service: creates 1X2 + O/U 2.5 markets for every
  World Cup fixture, watches the TxLINE scores stream, settles at finality
- `tests/settle-devnet.ts` — full lifecycle on devnet against a REAL proof,
  including negative cases (false outcome, mid-match proof, loser claim)
- `packages/txline-kit/` — vendored TxLINE SDK (auth, streams, proofs, replay)
- `idls/txoracle.json` — TxLINE's IDL consumed via `declare_program!`

## Judge runbook (5 minutes, no live match needed)

```bash
pnpm install
pnpm setup-mint        # one-time: demo pool mint (pUSDC, worthless devnet money)
pnpm demo              # ONE COMMAND: full lifecycle against a REAL recorded match
```

`pnpm demo` replays the committed corpus sample (Argentina 3–2 Cape Verde,
recorded from TxLINE's historical endpoints) through a wire-compatible replay
server, creates 1X2 + O/U markets, has two demo bettors take opposite sides,
locks at kickoff, fast-forwards to full time, then fetches the REAL Merkle
proof from TxLINE's live API and settles both markets on devnet via CPI —
printing the app URLs for the receipts. Prereqs: a funded devnet wallet at
`../.keys/devnet-wallet.json` (faucet.solana.com) — TxLINE activation happens
automatically on first run.

```bash
pnpm --dir app dev     # the app on http://localhost:3040 (grid / market / builder / receipt)
```

## Live mode (during the tournament)

```bash
ANCHOR_WALLET=../.keys/devnet-wallet.json pnpm keeper
# creates markets for all upcoming fixtures, then settles each one
# autonomously the moment TxLINE emits game_finalised
```

Replay judge mode for the keeper itself (streams from the replay server,
proofs still from the real API):

```bash
pnpm --dir packages/txline-kit exec txline-replay serve --fixture 18175918 --speed 30 --corpus ../../corpus-sample
REPLAY_BASE_URL=http://localhost:8788/api pnpm keeper
```

Full on-chain lifecycle test (uses a fresh finished fixture every run,
including negative cases — false outcome, mid-match proof, loser claim):

```bash
pnpm test:devnet
```

## TxLINE endpoints used
`/auth/guest/start`, `/api/token/activate` (on-chain subscribe flow),
`/api/fixtures/snapshot`, `/api/scores/stream`, `/api/scores/snapshot/{id}`,
`/api/scores/historical/{id}`, `/api/odds/updates/{day}/{hour}/{interval}`,
`/api/scores/stat-validation` → `txoracle::validate_stat` CPI.

## Layout (additions)
- `app/` — Next.js frontend: tournament grid, market page (pool share ·
  parimutuel multiplier per outcome), market builder with a live preview of
  the on-chain settlement contract in TxLINE stat-key language, permissionless
  settle-from-the-UI (any wallet can earn the bounty), and the settlement
  receipt page (Merkle path: final stats → event-stat root → on-chain daily
  root PDA, with explorer links). The browser never talks to TxLINE or signs
  anything it didn't build: API routes return unsigned base64 transactions the
  wallet signs (Solana Pay pattern).
- `corpus-sample/` — committed replay fixture for the judge demo.

## Status
- [x] Anchor program deployed to devnet, full lifecycle test green (incl.
      false-outcome rejection + mid-match finality guard, verified on-chain)
- [x] Keeper: market bootstrap + autonomous live settlement loop
- [x] Frontend: grid, market page, builder, receipt — verified against devnet
- [x] One-command judge demo (`pnpm demo`) with committed corpus sample
- [ ] Vercel deploy (set KEEPER_WALLET_JSON, MINT, TXLINE_JWT/TXLINE_API_TOKEN,
      NEXT_PUBLIC_RPC_URL) + demo video
# proofplay-txline
