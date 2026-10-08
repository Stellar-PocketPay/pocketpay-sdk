# Offline Transaction Preparation

## Overview

The Stellar PocketPay SDK supports offline transaction preparation, enabling workflows where transaction preparation, signing, and submission happen at different times or on different machines. This is particularly useful for:

- **Air-gapped signing**: Prepare transactions on an online machine, sign on an offline machine
- **Multi-party coordination**: Prepare transactions and collect signatures from multiple parties
- **Delayed submission**: Prepare transactions now and submit when network is available
- **Transaction queuing**: Prepare multiple transactions and submit in batches

## Network Dependencies

### What Can Be Prepared Offline (No Network Required)

The following can be prepared without any network access:

- **Transaction operations**: Payment operations, manage data operations, etc.
- **Memo construction**: Text memos up to 28 bytes
- **Asset specifications**: Native XLM or issued asset definitions
- **Timebounds**: Can use estimated values or be provided manually
- **Basic input validation**: Address format, amount precision, etc.

### What Requires Network State (Must Be Fetched or Provided)

The following requires network access or must be provided manually:

- **Source account sequence number** (CRITICAL - required for transaction validity)
- **Account balance verification** (optional but recommended)
- **Fee estimation** (optional - can use default BASE_FEE)
- **Trustline verification** for issued assets (optional but recommended)

## Transaction Preparation Workflow

### Complete Workflow

```
1. PREPARE OFFLINE → Build transaction operations and metadata
2. FETCH STATE → Get sequence number and optional account data
3. BUILD → Assemble transaction with sequence number and timebounds
4. SIGN → Sign the transaction (can be offline with local keys)
5. SUBMIT → Submit to Horizon (requires network access)
```

### Step-by-Step Example

#### Step 1: Prepare Transaction Offline

```typescript
import { prepareTransactionOffline } from '@stellar/pocketpay-sdk';

const params = {
  sourcePublicKey: 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
  operations: [
    {
      destination: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
      amount: '100',
      asset: { code: 'XLM' },
    },
  ],
  memo: 'Payment for services',
  timebounds: {
    minTime: Math.floor(Date.now() / 1000),
    maxTime: Math.floor(Date.now() / 1000) + 300, // 5 minutes
  },
  baseFee: '100', // 100 stroops
};

const prepared = prepareTransactionOffline(params, { network: 'testnet' });

// prepared.readyToBuild === false (needs sequence number)
// prepared.networkState.sequence === ''
```

#### Step 2: Fetch Network State

```typescript
import { fetchNetworkState } from '@stellar/pocketpay-sdk';

const networkState = await fetchNetworkState(
  'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
  { network: 'testnet' }
);

// networkState.sequence === '123456789'
// networkState.balance?.native === '1000.5'
// networkState.balance?.minimum === '2.5'
```

#### Step 3: Update with Network State

```typescript
import { updateWithNetworkState } from '@stellar/pocketpay-sdk';

const updated = updateWithNetworkState(prepared, networkState);

// updated.readyToBuild === true
// updated.networkState.sequence === '123456789'
```

#### Step 4: Build Unsigned Transaction

```typescript
import { buildUnsignedTransaction } from '@stellar/pocketpay-sdk';

const unsigned = buildUnsignedTransaction(updated);

// unsigned.transaction - Stellar SDK Transaction object (unsigned)
// unsigned.hash - Transaction hash for verification
// unsigned.sourcePublicKey - Source account public key
// unsigned.networkPassphrase - Network passphrase for signing
```

#### Review Before Signing

Before handing the transaction to any local, hardware, or remote signer, render a
read-only review from the exact payload that will be approved:

```typescript
import { getTransactionSigningSummary } from '@stellar/pocketpay-sdk';

const review = getTransactionSigningSummary(unsigned);

console.log(review.source);
console.log(review.networkName);
console.log(review.feeInXlm);
console.table(review.operations);
console.log(review.memo);

// This helper only reads the payload. It never signs or submits it.
if (!review.canSign) {
  throw new Error('Transaction is not ready for signing');
}
```

The same helper also accepts a `PreparedTransaction`, which is useful for a
preview before the final sequence-dependent build. For the final approval UI,
prefer the `UnsignedTransaction` summary so the source, operations, memo, fee,
network, time bounds, and transaction hash all describe the exact built payload
that will be signed.

#### Step 5: Sign Transaction

```typescript
import { signTransaction } from '@stellar/pocketpay-sdk';

const secretKey = 'SXXX...'; // Source account secret key
const signed = signTransaction(unsigned, secretKey);

// signed.transaction - Stellar SDK Transaction object (signed)
// signed.hash - Transaction hash
// signed.xdr - XDR representation of signed transaction
```

#### Step 6: Submit Transaction

