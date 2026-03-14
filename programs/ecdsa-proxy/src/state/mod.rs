use anchor_lang::prelude::*;

#[account]
pub struct WalletState {
    pub eth_address: [u8; 20],
    pub nonce: u64,
    pub bump: u8,
}

impl Space for WalletState {
    const INIT_SPACE: usize = 20 + 8 + 1;
}
