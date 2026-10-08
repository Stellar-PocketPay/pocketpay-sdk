# Security Best Practices

Security guidance for applications using the PocketPay SDK.

## Key Management

- Never hardcode secret keys in source code
- Use environment variables or secure key stores
- Rotate keys periodically
- Use separate keys for development and production

## Wallet Backup Responsibility

`createWallet` generates a keypair and returns it — the SDK does not persist,
store, sync, or back up `secretKey` in any way. Once the returned value is
lost (process exit, dropped reference, uninstalled app, etc.), the wallet and
any funds it holds are permanently unrecoverable. There is no
password-reset equivalent for a Stellar secret key.

The consuming application (or the end user) owns backup and long-term
storage. Typical approaches:

- Persist `secretKey` to encrypted device storage, an OS keychain, or an HSM
  immediately after `createWallet` returns.
- Walk the user through a recovery-phrase or secret-key export flow before
  they can navigate away from the creation screen.
- For server-side scripts or test fixtures, load `secretKey` from environment
  variables or a secrets manager — never commit it to source control.

The same applies to wallets restored later via `importWallet`: the SDK has
no memory of previously created wallets, so the secret key must come from
wherever your app backed it up.

See [Wallet Recovery Limitations](./wallet-recovery-limitations.md) for a full
breakdown of loss scenarios, what the SDK does not provide, and your
application's responsibilities.

## Logging

See [Logging Guidance](./logging.md) for safe logging practices.

## Redaction Utilities

The SDK provides `redactSecretKey` and `redactSensitiveValue` utilities to
safely mask sensitive values in logs, debug output, and error messages.

### redactSecretKey

Mask a Stellar secret key, keeping only the first 4 and last 4 characters:

```ts
import { redactSecretKey } from 'stellar-pocketpay-sdk';

const key = 'SC4M4LZP...FULL_KEY...QUCK4L';
console.log('Signing with:', redactSecretKey(key));
// => "Signing with: SC4M...CK4L"
```

- Never validates or exposes the full key.
- Returns `"(empty)"` for empty/blank input.
- Already-redacted values (containing `...`) are returned as-is (idempotent).

### redactSensitiveValue

General-purpose redaction for any sensitive string:

```ts
import { redactSensitiveValue } from 'stellar-pocketpay-sdk';

console.log('API key:', redactSensitiveValue('sk_live_abc123xyz789'));
// => "API key: sk_l...z789"
```

Both utilities are designed to **never throw** on invalid or unexpected input,
so they are safe to use in error-reporting paths.

## Signing Boundaries

Signing capability is separate from account identity: a `ReadOnlyAccount`
(from `createReadOnlyAccount`) can never sign — `canSign` is fixed to
`false` and attempting to sign throws a typed `TX_SIGNER_MISSING` error
before any signer is touched. A `SigningAccount` (from `createLocalAccount`
or `createAccountWithSigner`) holds a `Signer`, never a raw secret directly.

`LocalSigner` (the SDK's local, in-memory signer) never exposes its secret
through public fields, `JSON.stringify()`, or Node's `console.log()`/
`util.inspect()` — only the public key. This is not automatic for custom
`Signer`/`ExternalSignerAdapter` implementations you write yourself; the same
discipline is your responsibility for those.

See [Signing Boundaries](./signing-boundaries.md) for the full model: which
type carries secrets, how capability is checked before signing, the typed
signer errors (`TX_SIGNER_MISSING`, `TX_SIGNER_MISMATCH`), the external
signer adapter extension point and its use of the SDK's existing
[Capability Error Standard](./capability_error_standard.md), and —
explicitly — what this model does **not** guarantee.

## Transaction Safety

- Always verify transaction envelopes before signing
- Check destination addresses match expected values
- Set appropriate time bounds on transactions
- Check signing capability before attempting to sign — see
  [Signing Boundaries](./signing-boundaries.md#what-can-sign--the-capability-check)

## Error Handling

- Do not expose internal error details to end users
- Log errors safely following the logging guidance
- Validate all user inputs before constructing transactions
- Missing-signer, wrong-signer, and unsupported-capability cases raise typed,
  registered error codes rather than generic errors — see
  [Capability Error Standard](./capability_error_standard.md)

## Wallet Import Validation (issue #334)

`validateWalletImportInput(value)` checks signing-capable Stellar secret
material before import. It distinguishes missing or non-string input, a
**public-only** G address, unsupported muxed account/contract material
(M/C addresses), unsupported formats, incorrect length and invalid checksum.
It accepts a valid S-address secret with surrounding whitespace but never
includes the supplied material in a validation error.

`importWallet`, `safeImportWallet`, `enhancedImportWallet` and
`getPublicKey` use this stricter import boundary. The existing generic
`validateSecretKey` contract and its reason codes remain unchanged.
Import failures use `PocketPayError` with
`code: 'INVALID_SECRET_KEY'` and safe `validation.field` /
`validation.reason` metadata, **without `validation.value` or a raw
underlying `cause`**. Safe wrappers continue returning results instead
of throwing; enhanced failures offer input-specific recovery guidance.
Malformed third-party SDK error objects cannot change this contract: import
sanitization treats `PocketPayError.code` and `validation.reason` as
untrusted metadata, guards against accessors or proxy traps that throw,
and falls back to a fixed `import_failed` reason with no original
message, cause or secret-bearing fields. The existing focused test
covers malicious reason/code getters and proxy traps; it is authored
but not executed in this source publication.
Do not log caught raw key material from unrelated application code.

The SDK does not persist, overwrite or roll back application-managed
wallet storage. An invalid import has no effect on any already created
wallet in SDK memory; applications must replace their stored wallet
**only after** a successful result. Public addresses are useful for
read-only access but cannot unlock or recover signing authority. Never
paste secret keys into diagnostics, issue reports, or support tickets.