```typescript
import { submitSignedTransaction } from '@stellar/pocketpay-sdk';

const result = await submitSignedTransaction(signed, { network: 'testnet' });

if (result.success) {
  console.log('Transaction submitted:', result.hash);
  console.log('Ledger:', result.ledger);
  console.log('Fee:', result.fee);
} else {
  console.error('Submission failed:', result.error);
  console.error('Error code:', result.errorCode);
}
```

## Use Cases

### 1. Air-Gapped Signing

Prepare transaction on online machine, transfer to offline machine for signing:

```typescript
// ONLINE MACHINE
const prepared = prepareTransactionOffline(params);
const networkState = await fetchNetworkState(sourcePublicKey);
const updated = updateWithNetworkState(prepared, networkState);
const unsigned = buildUnsignedTransaction(updated);

// Transfer unsigned.transaction.toXDR() to offline machine
const xdr = unsigned.transaction.toXDR('base64');

// OFFLINE MACHINE
const transaction = StellarSDK.Transaction.fromXDR(xdr, 'base64');
const unsignedForSigning = {
  transaction,
  networkPassphrase: 'Test SDF Network ; September 2015',
  sourcePublicKey,
  hash: transaction.hash().toString('hex'),
};
const signed = signTransaction(unsignedForSigning, secretKey);

// Transfer signed.xdr back to online machine
// ONLINE MACHINE
const signedTx = StellarSDK.Transaction.fromXDR(signed.xdr, 'base64');
const signedForSubmission = {
  transaction: signedTx,
  networkPassphrase: 'Test SDF Network ; September 2015',
  hash: signedTx.hash().toString('hex'),
  xdr: signed.xdr,
};
const result = await submitSignedTransaction(signedForSubmission);
```

### 2. Multi-Party Signing

Prepare transaction and collect signatures from multiple parties:

```typescript
// Party 1: Prepare transaction
const prepared = prepareTransactionOffline(params);
const networkState = await fetchNetworkState(sourcePublicKey);
const updated = updateWithNetworkState(prepared, networkState);
const unsigned = buildUnsignedTransaction(updated);

// Party 1: Sign first
const signed1 = signTransaction(unsigned, secretKey1);

// Party 2: Add signature
const keypair2 = StellarSDK.Keypair.fromSecret(secretKey2);
signed1.transaction.sign(keypair2);

// Party 3: Add signature
const keypair3 = StellarSDK.Keypair.fromSecret(secretKey3);
signed1.transaction.sign(keypair3);

// Submit with all signatures
const result = await submitSignedTransaction(signed1);
```

### 3. Hardware Wallet Integration

Use external signer for hardware wallet support:

```typescript
import { signTransactionWithSigner } from '@stellar/pocketpay-sdk';

// Hardware wallet signer implementation
const hardwareSigner = {
  publicKey: 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
  async sign(transaction, networkPassphrase) {
    // Show transaction on hardware wallet
    const approved = await hardwareWallet.approveTransaction(transaction);
    if (!approved) throw new Error('User rejected transaction');
    
    // Sign using hardware wallet
    const signature = await hardwareWallet.sign(transaction);
    transaction.signatures.push(signature);
    return transaction;
  },
};

const signed = await signTransactionWithSigner(unsigned, hardwareSigner);
```

### 4. Manual Sequence Number (Fully Offline)

If you know the sequence number, you can prepare completely offline:

```typescript
import { prepareTransactionWithManualSequence } from '@stellar/pocketpay-sdk';

const prepared = prepareTransactionWithManualSequence(
  params,
  '123456789', // Known sequence number
  { network: 'testnet' }
);

// prepared.readyToBuild === true
const unsigned = buildUnsignedTransaction(prepared);
const signed = signTransaction(unsigned, secretKey);
```

### 5. Transaction Queuing

Prepare multiple transactions and submit in batch:

