use anchor_lang::prelude::*;

use crate::constants::{WALLET_PREFIX, WALLET_SEED};
use crate::state::WalletState;

#[derive(Accounts)]
#[instruction(eth_address: [u8; 20])]
pub struct InitializeWallet<'info> {
    #[account(
        init,
        payer = payer,
        space = WalletState::DISCRIMINATOR.len() + WalletState::INIT_SPACE,
        seeds = [WALLET_SEED, WALLET_PREFIX, &eth_address],
        bump,
    )]
    pub wallet_state: Account<'info, WalletState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeWallet>, eth_address: [u8; 20]) -> Result<()> {
    let wallet_state = &mut ctx.accounts.wallet_state;
    wallet_state.eth_address = eth_address;
    wallet_state.nonce = 0;
    wallet_state.bump = ctx.bumps.wallet_state;
    Ok(())
}
