# Destination Account Validation

## Overview

The Stellar PocketPay SDK provides a comprehensive destination account validation strategy for payment flows. This strategy defines clear boundaries between **local validation** (synchronous, no network calls) and **network validation** (asynchronous, Horizon queries), allowing developers to choose the appropriate level of validation for their use case.

## Validation Strategy

### Local Validation (Synchronous)

Local validation performs fast, synchronous checks without making any network calls. These checks are ideal for:

- Form validation in UIs
- Pre-flight checks before user confirmation
- Batch validation of multiple destinations
- Scenarios where network latency is unacceptable

**Local validation checks:**
- Address format validation (G... public key shape)
- Address checksum validation (Ed25519 public key verification)
- Self-payment detection (when source is available)
- Basic asset specification format validation

### Network Validation (Asynchronous)

Network validation performs comprehensive checks by querying the Stellar Horizon server. These checks are ideal for:

- Final validation before payment submission
- Critical payment flows where failure is unacceptable
- Scenarios requiring account existence verification
- Trustline validation for issued assets

**Network validation checks:**
- Account existence (is the account funded?)
- Account status verification (is the account active?)
- Trustline verification for issued assets
- Trustline authorization status
- Trustline capacity checks (when amount is provided)

## Usage

### Basic Local Validation

```typescript
import { validateDestinationLocal } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';

const result = validateDestinationLocal(destination);

if (result.valid) {
  console.log('Destination address is valid');
} else {
  console.error(`Validation failed: ${result.message}`);
  console.error(`Error code: ${result.errorCode}`);
}
```

### Local Validation with Self-Payment Detection

```typescript
import { validateDestinationLocal } from '@stellar/pocketpay-sdk';

const sourcePublicKey = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';
const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';

const result = validateDestinationLocal(destination, {
  sourcePublicKey,
});

if (result.status === 'self_payment') {
  console.error('Cannot send payment to yourself');
}
```

### Network Validation

```typescript
import { validateDestinationNetwork } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';

const result = await validateDestinationNetwork(destination);

if (result.valid) {
  console.log('Destination account exists and is active');
  console.log(`Sequence: ${result.metadata?.sequence}`);
} else {
  console.error(`Validation failed: ${result.message}`);
  
  if (result.status === 'account_not_found') {
    console.error('Account is unfunded - recipient needs to create account first');
  }
}
```

### Network Validation with Trustline Check

```typescript
import { validateDestinationNetwork } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';
const asset = { code: 'USDC', issuer: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7' };

const result = await validateDestinationNetwork(destination, {
  asset,
});

if (result.valid) {
  console.log('Destination has valid trustline');
  console.log(`Current balance: ${result.metadata?.currentBalance}`);
  console.log(`Available capacity: ${result.metadata?.availableCapacity}`);
} else if (result.status === 'missing_trustline') {
  console.error('Destination does not have a trustline for this asset');
}
```

### Network Validation with Capacity Check

```typescript
import { validateDestinationNetwork } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';
const asset = { code: 'USDC', issuer: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7' };
const amount = '100';

const result = await validateDestinationNetwork(destination, {
  asset,
  amount,
});

if (result.valid) {
  console.log('Payment amount is within trustline capacity');
} else if (result.status === 'trustline_limit_exceeded') {
  console.error(`Payment exceeds available capacity: ${result.metadata?.availableCapacity}`);
}
```

### Complete Validation (Local + Network)

```typescript
import { validateDestinationComplete } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';

// Performs both local and network validation
const result = await validateDestinationComplete(destination);

if (result.valid) {
  console.log('Destination passed all validation checks');
}
```

### Validation Level Control

```typescript
import { validateDestinationComplete } from '@stellar/pocketpay-sdk';

const destination = 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7';

// Local-only validation (no network calls)
const localResult = await validateDestinationComplete(destination, {
  level: 'local',
});

// Network-only validation (includes local as prerequisite)
const networkResult = await validateDestinationComplete(destination, {
  level: 'network',
});

// Complete validation (default)
const completeResult = await validateDestinationComplete(destination, {
  level: 'complete',
});
```

### Throwing Validation Helper

```typescript
import { validateDestinationOrThrow } from '@stellar/pocketpay-sdk';

try {
  const result = await validateDestinationOrThrow(destination, {
    asset: { code: 'USDC', issuer: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7' },
  });
  console.log('Validation passed');
} catch (error) {
  if (error.code === 'UNFUNDED_DESTINATION') {
    console.error('Destination account is not funded');
  }
}
```

### Safe (Non-Throwing) Wrappers

```typescript
import { safeValidateDestination } from '@stellar/pocketpay-sdk';

const result = await safeValidateDestination(destination, {
  asset: { code: 'USDC', issuer: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7' },
});

if (result.ok) {
  console.log('Validation passed:', result.value);
} else {
  console.error('Validation failed:', result.error);
}
```

## Validation Status Codes

### Local Validation Statuses

| Status | Description | Error Code |
|--------|-------------|------------|
| `valid_local` | Destination passed local validation | - |
| `invalid_address_format` | Address format is invalid | `INVALID_PUBLIC_KEY` |
| `invalid_address_checksum` | Address checksum validation failed | `INVALID_PUBLIC_KEY` |
| `self_payment` | Destination is the same as source | `SELF_PAYMENT` |

### Network Validation Statuses

