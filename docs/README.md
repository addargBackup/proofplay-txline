# ProofPlay — Technical Documentation

Permissionless parimutuel prediction markets for the 2026 World Cup, settled
trustlessly on Solana by cryptographic proofs from [TxLINE](https://txline.txodds.com).

1. [Powered by TxLINE](#1-powered-by-txline) — every fact in this app, end to end
2. [Core idea](#2-core-idea)
3. [Technical highlights](#3-technical-highlights)
4. [Business highlights](#4-business-highlights)
5. [Architecture](#5-architecture)
6. [Endpoints used](#6-txline-endpoints-used) (+ [why an SDK](#why-an-sdk-instead-of-calling-these-directly), + [raw → SDK mapping](#raw-endpoints-replaced-by-sdk-calls))
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

### The market language — four kinds, one predicate system

A market's settlement rule is a `PredicateSpec` stored on-chain, not a
hardcoded bet type:

| Kind | Example | Outcomes |
|---|---|---|
| `WinnerDrawLoser` | Full-match 1X2 | home / draw / away |
| `TotalGoalsOverUnder{line}` | Total goals O/U 2.5 | over / under |
| `StatOverUnder{statKey,line}` | Any single TxLINE stat, any period — e.g. 2nd-half home corners O/U 5.5 (`statKey 3007`) | over / under |
| `TwoStatSumOverUnder{keyA,keyB,line}` | Two stats summed, any period — the track brief's own "Team A corners + Team B corners > 10" example, built exactly as specified | over / under |

The frontend's market builder shows the literal generated stat key (e.g.
`Norway corners(key 3007)`) before you deploy. **This shipped as a live
program upgrade** — the four-kind system replaced an earlier two-kind version
*on the already-deployed devnet program, in place*, with legacy market PDAs
kept byte-compatible so markets settled before the upgrade were untouched.

### The settler never chooses the predicate — the program does

A caller claims *which* outcome they're proving; the program reconstructs
the exact comparison from the market's stored spec and only that — a settler
cannot submit a proof for a made-up outcome. We tested submitting a
deliberately false outcome on devnet and the CPI into `txoracle` rejected it.

### A proof only counts if it's actually final

TxLINE marks a proven stat with `period == 100` exclusively in the
`game_finalised` record — a mid-match proof carries the live phase id
instead. Our settle instruction requires `period == 100`; we tested
submitting a real mid-match proof (halftime score, different from the final)
and the program rejected it. This single check is what makes "settled by
proof" actually sound rather than spoofable.

### Verified on-chain, adversarially, not just happy-path

The devnet test suite (`pnpm test:devnet`) auto-selects a fresh finished
World Cup fixture every run and exercises the full lifecycle plus every
failure mode we could think of, all green:

- Bet, kickoff lock enforcement, settlement with a **real TxLINE proof**
- **False-outcome proof rejected** by the CPI
- **Mid-match proof rejected** by the `period == 100` guard
- **Draw outcome** settled correctly (tested live on Switzerland 0-0 Colombia)
- **Corners prop settled with a real two-stat proof** (`statKeys=[7,8]`) —
  the generalized market language, proven end to end, not just described
- **Winner payout exact to the token** (149.25 of a 150 pool after the 0.5%
  bounty) and **empty-winning-pool refund exact to the token** (29.85 of 30)
- **Winner double-claim rejected**; **loser claim rejected**

Across development we've settled real markets on multiple actual World Cup
fixtures on devnet — Spain 2-1 Belgium, Switzerland 0-0 Colombia,
France 2-0 Morocco, Argentina 3-2 Cape Verde, Norway v England, and
Argentina v Switzerland — not one scripted happy path.

### Autonomous recovery, not just autonomous operation

The keeper doesn't just settle matches it sees finish live — it recovers
from its own downtime. On boot, `sweepUnsettled()` checks every open market
against TxLINE's historical endpoint and settles anything whose match
already ended while the keeper was offline. This isn't theoretical: it
recovered two real fixtures (Norway v England, Argentina v Switzerland — 4
markets) that finished while the keeper wasn't running, settling them on
devnet with real proofs the moment it restarted.

### Permissionless settlement is a UI feature, not just a program capability

Any connected wallet can open a locked market and click **"Settle with proof
(earn bounty)"** — the app fetches the real TxLINE proof and builds the
settlement transaction for that wallet to sign, exactly the same on-chain
path the keeper uses. This proves the "anyone can settle" claim isn't just
true in the program — it's one click away for an end user, with no keeper
dependency.

### Non-custodial by construction

The browser never holds a signing key and never talks to TxLINE or Anchor
directly. API routes build **unsigned** transactions server-side; the
connected wallet signs client-side before anything is sent to devnet — the
same pattern behind Solana Pay. Verified end to end with a headless test
(`tests/consumer-flow.ts`): faucet → build a bet transaction over HTTP →
sign locally → submit to devnet → read the resulting position back through
the same API → confirm the settle route fails cleanly (not a stack trace)
when called on a match that hasn't finished yet.

### Abandoned matches don't strand funds

Any market unsettled 72 hours after kickoff can be voided by anyone, and
stakes refund pro-rata — no admin action required.

### Judging happens after the tournament ends

So the app ships a wire-compatible replay of **real captured match data** —
over 1,100 score updates and 66,000+ StablePrice odds records pulled from
TxLINE's historical endpoints for one recorded match alone
(`packages/txline-kit`'s replay server). `pnpm demo` runs the entire
lifecycle — market creation, betting, kickoff lock, full time, on-chain
settlement with a real TxLINE proof — against that recording, indistinguishable
from live to every layer of the code above it, and it re-runs indefinitely
(each run auto-selects a market kind nobody has used yet on that fixture,
since market PDAs are permanent once settled — that permanence *is* the
protocol working as designed).

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

### Why an SDK instead of calling these directly

We built [`txline-kit`](../packages/txline-kit) rather than hitting the raw
API from `keeper/` and `app/` because the raw API has real, repeated sharp
edges — see the kit's own [Field Guide](../packages/txline-kit/docs/VERIFIED.md)
for the full list — and ProofPlay's soundness depends on getting several of
them exactly right *every time* (not just once):

- **Auth is a multi-step flow** (guest JWT → on-chain `subscribe()` → token
  activation → transparent renewal on 401), not a single request. Writing
  that once in the kit means the keeper, the app, and our test suite can't
  each implement it slightly differently and drift.
- **Live records don't match the documented schema casing**, and
  `/scores/historical` returns SSE-framed text on a `200`, not JSON. Code
  that doesn't know this silently breaks in production, not at compile time.
- **The Merkle-proof payload has to be shaped exactly right for the on-chain
  CPI to accept it** — byte arrays, PDA derivation, the real `validate_stat`
  predicate grammar (which isn't quite what the API's own prose implies). A
  settlement path is the worst possible place to hand-roll this twice.
- **Replay mode had to be wire-compatible by construction.** Because the kit
  is the *only* thing that talks to TxLINE, pointing it at a replay server
  instead (`network: 'replay'`) makes every consumer — keeper, app, tests —
  demo-ready with a one-line change, with zero risk of the "live" and
  "replay" code paths silently diverging.

In short: the raw API works fine for a one-off script. A protocol whose
entire trust model rests on "the proof check is exact, every time" needed a
single, tested, reused implementation of that check — not three.

### Raw endpoints replaced by SDK calls

Every TxLINE call in this repo goes through `@txline-kit/client` — there is
no direct `fetch()` against `txodds.com` anywhere in `keeper/`, `app/`, or
`tests/`. This is the exact mapping from raw endpoint to the kit method that
replaces it:

| Raw endpoint (what you'd call by hand) | SDK call (what we call instead) |
|---|---|
| `POST /auth/guest/start` + on-chain `subscribe()` + `POST /api/token/activate` (+ manual 401 retry) | `tx.auth.ensureActivated()` |
| `GET /api/fixtures/snapshot?competitionId=&startEpochDay=` | `tx.fixturesSnapshot(competitionId)` |
| `GET /api/scores/snapshot/{fixtureId}` | `tx.scoresSnapshot(fixtureId)` |
| `GET /api/scores/stream` (raw `EventSource`, manual reconnect/resume) | `for await (const msg of tx.scoresStream())` |
| `GET /api/scores/historical/{fixtureId}` (+ manual SSE-body parsing) | `tx.scoresHistorical(fixtureId)` |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKeys=` | `tx.statValidation({ fixtureId, seq, statKeys })` |
| Manual borsh/PDA work to call `txoracle::validate_stat[_v2]` | `proofs.toBytes32`, `proofs.toProofNodes`, `proofs.dailyScoresRootsPda`, `proofs.buildStatValidationInput` |

Devnet program addresses: ProofPlay `DDLwN6s1mswd7wiXFHy76eTahw4VYPAUrvEHZNdcHaRw`,
TxLINE `txoracle` `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.

## 7. Run it / judge runbook

```bash
pnpm install
pnpm setup-mint      # one-time: devnet pUSDC test mint
pnpm demo            # full lifecycle against a real recorded match, ~90s
pnpm test:devnet     # the adversarial suite from §3, on-chain, ~2 min
```
`pnpm demo` replays a real World Cup match, creates markets, places bets,
locks at kickoff, fast-forwards to full time, and settles on-chain with a
real TxLINE Merkle proof — no manual steps. `pnpm test:devnet` is the
stronger proof: it runs the false-outcome rejection, the mid-match rejection,
the exact-token payout/refund checks, and the double-claim rejection against
a live, freshly-picked finished fixture, live on devnet. See the root
[README.md](../README.md) for the app URL and live-mode (`pnpm keeper`)
instructions.
