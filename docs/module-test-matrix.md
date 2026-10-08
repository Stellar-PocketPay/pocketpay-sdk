# SDK Module Test Matrix

This matrix tells contributors **which tests are expected** when changing a
major PocketPay SDK module. Use it when writing or reviewing a PR so behaviour
is not shipped without unit, fixture, integration, or error-path coverage.

> **Companion docs:** [testing.md](./testing.md) (unit vs integration lanes),
> [Meaningful Change Review](./meaningful-change-review.md),
> [Contribution Quality Gate](./contribution-quality-gate.md).

## How to read the matrix

| Column | Meaning |
| :--- | :--- |
| **Unit** | Required offline Vitest coverage in `tests/**/*.test.ts` |
| **Fixtures** | Prefer shared data under `tests/fixtures/` over one-off hardcoding |
| **Error paths** | Invalid inputs, typed `PocketPayError` codes, and failure mapping |
| **Integration** | Opt-in `*.integration.test.ts` with `RUN_INTEGRATION=1` when live network behaviour is in scope |

Legend: **R** = required for behaviour changes · **S** = strongly recommended · **O** = optional / when touching live network paths · **—** = usually N/A

---

## Test types (expectations)

### Unit tests (default — always offline)

```bash
npm test
```

- Mock Horizon / Friendbot / Soroban (`vi.mock`, `setHorizonServerFactory`, or stubbed `fetch`).
- The offline guard (`tests/setup/offline-guard.ts`) fails any un-mocked network call.
- Assert **return values** and **typed errors** (`PocketPayError` + `.code` / `.validation`), not message text alone.

### Integration tests (opt-in)

```bash
RUN_INTEGRATION=1 npm run test:integration
```

- Live Testnet only when proving end-to-end funding, Horizon, or Soroban behaviour.
- Never put live-network assertions in the default unit suite.

### Fixtures

- Reuse `tests/fixtures/accounts.ts`, `payments.ts`, `transactions.ts`, etc.
- Add new fixtures when a shape is reused across tests (Horizon 404, result codes, funded balances).

### Error-path testing

For every public helper that validates input or talks to the network, cover at least:

1. **Invalid input** — bad keys, amounts, memos, asset specs (sync, no network).
2. **Typed failure** — `expects.toMatchObject({ code: '…' })` or `error.code`.
3. **Network / submission failure** — 404, timeout, Horizon result codes, generic wrap (`SEND_ERROR`, etc.) when the module submits or loads accounts.
4. **No network on validation failure** — assert mocks were not called.

---

## Module matrix

### 1. Wallet (`src/wallet/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| `createWallet` / key shape | R | O | — | — |
| `importWallet` / `safeImportWallet` | R | O | R | — |
| Enhanced import wrappers | S | O | R | — |
| Secret validation / export boundaries | R | O | R | — |
| Multi-asset wallet helpers | S | S | S | O |

**Primary tests today:** `tests/wallet.test.ts`, `tests/multi-asset-balance.test.ts`, `tests/fund.test.ts` (funding-related), `tests/balance.test.ts`

**Must cover when changing wallet:**

- Valid keypair generation (`G…` / `S…` format).
- Invalid secret import → `INVALID_SECRET_KEY` (typed).
- Safe / enhanced wrappers never throw; return `ok: false` with `PocketPayError`.
- No secrets logged or asserted by printing full secret keys in failures.

---

### 2. Payments (`src/payments/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| `sendXLM` / `sendAsset` happy path | R | S | — | O |
| Preflight validation | R | O | R | — |
| Trustline / destination checks | R | S | R | O |
| Preview / receipts | S | S | S | — |
| Transaction readiness (`checkTransactionReadiness`) | R | S | R | — |
| Submission / Horizon mapping | R | R | R | O |

**Primary tests today:** `tests/payments.test.ts`, `tests/payments-error-paths.test.ts`, `tests/payments-validation.test.ts`, `tests/payments-preview.test.ts`, `tests/trustline.test.ts`, `tests/destination-validation.test.ts`, `tests/payment-receipt.test.ts`, `tests/memo-validation.test.ts`, `tests/transaction-readiness.test.ts`

**Must cover when changing payments:**

- Invalid destination, amount, memo, asset, self-payment.
- Trustline failures (`MISSING_TRUSTLINE`, `UNFUNDED_DESTINATION`, etc.).
- Network failures (`ACCOUNT_NOT_FOUND`, `PAYMENT_FAILED`, `REQUEST_TIMEOUT`, `TX_STATUS_UNKNOWN`, `SEND_ERROR`).
- Fixtures: `makeHorizon404Error`, `makeHorizonResultCodeError` in `tests/fixtures/payments.ts`.

---

### 3. Transactions (`src/transactions/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| History fetch / mapping | R | R | R | O |
| Filter / sort helpers | R | S | S | — |
| Polling / status | R | S | R | O |
| Offline prep / inspect / auth | R | S | R | — |
| Build validation | R | S | R | — |

**Primary tests today:** `tests/transactions.test.ts`, `tests/filterTransactions.test.ts`, `tests/sortTransactionsByDate.test.ts`, `tests/polling.test.ts`, `tests/signed-transaction-inspection.test.ts`, `tests/auth-requirements.test.ts`, `tests/build-validation.test.ts`, `tests/transaction-authorization.test.ts`, `tests/transactionFixtures.test.ts`

**Must cover when changing transactions:**

