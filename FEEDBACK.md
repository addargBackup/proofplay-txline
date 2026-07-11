# TxLINE API feedback (from building ProofPlay)

Everything below was hit while building this project against the devnet API +
`txoracle` program during July 10–11, 2026. Overall: the validation primitive is
genuinely excellent — we CPI'd `validate_stat` from our own program and it did
exactly what the docs promised. The rough edges are all in the off-chain API's
consistency.

## What we loved
1. **`validate_stat`'s predicate grammar is a great settlement language.**
   `(stat_a ± stat_b) vs threshold` expresses 1X2, totals, handicaps, and team
   totals with one instruction. Our whole product is basically a UI over it.
2. **`period == 100` on finalised stats is a gift.** It makes "you cannot settle
   on a mid-match score" a one-line on-chain check. We verified a real
   mid-match proof (period=4) is rejected while the final proof passes.
3. **Proofs are tiny** (~500–600 bytes for a two-stat proof) — a full CPI
   settlement fits in one transaction with room to spare. We expected to need
   buffer accounts; we didn't.
4. **Free devnet tier with 0-second delay** made the whole build possible
   without ever touching mainnet money.
5. The runnable `tx-on-chain` examples were the fastest path to a working
   activation flow — we ported `users.ts` almost verbatim.

## Friction we hit (in order of pain)
1. **`/api/scores/historical/{fixtureId}` returns SSE-formatted text
   (`data: {...}` frames) with a JSON content pipeline elsewhere.** Every other
   REST endpoint returns a JSON document. Our client had to sniff bodies and
   parse SSE frames out of a REST response. Please either return a JSON array
   or document the framing.
2. **Casing is inconsistent between the OpenAPI schema and live payloads.**
   The spec's `Scores` schema reads camelCase (`fixtureId`, `seq`, `gameState`)
   but live records are PascalCase (`FixtureId`, `Seq`, `GameState`). Odds
   payloads are PascalCase in both. We coded to live data.
3. **`GameState` on score records never changed from "scheduled" during a
   match; the actual phase lives in `StatusId`.** The field name suggests the
   opposite. Docs clarifying "phase = StatusId (1–19, 100=finalised)" would
   have saved an evening.
4. **`Clock {running, seconds}` exists in the schema but was never populated**
   across 1,116 updates of a finished match. If it's coming later, say so; if
   it's dead, remove it from the schema.
5. **Odds snapshots are empty outside the in-play window** (0 records both
   pre-match and post-match), while the 5-minute bucket endpoints during the
   match are extremely rich (66k records, 53 markets for one fixture). The
   coverage docs' "check the odds response per fixture" advice reads
   differently once you know pre-match returns nothing — worth an explicit
   note on when StablePrice coverage begins.
6. **The devnet faucet dependency is the real onboarding wall** — not your
   flow. Consider documenting faucet.solana.com (rate limits included) in the
   quickstart, since `subscribe` needs SOL even on the free tier.
7. Minor: `declare_program!(txoracle)` chokes on the IDL's `constants` section
   (pubkey constants render as invalid literals in generated Rust). We stripped
   `constants` from our vendored IDL as a workaround. An IDL published without
   the admin constants would CPI-integrate cleanly.

## Wishlist
- A `settled`/finality webhook or an SSE filter for `action=game_finalised`
  (we stream everything to catch one record per match).
- `statKeys` proof requests batched across fixtures (settling a whole matchday
  in one call).
- Player-level stat keys — first-scorer markets are impossible to settle
  trustlessly today, and everyone will try to build them.
