use anchor_lang::prelude::*;

#[error_code]
pub enum EcdsaProxyError {
    #[msg("ECDSA signature recovery failed")]
    RecoveryFailed,
    #[msg("Recovered address does not match wallet")]
    AddressMismatch,
    #[msg("Nonce mismatch")]
    NonceMismatch,
    #[msg("Malleable signature: S value is too high")]
    SignatureMalleability,
    #[msg("Invalid recovery ID")]
    InvalidRecoveryId,
    #[msg("Invalid signature length")]
    InvalidSignatureLength,
    #[msg("Account index out of bounds")]
    InvalidAccountIndex,
    #[msg("Failed to serialize inner instruction")]
    SerializationFailed,
}
