# Test File Review: `tests/ecdsa-proxy.ts`

## 1. Error Handling (HIGH)

All 4 agents flagged this as the top issue.

### Problem

The try/catch + `expect.fail()` + `String(err).includes(...)` pattern is fragile and non-idiomatic for Anchor.

- **Test 2 (line 133-135)** is the worst offender — it only asserts `err !== undefined`, which passes for *any* error (network timeout, serialization bug, etc.).
- The remaining error tests use loose string matching on `String(err)` rather than structured Anchor error inspection.
- If `expect.fail()` is accidentally removed during a refactor, the test silently passes.

### Recommendation

Anchor exports `AnchorError` with structured properties. The official Anchor test suite (`tests/errors/` in the Anchor repo) uses:

```typescript
import { AnchorError } from "@coral-xyz/anchor";

try {
  await program.methods.someMethod().rpc();
  assert.ok(false);
} catch (_err) {
  assert.isTrue(_err instanceof AnchorError);
  const err = _err as AnchorError;
  assert.strictEqual(err.error.errorCode.code, "NonceMismatch");
  assert.strictEqual(err.error.errorCode.number, 6001);
  assert.strictEqual(err.program.toString(), program.programId.toString());
}
```

Alternatively, `chai-as-promised` with `.to.be.rejectedWith()` eliminates the try/catch entirely.

**Affected tests:** 2, 5, 6, 7, 8, 9, 12, 15

---

## 2. Security Test Coverage — Significant Gaps (HIGH)

### CRITICAL — Missing Tests

| Missing Test | Risk |
|---|---|
| Account substitution — no test swaps `remaining_accounts` after signing to verify hash binding works | Attacker could redirect funds |
| `close_wallet` nonce check — never tested (only `execute` nonce is tested) | Unauthorized close with stale sig |
| `close_wallet` malleability — high-S check exists on-chain but is never tested | High-S bypass on close |

### HIGH — Missing Tests

| Missing Test | Risk |
|---|---|
| Invalid `recovery_id` (2, 255) — `InvalidRecoveryId` error variant is defined but never triggered | Unexpected recovery behavior |
| Empty inner instructions on `execute` — untested hash path | Nonce burn / griefing |
| Cross-program replay (wrong `program_id` in hash) — never verified | Replay across deployments |

### MEDIUM — Missing Tests

| Missing Test | Risk |
|---|---|
| Out-of-bounds `account_index` / `program_id_index` — `InvalidAccountIndex` error never triggered | Error path unverified |
| Zero `eth_address` initialization — permanently locked wallet | Rent waste |
| Close-then-replay-close | Double-close |

---

## 3. DRY — Repetition (MEDIUM)

The `program.methods.execute(...)` call is repeated **9 times** with near-identical structure. A helper like `executeOnChain(sig, recoveryId, nonce, indexed, remaining)` would reduce each to one line.

The "build ix -> build remaining -> get nonce -> sign" setup pattern (~6 lines each time) could also be a single `prepareAndSign(wallet, innerIxs, pda)` helper.

---

## 4. Test Isolation (MEDIUM)

All tests are **strictly order-dependent** (e.g., test 14 depends on test 13 which depends on test 11). This is inherent to on-chain integration tests but:

- The shared mutable `pdaTokenAccount` is set in test 3 and silently reused in 10 later tests with no comment.
- Grouping into nested `describe` blocks (`describe("initialize")`, `describe("execute")`, `describe("close")`) would improve readability.

---

## 5. Numeric Precision — Latent Risk (LOW)

`Number()` wrapping of `bigint` token amounts (lines 174, 212, 448, 565) is safe for current small values but would silently break for amounts > `Number.MAX_SAFE_INTEGER`. Direct bigint comparison is safer:

```typescript
expect(recipientAccount.amount).to.equal(transferAmount);
```

Same issue with nonce comparisons (lines 213, 450, 540, 566) — should use native bigint arithmetic:

```typescript
expect(await getNonce(walletPDA)).to.equal(nonce + 1n);
```

---

## 6. Naming & Style (LOW)

- **Numbered test names** ("1.", "2.") are fragile — inserting a test forces renumbering. The descriptions are already self-documenting.
- **`chainId` constant** (line 81) is declared but most tests hardcode `{ mainnet: {} }` inline instead — inconsistent.
- `expect(accountInfo).to.equal(null)` -> `.to.be.null` is more idiomatic Chai.

---

## 7. What's Done Well

- Helper functions (`signAndIndex`, `buildTokenTransferIx`, `getNonce`) are clean and well-named.
- `before()` over `beforeEach()` is the right call for sequential on-chain tests.
- No `any` types, no flaky patterns (no polling, timeouts, or wall-clock reliance).
- Anchor API usage (`.accounts()`, `.remainingAccounts()`, `BN`, SPL token helpers) is all current and correct for Anchor 0.32.x.
- Core happy paths and the most obvious `execute` attack vectors are well covered.

---

## 8. Anchor SDK Note

The Anchor TS package is being renamed from `@coral-xyz/anchor` to `@anchor-lang/core` (both at 0.32.1 on npm). No action needed now, but worth monitoring for future upgrades.
