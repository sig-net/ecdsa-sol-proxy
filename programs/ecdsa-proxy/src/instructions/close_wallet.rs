use anchor_lang::prelude::*;

use crate::constants::{WALLET_PREFIX, WALLET_SEED};
use crate::ecdsa::{recover_eth_address, verify_low_s};
use crate::error::EcdsaProxyError;
use crate::message::compute_message_hash;
use crate::state::WalletState;

#[derive(Accounts)]
pub struct CloseWallet<'info> {
    #[account(
        mut,
        close = rent_recipient,
        seeds = [WALLET_SEED, WALLET_PREFIX, &wallet_state.eth_address],
        bump = wallet_state.bump,
    )]
    pub wallet_state: Account<'info, WalletState>,
    pub payer: Signer<'info>,
    /// CHECK: Receives rent on close, no constraints needed.
    #[account(mut)]
    pub rent_recipient: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<CloseWallet>,
    signature: [u8; 64],
    recovery_id: u8,
    nonce: u64,
) -> Result<()> {
    let wallet_state = &ctx.accounts.wallet_state;

    require!(nonce == wallet_state.nonce, EcdsaProxyError::NonceMismatch);
    require!(
        verify_low_s(&signature),
        EcdsaProxyError::SignatureMalleability
    );

    let message_hash = compute_message_hash(ctx.program_id, nonce, &[], &[])?;
    let recovered = recover_eth_address(&message_hash, &signature, recovery_id)?;
    require!(
        recovered == wallet_state.eth_address,
        EcdsaProxyError::AddressMismatch
    );

    Ok(())
}
