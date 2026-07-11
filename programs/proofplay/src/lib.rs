//! ProofPlay — permissionless parimutuel prediction markets for the 2026 World
//! Cup, settled trustlessly by CPI into TxLINE's `txoracle` validation program.
//!
//! Nobody resolves a market by authority. A market settles when ANYONE submits
//! a TxLINE Merkle proof of the final match stats; the program reconstructs the
//! predicate for the claimed outcome itself, CPIs into `validate_stat`, and
//! releases funds only if the proof verifies against the on-chain daily root.
//!
//! Soundness invariants (see txline-kit/docs/VERIFIED.md):
//!  * A proven stat carries `period == 100` ONLY in the game_finalised record —
//!    mid-match proofs carry the live phase id (e.g. 4 for H2) and are rejected,
//!    so settling on a temporary scoreline is cryptographically impossible.
//!  * `stat.key` is the full composed TxLINE stat key (1 = home goals total,
//!    2 = away goals total); the program pins the exact keys per market kind.
//!  * The caller picks WHICH outcome to prove; the program builds the predicate,
//!    so a malicious settler cannot prove a false outcome — a wrong claim just
//!    fails validation.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_program!(txoracle);
use txoracle::cpi as txoracle_cpi;
use txoracle::cpi::accounts::ValidateStat;
use txoracle::program::Txoracle;
use txoracle::types::{
    BinaryExpression, Comparison, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate,
};

declare_id!("DDLwN6s1mswd7wiXFHy76eTahw4VYPAUrvEHZNdcHaRw");

/// TxLINE marks stats from the game_finalised record with period == 100.
pub const FINAL_PERIOD: i32 = 100;
/// TxLINE composed stat keys pinned by the market kinds below.
pub const KEY_HOME_GOALS: u32 = 1;
pub const KEY_AWAY_GOALS: u32 = 2;
/// Unsettled markets become refundable this long after kickoff (covers
/// abandoned/postponed fixtures without trusting any authority).
pub const VOID_TIMEOUT_SECS: i64 = 72 * 3600;
pub const BPS: u64 = 10_000;
pub const MAX_BOUNTY_BPS: u16 = 200; // 2%

#[program]
pub mod proofplay {
    use super::*;

