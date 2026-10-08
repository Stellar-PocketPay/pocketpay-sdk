# SDK Fixture Framework

## Overview

The fixture framework provides deterministic, reusable test fixtures for SDK integration tests.

## Why Use Fixtures?

- **Deterministic**: Same data every time
- **Reusable**: Share across tests
- **Type-safe**: Full TypeScript support
- **Composable**: Build complex fixtures from simple ones

## Payment-flow integration scenarios (GrantFox #448)

Import `paymentFlowFixtures` from `tests/fixtures` to reuse six *local,
deterministic* scenarios: `nativeSuccess`, `issuedSuccess` (USDC with an issuer),
`invalidRecipient`, `insufficientFunds`, `networkFailure`, and `pending`.
Each scenario has an account, typed SDK payment-intent input, payment record,
transaction preview, network response and a simulated receipt.

All four account/payment/transaction/vault builders use
`2024-01-15T10:30:00.000Z` as their default `createdAt` and `updatedAt`
timestamp instead of wall-clock time. Builders can still override either field
with `.set('createdAt', new Date(...))` when a test explicitly needs time
variation. Each new builder starts from separate fixture objects.

The public Stellar account IDs and issued-asset issuer here are deterministic
test inputs; no private seed, signing key, wallet credential or real network
operation is stored in these scenario fixtures. The example hash and receipt
are simulated outcomes, **not** proof that a transaction was broadcast or
confirmed. Likewise `insufficientFunds` is a fixture for a downstream
balance-check response; the SDK's pure `createPaymentIntent` preflight does
not query ledger balances.

```ts
import { paymentFlowFixtures } from './fixtures';
import { createPaymentIntent } from '../src/payments/intent';

const { issuedSuccess, invalidRecipient, networkFailure } = paymentFlowFixtures;
const valid = createPaymentIntent(issuedSuccess.input);
const invalid = createPaymentIntent(invalidRecipient.input);

expect(valid.validationResult?.valid).toBe(true);
expect(invalid.validationResult?.valid).toBe(false);
expect(networkFailure.network.status).toBe(503);
```

The focused `tests/payment-integration-fixtures.test.ts` consumes these
scenarios through real SDK preflight logic without network dependencies.

## Available Fixtures

### Accounts
- `valid`: A valid, funded account
- `empty`: An account with no balance
- `lowBalance`: An account with a small balance
- `highBalance`: An account with a large balance
- `notFound`: An account that does not exist
- `pending`: An account with a pending transaction
- `frozen`: A frozen account

### Payments
- `success`: A successful payment
- `pending`: A pending payment
- `failed`: A failed payment
- `withMemo`: A payment with a memo
- `usdc`: A USDC payment

### Transactions
- `success`: A successful transaction
- `pending`: A pending transaction
- `failed`: A failed transaction
- `withMemo`: A transaction with memo

### Network
- `success`: A successful network response
- `timeout`: A network timeout
- `serverError`: A 500 error
- `notFound`: A 404 error
- `forbidden`: A 403 error
- `rateLimited`: A 429 error

### Soroban
- `success`: A successful contract call
- `error`: A contract call with error
- `timeout`: A contract call timeout
- `unsupported`: An unsupported feature call

### Vault
- `success`: A successful vault operation
- `pending`: A pending vault operation
- `failed`: A failed vault operation
- `lock`: A lock operation
- `unlock`: An unlock operation

## Usage Examples

### Basic Usage

```typescript
import { accountFixtures, paymentFixtures } from '../fixtures';

describe('Account tests', () => {
  it('should handle valid account', () => {
    const account = accountFixtures.valid;
    expect(account.balance).toBe('1000.00');
  });

  it('should handle empty account', () => {
    const account = accountFixtures.empty;
    expect(account.balance).toBe('0.00');
  });
});
import { AccountBuilder } from '../fixtures/builders';

describe('Custom account tests', () => {
  it('should create custom account', () => {
    const account = new AccountBuilder()
      .withId('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890')
      .withBalance('500.00')
      .withSequence(123456789)
      .build();
    
    expect(account.balance).toBe('500.00');
  });
});
import { accountFixtures, paymentFixtures } from '../fixtures';

describe('Integration tests', () => {
  it('should handle full flow', () => {
    const sender = accountFixtures.valid;
    const payment = paymentFixtures.success;
    
    expect(sender.balance).toBe('1000.00');
    expect(payment.from).toBe(sender.id);
  });
});
// tests/fixtures/my-domain/my-builder.ts
export class MyBuilder extends FixtureBuilder<MyFixture> {
  // Implement builder methods
}
// tests/fixtures/my-domain/my-fixtures.ts
export const myFixtures = {
  valid: new MyBuilder().build(),
  error: new MyBuilder().withError('error').build(),
};
// tests/fixtures/my-domain/index.ts
export * from './my-fixtures';
export * from './my-builder';
// tests/fixtures/index.ts
export * from './my-domain';
const account = await getAccount('G...');
expect(account.balance).toBeDefined();
const account = accountFixtures.valid;
expect(account.balance).toBe('1000.00');
export class MyBuilder extends FixtureBuilder<MyFixture> {
  constructor() {
    super();
    this.data = {
      id: 'default_id',
      name: 'default_name',
    };
  }

  withId(id: string): this {
    this.data.id = id;
    return this;
  }

  // ... other builder methods

  build(): MyFixture {
    return {
      id: this.data.id!,
      name: this.data.name!,
    };
  }
}
export const myFixtures = {
  valid: new MyBuilder().build(),
  error: new MyBuilder().withId('error').build(),
};
// tests/fixtures/my-domain/index.ts
export * from './my-fixtures';
export * from './my-builder';
