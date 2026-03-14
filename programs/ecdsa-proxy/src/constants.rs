pub const WALLET_SEED: &[u8] = b"ecdsa_proxy";
pub const WALLET_PREFIX: &[u8] = b"wallet";

/// Devnet = 2. Hardcoded so callers cannot bypass cross-cluster replay protection.
pub const CHAIN_ID: u64 = 2;
