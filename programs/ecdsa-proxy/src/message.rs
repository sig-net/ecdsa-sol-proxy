use anchor_lang::prelude::*;
use solana_keccak_hasher::hash as keccak_hash;
use solana_keccak_hasher::hashv as keccak_hashv;

use crate::constants::CHAIN_ID;
use crate::error::EcdsaProxyError;
use crate::InnerInstruction;

/// Replay protection: `CHAIN_ID` (hardcoded) binds the signature to a specific
/// cluster, `program_id` binds it to this deployment so it can't be replayed on
/// a cloned program, and `nonce` prevents reuse on the same program+chain.
pub fn compute_message_hash(
    program_id: &Pubkey,
    nonce: u64,
    remaining_account_keys: &[Pubkey],
    inner_instructions: &[InnerInstruction],
) -> Result<[u8; 32]> {
    let mut instructions_data = Vec::new();
    for ix in inner_instructions {
        ix.serialize(&mut instructions_data)
            .map_err(|_| error!(EcdsaProxyError::SerializationFailed))?;
    }
    let instructions_hash = keccak_hash(&instructions_data);

    let account_slices: Vec<&[u8]> = remaining_account_keys.iter().map(|k| k.as_ref()).collect();
    let accounts_hash = keccak_hashv(&account_slices);

    // chain_id(8) || program_id(32) || nonce(8) || accounts_hash(32) || instructions_hash(32) = 112
    let mut inner_data = [0u8; 112];
    inner_data[0..8].copy_from_slice(&CHAIN_ID.to_le_bytes());
    inner_data[8..40].copy_from_slice(&program_id.to_bytes());
    inner_data[40..48].copy_from_slice(&nonce.to_le_bytes());
    inner_data[48..80].copy_from_slice(&accounts_hash.to_bytes());
    inner_data[80..112].copy_from_slice(&instructions_hash.to_bytes());
    let inner_hash = keccak_hash(&inner_data);

    // EIP-191 prefix wrapping
    let mut eip191_data = [0u8; 60];
    eip191_data[0..28].copy_from_slice(b"\x19Ethereum Signed Message:\n32");
    eip191_data[28..60].copy_from_slice(&inner_hash.to_bytes());
    Ok(keccak_hash(&eip191_data).to_bytes())
}