    /// Permissionless. One market per (fixture, kind); PDA seeds enforce it.
    /// `kickoff_ts` is unix SECONDS (bets lock at kickoff).
    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: i64,
        kickoff_ts: i64,
        kind: MarketKind,
        bounty_bps: u16,
    ) -> Result<()> {
        kind.validate()?;
        require!(bounty_bps <= MAX_BOUNTY_BPS, ProofPlayError::BountyTooHigh);

        let market = &mut ctx.accounts.market;
        market.fixture_id = fixture_id;
        market.kickoff_ts = kickoff_ts;
        market.kind = kind;
        market.state = MarketState::Open;
        market.outcome = u8::MAX;
        market.num_outcomes = kind.num_outcomes();
        market.pools = [0; 3];
        market.total_pool = 0;
        market.bounty_bps = bounty_bps;
        market.creator = ctx.accounts.creator.key();
        market.mint = ctx.accounts.mint.key();
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Join the pool for one outcome. Re-betting adds to the SAME outcome only.
    pub fn bet(ctx: Context<Bet>, outcome: u8, amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open, ProofPlayError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.kickoff_ts,
            ProofPlayError::BettingClosed
        );
        require!(outcome < market.num_outcomes, ProofPlayError::BadOutcome);
        require!(amount > 0, ProofPlayError::ZeroAmount);

        let position = &mut ctx.accounts.position;
        if position.amount > 0 {
            require!(position.outcome == outcome, ProofPlayError::OutcomeMismatch);
        } else {
            position.market = market.key();
            position.bettor = ctx.accounts.bettor.key();
            position.outcome = outcome;
            position.claimed = false;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bettor_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.bettor.to_account_info(),
                },
            ),
            amount,
        )?;

        position.amount = position.amount.checked_add(amount).unwrap();
        market.pools[outcome as usize] = market.pools[outcome as usize].checked_add(amount).unwrap();
        market.total_pool = market.total_pool.checked_add(amount).unwrap();
        Ok(())
    }

    /// THE CENTERPIECE. Permissionless: anyone holding a valid TxLINE proof of
    /// the FINAL match stats can settle and earn the bounty. The program:
    ///  1. pins the stat keys + finality period (soundness guards),
    ///  2. reconstructs the predicate for `claimed_outcome` from the market kind,
    ///  3. CPIs into txoracle::validate_stat against the daily Merkle root,
    ///  4. on success records the outcome + receipt and pays the settler bounty.
    pub fn settle(ctx: Context<Settle>, args: SettleArgs) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.state == MarketState::Open, ProofPlayError::MarketNotOpen);
        require!(
            args.claimed_outcome < market.num_outcomes,
            ProofPlayError::BadOutcome
        );

        // --- Proof/spec binding guards -------------------------------------
        require!(
            args.summary.fixture_id == market.fixture_id,
            ProofPlayError::FixtureMismatch
        );
        require!(
            args.ts == args.summary.update_stats.min_timestamp,
            ProofPlayError::TimestampMismatch
        );
        require!(
            args.stat_a.stat_to_prove.key == KEY_HOME_GOALS
                && args.stat_b.stat_to_prove.key == KEY_AWAY_GOALS,
            ProofPlayError::WrongStatKey
        );
        // FINALITY GUARD: only stats from the game_finalised record carry 100.
        require!(
            args.stat_a.stat_to_prove.period == FINAL_PERIOD
                && args.stat_b.stat_to_prove.period == FINAL_PERIOD,
            ProofPlayError::NotFinal
        );

        // --- Predicate is built by the PROGRAM, not the caller --------------
        let (predicate, op) = market.kind.predicate_for(args.claimed_outcome)?;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.txoracle_program.to_account_info(),
            ValidateStat {
                daily_scores_merkle_roots: ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            },
        );
        let ret = txoracle_cpi::validate_stat(
            cpi_ctx,
            args.ts,
            args.summary.clone(),
            args.fixture_proof.clone(),
            args.main_tree_proof.clone(),
            predicate,
            args.stat_a.clone(),
            Some(args.stat_b.clone()),
            Some(op),
        )?;
        require!(ret.get(), ProofPlayError::ProofRejected);

        // --- Pay the settler bounty (vault signs via market PDA) ------------
        let m = &ctx.accounts.market;
        let bounty = (m.total_pool as u128 * m.bounty_bps as u128 / BPS as u128) as u64;
        if bounty > 0 {
            let fid = m.fixture_id.to_le_bytes();
            let kseed = m.kind.seed();
            let bump = [m.bump];
            let seeds: &[&[u8]] = &[b"market", &fid, &kseed, &bump];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.settler_token.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    &[seeds],
                ),
                bounty,
            )?;
        }

        // --- Record outcome + receipt ---------------------------------------
        let market = &mut ctx.accounts.market;
        market.state = MarketState::Settled;
        market.outcome = args.claimed_outcome;
        market.receipt_event_stat_root = args.stat_a.event_stat_root;
        market.receipt_min_timestamp = args.summary.update_stats.min_timestamp;
        market.settler = ctx.accounts.settler.key();
        Ok(())
    }

    /// Permissionless safety valve: if no valid final proof settled the market
    /// within VOID_TIMEOUT_SECS of kickoff (abandoned/postponed/cancelled
    /// fixture, or coverage loss), everyone reclaims their stake pro-rata.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open, ProofPlayError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp > market.kickoff_ts + VOID_TIMEOUT_SECS,
            ProofPlayError::VoidTooEarly
        );
        market.state = MarketState::Voided;
        Ok(())
    }

    /// Winners: stake * distributable / winning_pool. Voided (or nobody backed
    /// the winner): full stake refund. One claim per position.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &ctx.accounts.position;
        require!(!position.claimed, ProofPlayError::AlreadyClaimed);

        let payout: u64 = match market.state {
            MarketState::Open => return err!(ProofPlayError::MarketNotSettled),
            MarketState::Voided => position.amount,
            MarketState::Settled => {
                let winning_pool = market.pools[market.outcome as usize];
                if winning_pool == 0 {
                    // Nobody backed the true outcome: refund everyone.
                    position.amount
                } else if position.outcome != market.outcome {
                    return err!(ProofPlayError::NotAWinner);
                } else {
                    let bounty =
                        market.total_pool as u128 * market.bounty_bps as u128 / BPS as u128;
                    let distributable = market.total_pool as u128 - bounty;
                    (position.amount as u128 * distributable / winning_pool as u128) as u64
                }
            }
        };

        let fid = market.fixture_id.to_le_bytes();
        let kseed = market.kind.seed();
        let bump = [market.bump];
        let seeds: &[&[u8]] = &[b"market", &fid, &kseed, &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.claimer_token.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[seeds],
            ),
            payout.min(ctx.accounts.vault.amount), // dust guard on final claim
        )?;

        ctx.accounts.position.claimed = true;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Market kinds — the "market language" v1. Settlement conventions are ON-CHAIN.
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum MarketKind {
    /// Outcomes [home, draw, away]; settles on the 90-minute result:
    /// (home_goals - away_goals) {>,=,<} 0 over TxLINE keys 1 and 2.
    WinnerDrawLoser,
    /// Outcomes [over, under] of total goals vs a HALF line (line_x2 must be
    /// odd, e.g. 5 => 2.5): over = sum > (line_x2-1)/2, under = sum < (line_x2+1)/2.
    TotalGoalsOverUnder { line_x2: u16 },
}

impl MarketKind {
    pub fn validate(&self) -> Result<()> {
        match self {
            MarketKind::WinnerDrawLoser => Ok(()),
            MarketKind::TotalGoalsOverUnder { line_x2 } => {
                require!(line_x2 % 2 == 1 && *line_x2 < 40, ProofPlayError::BadLine);
                Ok(())
            }
        }
    }

