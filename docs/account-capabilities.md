# Account capabilities: view, sign, and submit

The SDK models these as three different capabilities. Presence of an account,
public key, local signer, or signed transaction must never be interpreted as
permission or ability to submit a transaction.

## The model

- **canView** means an account identity is available for public read-only
  operations. Both watch-only and signing accounts have this capability.
- **canSign** means a signer is attached, has the same public key as the account,
  provides a sign method, and does not explicitly report itself unavailable.
  It is a snapshot; a remote device can still disconnect or reject the request.
- **canSubmit** means a caller explicitly supplied a transport with a
  submitSignedTransaction function. It does **not** mean Horizon connectivity
  was checked, the transaction is valid, its signatures are sufficient, or the
  ledger will accept it. Submission remains a separate, explicit user action.

The snapshot is produced by getAccountCapabilities(account, transport?) and
does no network access, signing, submission, secrets inspection, or persistence.
Both the account and optional transport are injected by the caller.

## Example: observe without signing or submitting

    import { createReadOnlyAccount, getAccountCapabilities } from 'stellar-pocketpay-sdk';

    const watchOnly = createReadOnlyAccount(userPublicKey);
    const caps = getAccountCapabilities(watchOnly);
    // { canView: true, canSign: false, canSubmit: false, submission: 'missing' }

## Example: signing without implicit submission

    import { createLocalAccount, getAccountCapabilities } from 'stellar-pocketpay-sdk';

    const account = createLocalAccount(secretFromSecureStorage);
    const caps = getAccountCapabilities(account);
    // canView=true, canSign=true, canSubmit=false
    // A separate caller-initiated signed-transaction submission step is required.

## Example: an explicit broadcast-only transport

    import { createReadOnlyAccount, getAccountCapabilities } from 'stellar-pocketpay-sdk';

    const account = createReadOnlyAccount(userPublicKey);
    const transport = {
      async submitSignedTransaction(signedTransaction) {
        return submitViaYourConfiguredHorizonClient(signedTransaction);
      },
    };
    const caps = getAccountCapabilities(account, transport);
    // canSign=false, canSubmit=true
    // A watch-only account may relay a transaction signed by another party.
    // Simply checking caps never sends a transaction.

## Security and compatibility

The existing canSignTransaction type guard, ReadOnlyAccount/SigningAccount
union and Signer contract are unchanged. Existing signing functions remain
the way to sign, and existing submitSignedTransaction remains the SDK's explicit
network submission path. The optional transport is an adapter describing a
configured caller capability; it is not a new automatic send path.

createAccountWithSigner now rejects a signer whose public key disagrees with
the account identity using the existing typed TX_SIGNER_MISMATCH error, before
the account is constructed. AccountAbstraction.sign rechecks signer identity
just before delegation, in case a mutable external adapter changes later.
Neither error includes private key material.

For full signing and transaction-lifecycle boundaries, see
[Account Abstraction](./account-abstraction.md),
[Signing Boundaries](./signing-boundaries.md), and
[Transaction Lifecycle ADR](./adr/0005-transaction-lifecycle.md).
