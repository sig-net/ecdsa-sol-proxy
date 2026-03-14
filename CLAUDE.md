# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Full lint/typecheck suite (run before completing any task)
npm run check          # rustfmt:check + clippy + typecheck + lint + knip

# Auto-fix formatting and linting
npm run fix            # rustfmt + lint:fix

# Build the Solana program
anchor build

# Run all tests (compiles program + runs ts-mocha suite)
anchor test

# Run a single test file
npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/ecdsa-proxy.ts"

# Individual checks
npm run clippy         # cargo clippy -D warnings
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint + Prettier check
npm run knip           # Unused dependency detection
```

## Architecture

Solana Anchor program that lets Ethereum ECDSA signatures authorize on-chain transactions. An Ethereum wallet owner can sign messages off-chain, and the program verifies those signatures to execute arbitrary CPIs on their behalf.

### Program Instructions (`programs/ecdsa-proxy/src/instructions/`)

- **initialize_wallet** — Creates a PDA (`[b"ecdsa_proxy", b"wallet", eth_address]`) storing the owner's 20-byte Ethereum address, a nonce, and the bump seed.
- **execute** — Core dispatch: validates nonce, verifies ECDSA signature (with low-S malleability check), recovers the Ethereum address, then executes a batch of inner CPIs with the PDA as signer.
- **close_wallet** — Signature-gated PDA closure that returns rent.

### Cryptographic Flow (`ecdsa.rs`, `message.rs`)

Message hash construction: inner instructions and remaining account pubkeys are each keccak256-hashed, combined with chain_id + program_id + nonce into a 112-byte payload, hashed again, then wrapped with EIP-191 prefix (`\x19Ethereum Signed Message:\n32`) and final keccak256. The recovered address (last 20 bytes of keccak256(secp256k1_pubkey)) must match the wallet's stored `eth_address`.

### Transaction Size Optimization

Inner instructions use **index-based** account references (`program_id_index: u8`, `account_index: u8` into `remaining_accounts`) instead of full 32-byte pubkeys. Account flags (`is_signer`, `is_writable`) are packed into a single `flags: u8` (bit 0 = signer, bit 1 = writable).

### Test Helpers (`tests/helpers/evm-signer.ts`)

The TypeScript signing helpers must produce hashes identical to the on-chain `message.rs` logic. Key functions: `signMessage`, `computeInnerHash`, `toIndexedInnerInstructions`, `buildRemainingAccounts`. Changes to on-chain hashing must be mirrored here and vice versa.
