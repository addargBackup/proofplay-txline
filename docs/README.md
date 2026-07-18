# ProofPlay — Technical Documentation

Permissionless parimutuel prediction markets for the 2026 World Cup, settled
trustlessly on Solana by cryptographic proofs from [TxLINE](https://txline.txodds.com).

1. [Powered by TxLINE](#1-powered-by-txline) — every fact in this app, end to end
2. [Core idea](#2-core-idea)
3. [Technical highlights](#3-technical-highlights)
4. [Business highlights](#4-business-highlights)
5. [Architecture](#5-architecture)
6. [Endpoints used](#6-txline-endpoints-used)
7. [Run it](#7-run-it--judge-runbook)

See also: [FEEDBACK.md](../FEEDBACK.md) for our experience building on the
TxLINE API.

---

## 1. Powered by TxLINE

**TxLINE is not one data source among several in this app — it is the only
data source.** ProofPlay has no other API integration, no other odds
provider, no other source of match state. Every number a user sees and every
dollar that moves is downstream of a TxLINE call, and every one of those
calls goes through one vendored client
([`packages/txline-kit`](../packages/txline-kit)) so there is a single,
auditable choke point for all external data in the codebase.

Concretely, here is what TxLINE supplies at each stage of a market's life,
and there is nothing else supplying it:

| Stage | What happens | TxLINE call |
|---|---|---|
| **Discovery** | The keeper learns which World Cup fixtures exist and when they kick off | `fixturesSnapshot()` |
| **Market creation** | Kickoff time (used to lock betting) comes straight from the fixture record | same call, no other source |
| **Live state** | The app's live score badge on a market page | `scoresSnapshot()` |
| **Finality detection** | The keeper watches for the exact moment a match ends | `scoresStream()` (SSE) — the `game_finalised` record |
| **Settlement evidence** | The cryptographic proof of the final score that the Solana program verifies | `statValidation()` → a Merkle proof, checked on-chain via CPI into TxLINE's own `txoracle` program |
| **Demo / judge mode** | A recorded real match, replayed byte-for-byte through the same code path | `scoresHistorical()` (fetched once) → replayed by `txline-replay` |

**The most important line in that table is settlement.** ProofPlay's Anchor
program does not have an admin key, a multisig, or any human-controlled
"resolve market" instruction. The *only* way a market can settle is a
transaction that carries a TxLINE Merkle proof, which the program forwards
via Cross-Program Invocation to TxLINE's `txoracle` program on-chain
(devnet: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`). If `txoracle`
rejects the proof, the transaction fails and nothing settles. We verified
this directly — see [§3](#3-technical-highlights).

TxLINE data reaches the frontend the same way: the browser never talks to
TxLINE directly. It calls our own Next.js API routes, which call the kit,
which calls TxLINE. One path in, no side channels.

---

## 2. Core idea

Every prediction market has the same failure mode: someone — an admin, a
multisig, a "trusted" oracle operator — decides who won, and you have to
trust them. ProofPlay removes that person. A market is a parimutuel pool tied
to a specific, on-chain-defined stat condition (see [§3](#3-technical-highlights)
for the "market language"). It settles only when *someone* — anyone, not a
privileged party — submits TxLINE's Merkle proof of the real final stats, and
our Solana program verifies that proof cryptographically before releasing a
single token. Nobody decides the outcome. The oracle does, and the settler
who bothers to submit it earns a small bounty for the trouble.

## 3. Technical highlights

- **Markets are data, not hardcoded types.** A market's settlement rule is a
  `PredicateSpec` stored on-chain: any TxLINE stat key, any period (full
  match / 1st half / 2nd half), compared against any threshold, or two stat
  keys summed against a threshold (the "corners A + corners B > 10" example
  from the track brief, built exactly as specified). The frontend's market
  builder shows the literal generated stat key (e.g. `3007` = 2nd-half home
  corners) before you deploy.
- **The settler never chooses the predicate — the program does.** A caller
  claims *which* outcome they're proving; the program reconstructs the exact
  comparison from the stored spec and only that. We tested submitting a
  deliberately false outcome on devnet — the CPI into `txoracle` rejected it.
- **A proof only counts if it's actually final.** TxLINE marks a proven stat
  with `period == 100` exclusively in the `game_finalised` record — a
  mid-match proof carries the live phase id instead. Our settle instruction
  requires `period == 100`; we tested submitting a real mid-match proof
  (halftime score, final match different) and the program rejected it. This
  single check is what makes "settled by proof" actually sound rather than
  spoofable.
- **Abandoned matches don't strand funds.** Any market unsettled 72 hours
  after kickoff can be voided by anyone, and stakes refund pro-rata — no
  admin action required.
- **Judging happens after the tournament ends**, so the app ships a
  wire-compatible replay of a real recorded match (`packages/txline-kit`'s
  replay server). `pnpm demo` runs the entire lifecycle — market creation,
  betting, kickoff lock, full time, on-chain settlement with a real TxLINE
  proof — against that recording, indistinguishable from live to every layer
  of the code above it.

## 4. Business highlights

- **Free tier by design.** Betting a stablecoin-style pUSDC test token keeps
  the product a game of skill/prediction, not a wagering platform, while the
  on-chain mechanics are identical to a real-asset deployment.
- **Settler bounty (0.5% of pool) turns settlement into an incentive, not a
  chore** — a permissionless keeper economy rather than a single point of
  failure. Anyone, including a competing project, is economically motivated
  to keep the whole system moving.
- **The market builder is the moat.** Because the predicate language covers
  TxLINE's full stat vocabulary, ProofPlay isn't three hardcoded bet types —
  it's a market-creation platform for anything TxLINE can prove, with zero
  additional on-chain code required per new market shape.

## 5. Architecture

```
Next.js app  ──HTTP──▶  Next.js API routes  ──┐
(browser)                                      ├──▶  txline-kit  ──▶  TxLINE API
Keeper (Node)  ─────────────────────────────┘
      │
      ▼
Anchor program (Solana devnet)  ──CPI──▶  txoracle (TxLINE's on-chain program)
```

- **`packages/txline-kit`** — vendored SDK; the single choke point for all
  TxLINE access (auth, REST, SSE, Merkle-proof helpers, replay server).
- **`programs/proofplay`** — the Anchor program: `create_market`, `bet`,
  `settle` (CPI into `txoracle`), `void_market`, `claim`.
- **`keeper/`** — a Node service that creates markets from TxLINE's fixture
  schedule and settles them the moment a match finalizes.
- **`app/`** — the Next.js frontend; API routes build unsigned transactions
  the connected wallet signs client-side (the browser never holds a private
  key server-side).

## 6. TxLINE endpoints used

| Endpoint | Used for |
|---|---|
| `POST /auth/guest/start` | Guest session (start of the auth flow) |
| `POST /api/token/activate` | On-chain-verified API token activation |
| `GET /api/fixtures/snapshot` | World Cup schedule → market creation |
| `GET /api/scores/snapshot/{fixtureId}` | Live score display on a market page |
| `GET /api/scores/stream` (SSE) | Live finality detection for the keeper |
| `GET /api/scores/historical/{fixtureId}` | Real-match corpus for judge/replay mode |
| `GET /api/scores/stat-validation` | Merkle proof of final stats → on-chain settlement |
| `txoracle::validate_stat` / `validate_stat_v2` (CPI) | On-chain proof verification (Solana program) |

Devnet program addresses: ProofPlay `DDLwN6s1mswd7wiXFHy76eTahw4VYPAUrvEHZNdcHaRw`,
TxLINE `txoracle` `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.

## 7. Run it / judge runbook

```bash
pnpm install
pnpm setup-mint      # one-time: devnet pUSDC test mint
pnpm demo            # full lifecycle against a real recorded match, ~90s
```
`pnpm demo` replays a real World Cup match, creates markets, places bets,
locks at kickoff, fast-forwards to full time, and settles on-chain with a
real TxLINE Merkle proof — no manual steps. See the root
[README.md](../README.md) for the app URL and live-mode (`pnpm keeper`)
instructions.