- Invalid public key before network.
- Horizon 404 / timeout mapping.
- Mapper preserves SDK-owned summary fields (not raw Horizon leakage).
- Fixture-backed pages in `tests/fixtures/transactions.ts`.

---

### 4. Vault / Soroban helpers (`src/vault/`, `src/soroban/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| Deposit / withdraw / balance wrappers | R | O | R | O |
| Capability / feature gates | R | O | R | — |
| Simulation / mapper / client factory | R | O | R | O |
| Contract ID / config resolution | R | O | R | — |

**Primary tests today:** `tests/vault.test.ts`, `tests/vault-capabilities.test.ts`, `tests/sorobanMapper.test.ts`, `tests/contract-client-factory.test.ts`, `tests/unsupported-feature.test.ts`

**Must cover when changing vault helpers:**

- Missing / invalid contract ID → typed capability / config errors.
- Simulation or submission failure mapping (no raw RPC dumps with secrets).
- Feature-flag / unsupported paths when flags disable vault ops.
- Live Soroban calls only in integration tests, not unit tests.

---

### 5. Config (`src/config/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| `resolveConfig` / defaults | R | O | R | — |
| Config validation | R | O | R | — |
| Feature flags / registry | R | O | R | — |
| Network URL / timeout overrides | R | O | R | — |

**Primary tests today:** `tests/config.test.ts`, `tests/config-validation.test.ts`, `tests/feature-flags.test.ts`, `tests/feature-flag-registry.test.ts`, `tests/env.test.ts`

**Must cover when changing config:**

- Invalid timeout / network / feature-flag values throw or return structured validation errors.
- Source metadata / defaults documented by assertions.
- Env overrides do not leak secrets into logs or error messages.

---

### 6. Utils (`src/utils/`)

| Area | Unit | Fixtures | Error paths | Integration |
| :--- | :---: | :---: | :---: | :---: |
| Amount / stroop helpers | R | O | R | — |
| Memo validation / build | R | O | R | — |
| Key / hash validators | R | O | R | — |
| Explorer / env helpers | S | O | S | — |
| Result wrappers (`toResult`, etc.) | R | O | R | — |

**Primary tests today:** `tests/utils.test.ts`, `tests/safe-amount.test.ts`, `tests/memo-validation.test.ts`, `tests/explorer.test.ts`, `tests/env.test.ts`, `tests/result.test.ts`, `tests/enhanced-result.test.ts`

**Must cover when changing utils:**

- Boundary amounts (zero, precision, non-decimal).
- Memo too long / wrong type → `TX_INVALID_MEMO` (or documented code).
- Validators throw typed errors; safe wrappers never throw.

---

## Cross-cutting modules (brief)

| Module | Unit focus | Error paths |
| :--- | :--- | :--- |
| `src/errors/` | Code registry, taxonomy, classify helpers | Unknown codes, retryability |
| `src/network/` | Timeout, retry, idempotency | `REQUEST_TIMEOUT`, `TX_STATUS_UNKNOWN` |
| `src/account/` | Sequence / signer safety | Stale sequence, auth mismatch |
| `src/diagnostics/` | Redaction hooks | No secrets in emitted events |

---

## Examples of good tests

### Example 1 — Typed wallet validation error

```ts
it('rejects a non-string secret with INVALID_SECRET_KEY', () => {
  expect(() => validateSecretKey(12345 as any)).toThrow(PocketPayError);
  try {
    validateSecretKey(12345 as any);
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_SECRET_KEY',
      validation: { field: 'secretKey', reason: 'not_a_string' },
    });
  }
});
```

### Example 2 — Payment error path with Horizon fixture (no live network)

```ts
it('maps Horizon result codes on submission to PAYMENT_FAILED', async () => {
  mockLoadAccount.mockResolvedValueOnce(await sourceAccountFor(sender.publicKey));
  mockSubmitTransaction.mockRejectedValue(
    makeHorizonResultCodeError('tx_insufficient_balance', ['op_underfunded']),
  );

  await expect(
    sendXLM({
      sourceSecret: sender.secretKey,
      destination: receiver.publicKey,
      amount: '10',
    }),
  ).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
});
```

See `tests/payments-error-paths.test.ts` for the full matrix of destination,
amount, asset, timeout, and submission failures.

### Example 3 — Config validation (sync, no network)

```ts
it('rejects a non-positive timeout', () => {
  expect(() => resolveConfig({ timeout: 0 })).toThrow(PocketPayError);
});
```

### Example 4 — Integration test shape (opt-in only)

```ts
// tests/friendbot.integration.test.ts
describe.runIf(process.env.RUN_INTEGRATION === '1')('Friendbot funding', () => {
  it('funds a new Testnet account', async () => {
    // live network — never import this pattern into default unit tests
  });
});
```

---

## Contributor checklist (before opening a PR)

- [ ] Identified the owning module(s) in the matrix above
- [ ] Added or updated **unit** tests for behaviour changes
- [ ] Added **error-path** coverage for validation / network failures
- [ ] Used or extended **fixtures** instead of hardcoding Horizon payloads
- [ ] Kept unit tests **offline**; used integration lane only if needed
- [ ] Ran `npm test` (and `npm run presubmit` before push)

---

## Related links

- [testing.md](./testing.md) — lanes and scripts
- [FIXTURES.md](./FIXTURES.md) — fixture conventions (if present)
- [error-handling.md](./error-handling.md) — `PocketPayError` patterns
- [CONTRIBUTING.md](../CONTRIBUTING.md) — writing tests section