| Status | Description | Error Code |
|--------|-------------|------------|
| `valid_network` | Destination passed network validation | - |
| `account_not_found` | Account does not exist on-chain | `UNFUNDED_DESTINATION` |
| `account_unfunded` | Account exists but is not funded | `UNFUNDED_DESTINATION` |
| `account_inactive` | Account exists but is inactive | `ACCOUNT_INACTIVE` |
| `missing_trustline` | No trustline for the asset | `MISSING_TRUSTLINE` |
| `trustline_not_authorized` | Trustline not authorized by issuer | `TRUSTLINE_NOT_AUTHORIZED` |
| `trustline_limit_exceeded` | Payment amount exceeds capacity | `TRUSTLINE_LIMIT_EXCEEDED` |

## Error Handling

### Malformed Addresses

Malformed addresses are caught during local validation:

```typescript
const result = validateDestinationLocal('INVALID_ADDRESS');

// result.valid === false
// result.status === 'invalid_address_format'
// result.errorCode === 'INVALID_PUBLIC_KEY'
```

### Unfunded Accounts

Unfunded accounts are detected during network validation:

```typescript
const result = await validateDestinationNetwork(unfundedPublicKey);

// result.valid === false
// result.status === 'account_not_found'
// result.errorCode === 'UNFUNDED_DESTINATION'
```

**Recommended action:** Inform the user that the recipient account needs to be funded first. For testnet, use the friendbot funding service.

### Missing Trustlines

Missing trustlines are detected when validating issued assets:

```typescript
const result = await validateDestinationNetwork(destination, {
  asset: { code: 'USDC', issuer: issuerPublicKey },
});

// result.valid === false
// result.status === 'missing_trustline'
// result.errorCode === 'MISSING_TRUSTLINE'
```

**Recommended action:** Inform the user that the recipient needs to establish a trustline for the asset before receiving the payment.

### Unauthorized Trustlines

Trustlines that exist but are not authorized by the issuer:

```typescript
// result.status === 'trustline_not_authorized'
// result.errorCode === 'TRUSTLINE_NOT_AUTHORIZED'
```

**Recommended action:** Inform the user that the issuer has not authorized the recipient's trustline. The recipient may need to contact the issuer or wait for authorization.

### Trustline Limit Exceeded

When the payment amount exceeds the available trustline capacity:

```typescript
const result = await validateDestinationNetwork(destination, {
  asset: { code: 'USDC', issuer: issuerPublicKey },
  amount: '1000',
});

// result.status === 'trustline_limit_exceeded'
// result.metadata.availableCapacity === '100.0000000'
```

`availableCapacity` is `limit - balance` computed in exact stroops with the
shared amount model (see [Amount Model](./amount-model.md)) and formatted to 7
decimal places. When `amount` is provided it is checked with `validateAmount`
before the Horizon lookup, so a malformed, zero, over-precise or above-maximum
amount throws `INVALID_AMOUNT` / `INVALID_AMOUNT_PRECISION` instead of being
compared against the capacity.

**Recommended action:** Inform the user of the available capacity and suggest a smaller payment amount or ask the recipient to increase their trustline limit.

## Best Practices

### 1. Use Local Validation for UI Feedback

Perform local validation immediately when users input destination addresses to provide instant feedback:

```typescript
function onDestinationChange(address: string) {
  const result = validateDestinationLocal(address);
  if (!result.valid) {
    showFieldError('destination', result.message);
  }
}
```

### 2. Use Network Validation Before Critical Payments

For high-value or critical payments, perform network validation before submission:

```typescript
async function sendPayment(params: PaymentParams) {
  // Validate destination before building transaction
  const validation = await validateDestinationNetwork(params.destination, {
    asset: params.asset,
    amount: params.amount,
  });

  if (!validation.valid) {
    throw new Error(`Destination validation failed: ${validation.message}`);
  }

  // Proceed with payment
  return await sendAsset(params);
}
```

### 3. Handle Unfunded Accounts Gracefully

Provide clear guidance when accounts are unfunded:

```typescript
if (result.status === 'account_not_found') {
  if (config.network === 'testnet') {
    showMessage('Recipient account not funded. Use friendbot to fund it.');
  } else {
    showMessage('Recipient account does not exist. Please verify the address.');
  }
}
```

### 4. Use Safe Wrappers for Non-Critical Flows

For non-critical flows where you want to handle errors gracefully:

```typescript
const result = await safeValidateDestination(destination);
if (!result.ok) {
  logError(result.error);
  return;
}
```

### 5. Leverage Metadata for Detailed Information

Use validation metadata to provide detailed feedback to users:

```typescript
if (result.valid && result.metadata) {
  console.log(`Account sequence: ${result.metadata.sequence}`);
  console.log(`Current balance: ${result.metadata.currentBalance}`);
  console.log(`Available capacity: ${result.metadata.availableCapacity}`);
}
```

## Integration with Payment Flows

The destination validation functions can be integrated directly into payment flows:

```typescript
import { sendAsset, validateDestinationOrThrow } from '@stellar/pocketpay-sdk';

async function sendPaymentWithValidation(params: SendAssetParams) {
  // Validate destination before payment
  await validateDestinationOrThrow(params.destination, {
    asset: params.asset,
    amount: params.amount,
    sourcePublicKey: derivePublicKey(params.sourceSecret),
  });

  // Proceed with payment
  return await sendAsset(params);
}
```

## Performance Considerations

- **Local validation** is fast (sub-millisecond) and can be called frequently
- **Network validation** requires Horizon queries and should be used judiciously
- Consider caching network validation results for short periods if validating the same destination multiple times
- Use `level: 'local'` for batch validation of many destinations
- Use `level: 'complete'` only for final validation before payment submission

## Related Documentation

- [Trustline Validation](./trustline-validation.md) - Detailed trustline validation guide
- [Issued Asset Payments](./issued-asset-payments.md) - Guide to sending issued assets
- [Error Handling](./error-handling.md) - Comprehensive error handling guide