    pub fn num_outcomes(&self) -> u8 {
        match self {
            MarketKind::WinnerDrawLoser => 3,
            MarketKind::TotalGoalsOverUnder { .. } => 2,
        }
    }

    /// PDA seed component: one market per (fixture, kind incl. params).
    pub fn seed(&self) -> [u8; 3] {
        match self {
            MarketKind::WinnerDrawLoser => [0, 0, 0],
            MarketKind::TotalGoalsOverUnder { line_x2 } => {
                let b = line_x2.to_le_bytes();
                [1, b[0], b[1]]
            }
        }
    }

    /// The deterministic core: claimed outcome -> txoracle predicate.
    pub fn predicate_for(&self, outcome: u8) -> Result<(TraderPredicate, BinaryExpression)> {
        let p = |threshold: i32, comparison: Comparison| TraderPredicate { threshold, comparison };
        match self {
            MarketKind::WinnerDrawLoser => match outcome {
                0 => Ok((p(0, Comparison::GreaterThan), BinaryExpression::Subtract)),
                1 => Ok((p(0, Comparison::EqualTo), BinaryExpression::Subtract)),
                2 => Ok((p(0, Comparison::LessThan), BinaryExpression::Subtract)),
                _ => err!(ProofPlayError::BadOutcome),
            },
            MarketKind::TotalGoalsOverUnder { line_x2 } => {
                let line = *line_x2 as i32;
                match outcome {
                    0 => Ok((p((line - 1) / 2, Comparison::GreaterThan), BinaryExpression::Add)),
                    1 => Ok((p((line + 1) / 2, Comparison::LessThan), BinaryExpression::Add)),
                    _ => err!(ProofPlayError::BadOutcome),
                }
            }
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub enum MarketState {
    Open,
    Settled,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub claimed_outcome: u8,
    pub ts: i64,
    pub summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    /// Must prove TxLINE key 1 (home goals, total period) at finality.
    pub stat_a: StatTerm,
    /// Must prove TxLINE key 2 (away goals, total period) at finality.
    pub stat_b: StatTerm,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub fixture_id: i64,
    pub kickoff_ts: i64,
    pub kind: MarketKind,
    pub state: MarketState,
    pub outcome: u8,
    pub num_outcomes: u8,
    pub pools: [u64; 3],
    pub total_pool: u64,
    pub bounty_bps: u16,
    pub creator: Pubkey,
    pub mint: Pubkey,
    /// Settlement receipt: the Merkle root the winning proof hung off, and the
    /// proof batch timestamp — permanent, user-auditable evidence.
    pub receipt_event_stat_root: [u8; 32],
    pub receipt_min_timestamp: i64,
    pub settler: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub outcome: u8,
    pub amount: u64,
    pub claimed: bool,
}

#[derive(Accounts)]
#[instruction(fixture_id: i64, kickoff_ts: i64, kind: MarketKind)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", fixture_id.to_le_bytes().as_ref(), kind.seed().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bet<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = bettor_token.mint == market.mint @ ProofPlayError::WrongMint)]
    pub bettor_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = settler_token.mint == market.mint @ ProofPlayError::WrongMint)]
    pub settler_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub settler: Signer<'info>,
    /// CHECK: PDA of the txoracle program; txoracle::validate_stat itself
    /// verifies the derivation + contents against the epoch-day seeds.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    pub txoracle_program: Program<'info, Txoracle>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), claimer.key().as_ref()],
        bump,
        constraint = position.bettor == claimer.key() @ ProofPlayError::NotYourPosition
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = claimer_token.mint == market.mint @ ProofPlayError::WrongMint)]
    pub claimer_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ProofPlayError {
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Betting closed at kickoff")]
    BettingClosed,
    #[msg("Outcome index out of range for this market kind")]
    BadOutcome,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Position already backs a different outcome")]
    OutcomeMismatch,
    #[msg("Proof fixture does not match this market")]
    FixtureMismatch,
    #[msg("ts must equal the proof summary's minTimestamp")]
    TimestampMismatch,
    #[msg("Proof must cover TxLINE stat keys 1 (home goals) and 2 (away goals)")]
    WrongStatKey,
    #[msg("Stats are not from the game_finalised record (period != 100)")]
    NotFinal,
    #[msg("txoracle rejected the proof for the claimed outcome")]
    ProofRejected,
    #[msg("Void timeout has not elapsed")]
    VoidTooEarly,
    #[msg("Market not settled yet")]
    MarketNotSettled,
    #[msg("Position did not back the winning outcome")]
    NotAWinner,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Token account mint does not match the market")]
    WrongMint,
    #[msg("Not your position")]
    NotYourPosition,
    #[msg("Over/under line must be a half line (odd line_x2) below 20 goals")]
    BadLine,
    #[msg("Bounty exceeds maximum")]
    BountyTooHigh,
}
