use anchor_lang::prelude::*;
use solana_keccak_hasher::hash as keccak_hash;
use solana_secp256k1_recover::secp256k1_recover;

use crate::error::EcdsaProxyError;

/// Secp256k1 half-order (n/2) for low-S enforcement.
/// n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
/// n/2 = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

pub fn recover_eth_address(
    message_hash: &[u8; 32],
    signature: &[u8; 64],
    recovery_id: u8,
) -> Result<[u8; 20]> {
    let pubkey = secp256k1_recover(message_hash, recovery_id, signature)
        .map_err(|_| error!(EcdsaProxyError::RecoveryFailed))?;

    let pubkey_bytes = pubkey.to_bytes();
    let hash = keccak_hash(&pubkey_bytes);

    let mut eth_address = [0u8; 20];
    eth_address.copy_from_slice(&hash.to_bytes()[12..32]);
    Ok(eth_address)
}

pub fn verify_low_s(signature: &[u8; 64]) -> bool {
    let s = &signature[32..64];
    // Big-endian byte comparison: s <= SECP256K1_HALF_ORDER
    for i in 0..32 {
        if s[i] < SECP256K1_HALF_ORDER[i] {
            return true;
        }
        if s[i] > SECP256K1_HALF_ORDER[i] {
            return false;
        }
    }
    // Equal
    true
}