```typescript
const transactions = [];

for (const recipient of recipients) {
  const params = {
    sourcePublicKey,
    operations: [{
      destination: recipient.address,
      amount: recipient.amount,
      asset: { code: 'XLM' },
    }],
  };
  
  const prepared = prepareTransactionOffline(params);
  const networkState = await fetchNetworkState(sourcePublicKey);
  const updated = updateWithNetworkState(prepared, networkState);
  const unsigned = buildUnsignedTransaction(updated);
  const signed = signTransaction(unsigned, secretKey);
  
  transactions.push(signed);
}

// Submit all transactions
for (const signed of transactions) {
  const result = await submitSignedTransaction(signed);
  console.log(`Submitted ${result.hash}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
}
```

## Prepared Transaction Shape

### OfflineTransactionParams

```typescript
interface OfflineTransactionParams {
  sourcePublicKey: string;           // Source account public key
  operations: OfflinePaymentOperation[];  // Payment operations
  memo?: string;                     // Optional memo (max 28 bytes)
  timebounds?: {                     // Optional timebounds
    minTime?: number;                // Minimum timestamp (Unix seconds)
    maxTime?: number;                // Maximum timestamp (Unix seconds)
  };
  baseFee?: string;                  // Base fee in stroops
}
```

### OfflinePaymentOperation

```typescript
interface OfflinePaymentOperation {
  destination: string;               // Destination public key
  amount: string;                    // Amount as string (for precision)
  asset: StellarAssetSpec;           // Asset specification
}
```

### NetworkState

```typescript
interface NetworkState {
  sequence: string;                  // REQUIRED: Source account sequence number
  currentFee?: string;               // Optional: Current network fee
  balance?: {                        // Optional: Account balance info
    native: string;                  // Native XLM balance
    minimum: string;                 // Minimum required balance
  };
}
```

### PreparedTransaction

```typescript
interface PreparedTransaction {
  sourcePublicKey: string;           // Source account public key
  networkPassphrase: string;         // Network passphrase
  operations: OfflinePaymentOperation[];  // Transaction operations
  memo?: string;                     // Optional memo
  timebounds: {                      // Timebounds
    minTime: number;
    maxTime: number;
  };
  baseFee: string;                   // Base fee in stroops
  networkState: NetworkState;        // Network state
  readyToBuild: boolean;             // Whether ready to build
  transactionHash?: string;          // Transaction hash (after building)
}
```

### UnsignedTransaction

```typescript
interface UnsignedTransaction {
  transaction: StellarSDK.Transaction;  // Unsigned Stellar SDK transaction
  networkPassphrase: string;           // Network passphrase for signing
  sourcePublicKey: string;             // Source account public key
  hash: string;                        // Transaction hash
}
```

### SignedTransaction

```typescript
interface SignedTransaction {
  transaction: StellarSDK.Transaction;  // Signed Stellar SDK transaction
  networkPassphrase: string;           // Network passphrase
  hash: string;                        // Transaction hash
  xdr: string;                         // XDR representation
}
```

## Signing and Submission Boundaries

### Signing Boundaries

**Can be signed offline:**
- Transactions with local secret keys
- Transactions prepared with known sequence numbers
- Transactions on air-gapped machines

**Requires network for signing:**
- Hardware wallet communication (if device requires network)
- Remote signing services (HSM, MPC services)

### Submission Boundaries

**Always requires network:**
- Transaction submission to Horizon
- Transaction status polling
- Account state queries

**Can be done offline:**
- Transaction preparation
- Transaction signing (with local keys)
- Transaction serialization/deserialization

## Limitations and Considerations

### Sequence Number Management

- **Critical**: Sequence numbers must be current for successful submission
- **Stale sequence**: If sequence number is outdated, submission will fail
- **Sequence gaps**: If transactions are submitted out of order, sequence gaps may occur
- **Recommendation**: Fetch sequence number immediately before building transaction

### Timebounds Validity

- **Default**: 5 minutes from preparation time
- **Expired transactions**: Transactions with expired timebounds will be rejected
- **Long timebounds**: Use longer timebounds for delayed submission scenarios
- **Recommendation**: Set appropriate timebounds based on your submission timeline

### Fee Estimation

- **Default**: Uses Stellar SDK BASE_FEE (100 stroops)
- **Network conditions**: High network congestion may require higher fees
- **Dynamic fees**: Consider fetching current fee from network for critical transactions
- **Recommendation**: Use higher fees for time-sensitive transactions

### Trustline Verification

- **Offline limitation**: Cannot verify trustlines without network access
- **Issued assets**: Destination trustline checks require Horizon queries
- **Recommendation**: Perform trustline validation before offline preparation for issued assets

### Account Balance

- **Offline limitation**: Cannot verify account balance without network access
- **Insufficient funds**: Transactions with insufficient balance will fail
- **Recommendation**: Verify balance before preparation or handle submission failures gracefully

## Error Handling

### Common Errors

#### Missing Sequence Number

```typescript
try {
  const unsigned = buildUnsignedTransaction(prepared);
} catch (error) {
  if (error.code === 'TRANSACTION_NOT_READY') {
    console.error('Transaction needs network state (sequence number)');
  }
}
```

#### Account Not Found

```typescript
try {
  const networkState = await fetchNetworkState(publicKey);
} catch (error) {
  if (error.code === 'ACCOUNT_NOT_FOUND') {
    console.error('Source account is not funded');
  }
}
```

#### Key Mismatch

```typescript
try {
  const signed = signTransaction(unsigned, secretKey);
} catch (error) {
  if (error.code === 'KEY_MISMATCH') {
    console.error('Secret key does not match source public key');
  }
}
```

#### Submission Failure

```typescript
const result = await submitSignedTransaction(signed);
if (!result.success) {
  if (result.errorCode === 'tx_bad_seq') {
    console.error('Bad sequence number - transaction may be stale');
  } else if (result.errorCode === 'tx_insufficient_balance') {
    console.error('Insufficient balance for transaction');
  }
}
```

## Safe Wrappers

The SDK provides non-throwing wrappers for error-safe operations:

```typescript
import {
  safeFetchNetworkState,
  safeSubmitSignedTransaction,
  safePrepareAndSignTransaction,
} from '@stellar/pocketpay-sdk';

