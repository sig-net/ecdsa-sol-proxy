# ecdsa-sol-proxy

> [!WARNING]
> This is an example/proof-of-concept and has **not** been audited. Do not use in production.

Solana program that lets Ethereum wallets sign and authorize on-chain transactions. An ETH address owns a PDA — any instruction batch signed by that key is verified on-chain via secp256k1 recovery and executed as CPIs from the PDA.

Built with [Anchor](https://www.anchor-lang.com/) 0.32.

## How it works

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Off-chain (Client)                                                      │
│                                                                          │
│  1. Build inner instructions (SPL transfers, swaps, etc.)                │
│  2. Compute message hash:                                                │
│       keccak256(                                                         │
│         "\x19Ethereum Signed Message:\n32" ||                            │
│         keccak256(chain_id || program_id || nonce ||                     │
│                   keccak256(remaining_accounts) ||                       │
│                   keccak256(borsh(inner_instructions)))                  │
│       )                                                                  │
│  3. Sign with ETH private key → (signature, recovery_id)                │
│  4. Submit Solana tx with signature + indexed inner instructions         │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  On-chain (Solana Program)                                               │
│                                                                          │
│  1. Assert nonce == wallet_state.nonce                                   │
│  2. Reject high-S signatures (malleability)                              │
│  3. Recompute message hash from tx data                                  │
│  4. secp256k1_recover(hash, signature, recovery_id) → pubkey            │
│  5. keccak256(pubkey)[12..] → recovered ETH address                     │
│  6. Assert recovered address == wallet_state.eth_address                 │
│  7. Increment nonce                                                      │
│  8. invoke_signed() each inner instruction with PDA as signer            │
└──────────────────────────────────────────────────────────────────────────┘
```

## Instructions

| Instruction | Discriminator | Description |
|---|---|---|
| `initialize_wallet` | `1` | Creates a PDA (`["ecdsa_proxy", "wallet", eth_address]`) storing the owner's ETH address, nonce, and bump |
| `execute` | `2` | Verifies ECDSA signature, then executes a batch of CPIs with the PDA as signer |
| `close_wallet` | `3` | Signature-gated PDA closure, returns rent to a specified recipient |

Single-byte discriminators (instead of Anchor's default 8-byte) to save transaction space.

## Replay protection

Three independent layers prevent signature reuse:

- **Chain ID** — hardcoded in the message hash; blocks cross-cluster replay
- **Program ID** — binds signatures to this specific deployment
- **Nonce** — monotonic counter incremented after each `execute`; blocks same-chain replay

## Transaction size optimization

Inner instructions use index-based account references into `remaining_accounts` instead of full 32-byte pubkeys. Account flags (`is_signer`, `is_writable`) are bit-packed into a single `u8`.

```rust
struct InnerAccountMeta {
    account_index: u8,  // index into remaining_accounts
    flags: u8,          // bit 0 = signer, bit 1 = writable
}
```

## Development

```bash
anchor build              # Build the program
anchor test               # Build + run all tests
npm run check             # Full lint/typecheck suite (rustfmt, clippy, tsc, eslint, knip)
npm run fix               # Auto-fix formatting
```

### Test coverage

The test suite validates: wallet initialization, SPL token transfers via PDA, replay rejection, wrong-signer rejection, nonce mismatch, chain ID binding, signature malleability rejection, batched inner instructions, instruction tampering detection, and wallet closure.

## Project structure

```
programs/ecdsa-proxy/src/
├── lib.rs                  # Entry point, instruction dispatch
├── constants.rs            # Seeds, chain ID
├── error.rs                # Error codes
├── ecdsa.rs                # secp256k1 recovery + low-S check
├── message.rs              # Message hash construction (EIP-191)
├── state/mod.rs            # WalletState account (20B addr + u64 nonce + u8 bump)
└── instructions/
    ├── initialize_wallet.rs
    ├── execute.rs
    └── close_wallet.rs

tests/
├── ecdsa-proxy.ts          # Integration tests
└── helpers/evm-signer.ts   # TypeScript signing (mirrors on-chain hashing)
```

## License

MIT
