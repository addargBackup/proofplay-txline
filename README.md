# ProofPlay

**Permissionless parimutuel prediction markets for the 2026 World Cup, settled
trustlessly by TxLINE Merkle proofs on Solana devnet.**

No admin resolves markets. Anyone can create a market, anyone can join its USDC
pool, and anyone holding TxLINE's cryptographic proof of the final score can
settle it (and earn a bounty for doing so). The program CPIs into TxLINE's
`txoracle` program to verify the proof against the on-chain daily Merkle root —
the market maker cannot lie, and neither can the settler.

- Program (devnet): `DDLwN6s1mswd7wiXFHy76eTahw4VYPAUrvEHZNdcHaRw`
- Oracle: TxLINE `txoracle` (devnet) `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Data: [TxLINE](https://txline.txodds.com) World Cup feeds via the vendored
  [`txline-kit`](packages/txline-kit) SDK (free devnet tier, 0s delay)

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

## Run it

```bash
pnpm install
# one-time: demo pool mint
pnpm setup-mint
# create markets for upcoming fixtures + settle finished ones automatically
ANCHOR_WALLET=../.keys/devnet-wallet.json pnpm keeper
# full on-chain lifecycle test with a real TxLINE proof (uses a fresh finished fixture per run)
pnpm test:devnet
```

Judge/replay mode: point the keeper at a wire-compatible replay of a recorded
fixture — nothing else changes:

```bash
pnpm --dir packages/txline-kit txline-replay serve --fixture <id> --speed 30
REPLAY_BASE_URL=http://localhost:8788/api pnpm keeper
```

## TxLINE endpoints used
`/auth/guest/start`, `/api/token/activate` (on-chain subscribe flow),
`/api/fixtures/snapshot`, `/api/scores/stream`, `/api/scores/snapshot/{id}`,
`/api/scores/historical/{id}`, `/api/odds/updates/{day}/{hour}/{interval}`,
`/api/scores/stat-validation` → `txoracle::validate_stat` CPI.

## Status
- [x] Anchor program deployed to devnet, full lifecycle test green
- [x] Keeper: market bootstrap + live settlement loop
- [ ] Frontend (tournament grid, market page, builder, Merkle receipt page)
- [ ] docker-compose judge runbook + demo corpus sample
