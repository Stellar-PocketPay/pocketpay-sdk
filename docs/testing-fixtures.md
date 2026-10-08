# Transaction Testing Fixtures

Testing transaction flows involving offline preparation, signing, and network submission can be complex and prone to flakiness if reliant on live network dependencies (like fetching sequences or fee statistics). 

To ensure SDK stability and provide consumers with reliable tools for their own testing, the PocketPay SDK exports deterministic fixture generators.

## Why Use Deterministic Fixtures?
- **No Network Calls**: Fixture generation is entirely offline. No calls are made to Horizon.
- **Repeatable State**: Timebounds, sequence numbers, and base fees are hardcoded. Tests will not break due to the passage of time or sequence advancement.
- **Type Safety**: The generators return the exact interfaces used by the SDK (`PreparedTransaction`, `SignedTransaction`, etc.) or construct real `StellarSDK.Transaction` objects so that internal assertions pass perfectly.

## Available Generators

All fixture generators are exported from `src/transactions/index.ts`.

### 1. `createPreparedTransactionFixture`
Simulates a transaction that has completed the offline preparation phase (`fetchNetworkState`) and is ready to be built.

```typescript
import { createPreparedTransactionFixture } from 'stellar-pocketpay-sdk';

const prepared = createPreparedTransactionFixture({
  baseFee: '500' // You can override any field
});

console.log(prepared.readyToBuild); // true
console.log(prepared.timebounds); // Deterministic timebounds
```

### 2. `createUnsignedTransactionFixture`
Simulates a transaction that has been built into a `StellarSDK.Transaction` but has not yet been signed.

```typescript
import { createUnsignedTransactionFixture } from 'stellar-pocketpay-sdk';

const unsigned = createUnsignedTransactionFixture({
  memo: 'Testing offline'
});

// Provides access to a real StellarSDK.Transaction instance
console.log(unsigned.transaction.memo.value.toString()); // "Testing offline"
```

### 3. `createSignedTransactionFixture`
Simulates a transaction that has been signed with a keypair. The SDK uses a deterministic dummy key to produce a valid signature format over the deterministic payload.

```typescript
import { createSignedTransactionFixture } from 'stellar-pocketpay-sdk';

// Pass a specific secret key if you want to test your own validation logic
const signed = createSignedTransactionFixture('SBU24Y4P...');

console.log(signed.xdr); // Base64 encoded XDR envelope
```

### 4. `createSubmissionResultFixture`
Simulates the outcome of `submitSignedTransaction` without actually broadcasting to the network.

```typescript
import { createSubmissionResultFixture } from 'stellar-pocketpay-sdk';

const success = createSubmissionResultFixture('success');
const failure = createSubmissionResultFixture('failed');
const unknown = createSubmissionResultFixture('unknown');

// Useful for mocking the submission layer in tests
```

## Best Practices
When writing tests for your PocketPay integration, use `vi.mock` or `jest.mock` on the network submission and preparation layers, and use these fixtures as the resolved return values. This effectively stubs out Horizon, ensuring your business logic operates deterministically against valid transaction payloads.

## Test-only cross-domain scenario builders (issue #318)

The existing public transaction-envelope generators above remain unchanged.
For SDK integration tests, the **test-only** framework under
[`tests/fixtures/README.md`](../tests/fixtures/README.md) provides fixed-clock
account/payment/transaction/network/Soroban/vault fixtures and correlated
`success`, `failure`, `timeout`, `unsupported` and `unknown` scenarios.
It also supplies `createFetchFromFixture` to exercise the production
`NetworkClient` without contacting Horizon. Use fresh builders/scenarios
rather than mutating exported singletons; mock cleanup stays local to tests.
