# ecdsa-sol-proxy

> [!WARNING]
> This is an example/proof-of-concept and has **not** been audited. Do not use in production.

Solana program that lets Ethereum wallets sign and authorize on-chain transactions. An ETH address owns a PDA — any instruction batch signed by that key is verified on-chain via secp256k1 recovery and executed as CPIs from the PDA.

Built with [Anchor](https://www.anchor-lang.com/) 0.32.

## How it works

### MPC signing (via [Signet](https://docs.sig.network) network)

An EVM wallet requests a signature from the Signet MPC network. The on-chain Solana Program verifies the ECDSA signature, recovers the ETH address, and executes each inner instruction as a CPI from the PDA.

1. **Derive** an ETH address from the MPC network using a derivation path
2. **Initialize** the wallet PDA on Solana with that derived address
3. **Build** inner instructions as indexed references — every account (including program IDs) must be passed in `remaining_accounts`, and inner instructions reference them by `u8` index instead of full pubkeys. This is mandatory to save transaction space (1-byte index vs 32-byte pubkey); the program resolves all accounts from that array at execution time. Compute the message hash over these indexed instructions (see [below](#message-hash))
4. **Request** a signature via `createSignatureRequest(hash, path)` on the Signet `ChainSignatureContract` (Sepolia) — the MPC network produces `(r, s, v)`
5. **Submit** the Solana tx with the signature, nonce, and indexed inner instructions + all referenced accounts in `remaining_accounts`
6. **On-chain** — ECDSA recovery, address comparison, nonce check, CPI dispatch

See the [MPC e2e test](tests/mpc-ecdsa-proxy.ts) for a working example. The test requires Sepolia and Solana devnet credentials via environment variables.

### Message hash

The signed message hash is constructed as:

```
keccak256(
  "\x19Ethereum Signed Message:\n32" ||
  keccak256(chain_id || program_id || nonce ||
            keccak256(remaining_accounts) ||
            keccak256(borsh(inner_instructions)))
)
```

### On-chain verification

1. Assert `nonce == wallet_state.nonce`
2. Reject high-S signatures (malleability)
3. Recompute message hash from tx data
4. `secp256k1_recover(hash, signature, recovery_id)` → pubkey
5. `keccak256(pubkey)[12..]` → recovered ETH address
6. Assert recovered address == `wallet_state.eth_address`
7. Increment nonce
8. `invoke_signed()` each inner instruction with PDA as signer

## Instructions

| Instruction | Discriminator | Description |
|---|---|---|
| `initialize_wallet` | `1` | Creates a PDA (`["ecdsa_proxy", "wallet", eth_address]`) storing the owner's ETH address, nonce, and bump |
| `execute` | `2` | Verifies ECDSA signature, then executes a batch of CPIs with the PDA as signer |
| `close_wallet` | `3` | Signature-gated PDA closure, returns rent to a specified recipient |

Single-byte discriminators (instead of Anchor's default 8-byte) to save transaction space.

## Development

```bash
anchor build              # Build the program
anchor test               # Build + run all tests
npm run check             # Full lint/typecheck suite (rustfmt, clippy, tsc, eslint, knip)
npm run fix               # Auto-fix formatting
```

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
├── ecdsa-proxy.ts          # Integration tests (local key)
├── mpc-ecdsa-proxy.ts      # Integration tests (MPC signing via Sepolia)
└── helpers/
    ├── evm-signer.ts       # TypeScript signing (mirrors on-chain hashing)
    └── mpc-signer.ts       # MPC signer using signet.js ChainSignatureContract
```

## License

MIT
