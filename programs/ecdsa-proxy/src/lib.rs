pub mod constants;
pub mod ecdsa;
pub mod error;
pub mod instructions;
pub mod message;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("95nLhd1ntaNMntT4LvNTMc7LExwzv6Unwv1xBeRFmBj1");

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InnerInstruction {
    pub program_id_index: u8,
    pub accounts: Vec<InnerAccountMeta>,
    pub data: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InnerAccountMeta {
    pub account_index: u8,
    /// bit 0 = is_signer, bit 1 = is_writable
    pub flags: u8,
}

impl InnerAccountMeta {
    pub const fn is_signer(&self) -> bool {
        self.flags & 0x01 != 0
    }
    pub const fn is_writable(&self) -> bool {
        self.flags & 0x02 != 0
    }
}

/// Single-byte discriminators (Anchor v0.31+) save 7 bytes per instruction
/// versus the default 8-byte sha256 hash, helping fit more data within
/// Solana's 1232-byte transaction limit.
#[program]
pub mod ecdsa_proxy {
    use super::*;

    /// Creates a PDA wallet bound to a 20-byte Ethereum address.
    /// Seeds: `[b"ecdsa_proxy", b"wallet", eth_address]`.
    #[instruction(discriminator = 1)]
    pub fn initialize_wallet(ctx: Context<InitializeWallet>, eth_address: [u8; 20]) -> Result<()> {
        instructions::initialize_wallet::handler(ctx, eth_address)
    }

    /// Verifies an ECDSA signature against the wallet's Ethereum address,
    /// then executes a batch of inner CPIs with the PDA as signer.
    #[instruction(discriminator = 2)]
    pub fn execute(
        ctx: Context<Execute>,
        signature: [u8; 64],
        recovery_id: u8,
        nonce: u64,
        inner_instructions: Vec<InnerInstruction>,
    ) -> Result<()> {
        instructions::execute::handler(ctx, signature, recovery_id, nonce, inner_instructions)
    }

    /// Signature-gated PDA closure. Verifies the owner's ECDSA signature
    /// and closes the wallet account, returning rent to `rent_recipient`.
    #[instruction(discriminator = 3)]
    pub fn close_wallet(
        ctx: Context<CloseWallet>,
        signature: [u8; 64],
        recovery_id: u8,
        nonce: u64,
    ) -> Result<()> {
        instructions::close_wallet::handler(ctx, signature, recovery_id, nonce)
    }
}