// Safe network state fetch
const stateResult = await safeFetchNetworkState(publicKey);
if (!stateResult.ok) {
  console.error('Failed to fetch network state:', stateResult.error);
  return;
}

// Safe submission
const submitResult = await safeSubmitSignedTransaction(signed);
if (!submitResult.ok) {
  console.error('Submission failed:', submitResult.error);
  return;
}

// Safe complete workflow
const result = await safePrepareAndSignTransaction(params, secretKey);
if (!result.ok) {
  console.error('Preparation failed:', result.error);
  return;
}
```

## Complete Workflow Helper

For simple use cases, use the complete workflow helper:

```typescript
import { prepareAndSignTransaction } from '@stellar/pocketpay-sdk';

const params = {
  sourcePublicKey: 'GD5JQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
  operations: [{
    destination: 'GB7TQ6K7LZD4NRBF7FQ4I6V7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7E7Z7',
    amount: '100',
    asset: { code: 'XLM' },
  }],
  memo: 'Payment',
};

const secretKey = 'SXXX...';

// This handles: prepare → fetch state → build → sign
const signed = await prepareAndSignTransaction(params, secretKey, { network: 'testnet' });

// Submit later
const result = await submitSignedTransaction(signed);
```

## Best Practices

### 1. Sequence Number Freshness

Always fetch sequence number immediately before building:

```typescript
// BAD: Stale sequence number
const oldState = await fetchNetworkState(publicKey);
// ... time passes ...
const unsigned = buildUnsignedTransaction(updated);

// GOOD: Fresh sequence number
const state = await fetchNetworkState(publicKey);
const updated = updateWithNetworkState(prepared, state);
const unsigned = buildUnsignedTransaction(updated);
```

### 2. Timebounds Appropriateness

Set timebounds based on your submission timeline:

```typescript
// Immediate submission
const timebounds = {
  minTime: Math.floor(Date.now() / 1000),
  maxTime: Math.floor(Date.now() / 1000) + 60, // 1 minute
};

// Delayed submission (e.g., batch processing)
const timebounds = {
  minTime: Math.floor(Date.now() / 1000),
  maxTime: Math.floor(Date.now() / 1000) + 3600, // 1 hour
};
```

### 3. Error Handling

Always handle potential errors at each step:

```typescript
try {
  const prepared = prepareTransactionOffline(params);
} catch (error) {
  if (error.validation) {
    console.error(`Validation error on ${error.validation.field}: ${error.validation.reason}`);
  }
  return;
}

try {
  const networkState = await fetchNetworkState(publicKey);
} catch (error) {
  if (error.code === 'ACCOUNT_NOT_FOUND') {
    console.error('Account not funded');
  }
  return;
}
```

### 4. Transaction Verification

Verify transaction hash before submission:

```typescript
const unsigned = buildUnsignedTransaction(updated);
console.log('Transaction hash:', unsigned.hash);

// Verify hash matches expected
if (unsigned.hash !== expectedHash) {
  throw new Error('Transaction hash mismatch');
}
```

### 5. Secure Key Handling

Never log or transmit secret keys:

```typescript
// BAD
console.log('Signing with:', secretKey);

// GOOD
const signed = signTransaction(unsigned, secretKey);
console.log('Signed transaction hash:', signed.hash);
```

## Security Considerations

### Secret Key Protection

- Secret keys should never be logged or transmitted
- Use secure storage for secret keys (encrypted vault, hardware wallet)
- Clear secret keys from memory when no longer needed
- Consider using hardware wallets for high-value transactions

### Transaction Verification

- Always verify transaction details before signing
- Check destination addresses carefully
- Verify amounts and assets
- Use memos for transaction identification

### Network State Freshness

- Stale sequence numbers can lead to failed submissions
- Account balances may change between preparation and submission
- Trustline status may change for issued assets

### Replay Protection

- Timebounds prevent replay attacks
- Sequence numbers ensure transaction ordering
- Consider using unique memos for additional identification

## Related Documentation

- [Transaction Signing](./security.md) - Security best practices for signing
- [Error Handling](./error-handling.md) - Comprehensive error handling guide
- [Account Abstraction](./account-abstraction.md) - Account and signer interfaces
- [Network Errors](./network-errors.md) - Network error handling
