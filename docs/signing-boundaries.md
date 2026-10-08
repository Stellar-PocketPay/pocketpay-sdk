# Signing Boundaries

This document explains where secret material lives, what can sign, how the
SDK checks signing capability before it ever calls a signer, and how future
external signers (mobile, browser, hardware) plug in. It is the security
reference for the signer capability architecture built on top of the
[account abstraction layer](./account-abstraction.md) (see also
[ADR-0002](./adr/0002-account-abstraction.md) and
[ADR-0004](./adr/0004-signer-capability-architecture.md)).

## The four boundaries

| Concept | Type | Carries a secret? | Can sign? |
|---|---|---|---|
| Identity | `AccountIdentity` | Never | No — it's just a public key |
| Local secret-bearing state | `LocalSignerConfig` (input) / `LocalSigner` (instance) | Yes, encapsulated | Yes |
| Signing capability | `Signer` / `ExternalSignerAdapter` | Depends on implementation | Yes, by contract |
| Account handle | `ReadOnlyAccount` \| `SigningAccount` (the `AccountAbstraction` union) | Never directly — delegates to `Signer` | Only `SigningAccount` |

Submission (`submitSignedTransaction`, `server.submitTransaction`) is
agnostic to how a transaction was signed — it only requires a signed
envelope, never a secret.

## Which type carries secrets

Exactly one type accepts secret material as input: `LocalSignerConfig`
(`{ secretKey: string }`), consumed by `LocalSigner`'s constructor and by the
`createLocalAccount(secretKey)` / `createLocalSigner(secretKey)` factories.

Once constructed, `LocalSigner` holds the derived `@stellar/stellar-sdk`
`Keypair` in a private field. No public type in the account abstraction layer
declares a `secretKey` or `secret` field:

- `AccountIdentity` — only `publicKey`.
- `Signer` / `ExternalSignerAdapter` — only `publicKey` and `sign()`.
- `ReadOnlyAccount` — `signer` is statically `undefined`.
- `SigningAccount` — `signer: Signer`, never a raw key.

This is enforced at the type level, not just by convention: nothing you can
do with the public API produces an object whose *type* has a `secretKey`
field, other than passing one in to `LocalSignerConfig`/`createLocalAccount`/
`createLocalSigner`/`WalletKeypair` (the legacy `createWallet()`/
`importWallet()` helpers, unrelated to this layer — see
[Relationship to existing wallet helpers](./account-abstraction.md#relationship-to-existing-wallet-helpers)).

### Serialization is also covered, not just field access

A type-level guarantee is not enough on its own — `@stellar/stellar-sdk`'s
`Keypair` stores the raw secret as plain enumerable `Buffer` fields
(`_secretSeed`, `_secretKey`). Without a defensive override, `JSON.stringify()`
and Node's `console.log()`/`util.inspect()` on a `LocalSigner` (or any
`SigningAccount` holding one) would serialize those raw bytes even though no
public *type* exposes them. `LocalSigner` defines `toJSON()` and the Node
`util.inspect.custom` symbol so both paths return only `{ publicKey }`.
External `Signer`/`ExternalSignerAdapter` implementations you or a future
adapter package write are responsible for the same discipline — see
[What this model does NOT guarantee](#what-this-model-does-not-guarantee).

## What can sign — the capability check

`AccountAbstraction` is `ReadOnlyAccount | SigningAccount`, a discriminated
union on `canSign`. Check capability **before** attempting to sign, using the
`canSignTransaction()` type guard:

```ts
import { canSignTransaction, type AccountAbstraction } from 'stellar-pocketpay-sdk';

function describe(account: AccountAbstraction) {
  if (canSignTransaction(account)) {
    // account: SigningAccount — account.signer is Signer, not Signer | undefined
    return `can sign as ${account.signer.publicKey}`;
  }
  // account: ReadOnlyAccount
  return 'read-only, cannot sign';
}
```

This is preferred over wrapping `sign()` in a try/catch: the check is
explicit, narrows the type, and never touches the signer if it can't be
used.

### Orchestration checks capability before signing

`signWithAccount(unsigned, account)` (in the offline-preparation pipeline,
`src/transactions/offline-preparation.ts`) is the capability-checked entry
point for turning a built-but-unsigned transaction into a signed one from an
`AccountAbstraction`:

1. `canSignTransaction(account)` — if `false`, throws `TX_SIGNER_MISSING`
   *before* touching any signer.
2. `account.publicKey === unsigned.sourcePublicKey` — if it doesn't match,
   throws `TX_SIGNER_MISMATCH` *before* calling `sign()`.
3. Only then does it delegate to `signTransactionWithSigner(unsigned, account.signer)`.

A non-throwing variant, `safeSignWithAccount`, returns a typed
`PocketPayResult` instead.

## Typed signer errors

Two codes are specific to this layer, registered in `src/errors/codes.ts`
alongside the rest of the public error-code standard (see
[Error Handling](./error-handling.md)):

| Code | Category | Meaning |
|---|---|---|
| `TX_SIGNER_MISSING` | `TRANSACTION` | The account has no signer attached (read-only) — checked before signing. |
| `TX_SIGNER_MISMATCH` | `TRANSACTION` | The signer's public key does not match the transaction's source account ("wrong signer"). |

Both are thrown as `PocketPayError` (the SDK's single error class — see
[Error Handling](./error-handling.md)) with a stable `code`, never as a
generic `Error`, so `error instanceof PocketPayError` and
`redactError()`/`describeError()` keep working uniformly across the SDK.

There is no third, signer-specific "unsupported capability" code. Instead,
"this signing method isn't supported yet" reuses the SDK's existing
unsupported-feature/capability standard — see the next section.

## Binding an external signer to its account identity

When constructing an account with createAccountWithSigner(identity, signer),
the supplied signer's publicKey **must match** identity.publicKey.
A mismatched signer fails immediately with a PocketPayError whose code is
TX_SIGNER_MISMATCH; the signer is never invoked. This is separate from
validating that identity.publicKey has the correct Stellar address format.

External signers may change their selected key after attachment (for example
when a hardware device switches accounts). AccountAbstraction.sign() checks
the signer's current publicKey against the attached account identity **again,
immediately before calling** signer.sign(). A mismatch returns the same typed
error without asking the now-wrong signer to sign. Reattaching an account is
required if the intended public identity changes.

This is a key-consistency boundary, not proof that arbitrary third-party
signer implementations possess the private key they advertise. An adapter is
responsible for verifying its device identity and binding the actual signature
to that key. Callers can continue to use read-only accounts without a signer.

## External signer adapters — the extension point

`ExternalSignerAdapter` (in `src/account/types.ts`) is a **contract only** —
no concrete hardware/mobile/browser adapter ships in SDK core:

```ts
interface ExternalSignerAdapter extends Signer {
  readonly kind: 'hardware' | 'mobile' | 'browser' | 'remote';
  readonly isAvailable: boolean;
}
```

It extends `Signer`, so anything satisfying it already works with
`createAccountWithSigner(identity, adapter)` and with `signWithAccount()` —
no other SDK code needs to change when a real adapter ships.

The SDK's capability registry (`SDK_CAPABILITIES`, `src/errors/capabilities.ts`
— see [Capability Error Standard](./capability_error_standard.md)) already
tracks this extension point under `'signer.remote'`, currently
`status: 'planned'`. A future adapter that can't fulfil a signing request
(unsupported operation, disconnected device, wrong app version) should
signal that the same way any other unsupported SDK capability does:

```ts
import { assertCapability } from 'stellar-pocketpay-sdk';

async function sign(tx, networkPassphrase) {
  if (!deviceIsReachable()) {
    // Throws UnsupportedFeatureError (code SDK_NOT_IMPLEMENTED) because
    // 'signer.remote' is registered as 'planned', not 'supported'.
    assertCapability('signer.remote', false, { module: 'account', operation: 'sign' });
  }
  // ...
}
```

`signWithAccount()` does not catch, wrap, or reinterpret adapter errors — an
`UnsupportedFeatureError` thrown by `sign()` propagates unchanged to the
caller. This means a signer-specific "unsupported" error code would be
redundant; adapters use the same mechanism every other gated SDK capability
uses.

`isAvailable` is a cheap synchronous probe ("is this adapter wired up in the
current build"), not a guarantee that `sign()` will succeed — a device can
still be disconnected or reject the request when `sign()` is actually
called.

## What this model DOES guarantee

- A `ReadOnlyAccount` cannot be made to sign — `canSign` is fixed to `false`
  at the type level and at runtime (`signer` is always `undefined`).
- Signing capability is checked, and can be checked by the caller, before any
  signer is invoked — no implicit fallback to "try and see."
- A wrong signer (public key mismatch) is rejected before submission, with a
  typed, stable error code.
- `LocalSigner` — the SDK's own signer implementation — never exposes its
  secret through public fields, `JSON.stringify()`, or Node's
  `console.log()`/`util.inspect()`.
- No typed error thrown by this layer (`TX_SIGNER_MISSING`,
  `TX_SIGNER_MISMATCH`, or an `UnsupportedFeatureError` raised for
  `'signer.remote'`) includes secret material in its message, `safeMessage`,
  or any other field.

## What this model does NOT guarantee

- **Third-party `Signer`/`ExternalSignerAdapter` implementations are not
  sandboxed.** If you write a custom signer that closes over a secret and
  exposes it via a public field, `toString()`, or logging, this layer cannot
  prevent that — the guarantee above is specific to `LocalSigner`, the
  implementation the SDK ships and controls.
- **`WalletKeypair` (`createWallet()`/`importWallet()`) is a separate, older
  model that this layer does not change.** `secretKey` on a `WalletKeypair`
  is a plain string field — see [Wallet Backup Responsibility](./security.md#wallet-backup-responsibility).
  It is still the primary input to `sendXLM`/`sendAsset`/`depositToVault`/
  `withdrawFromVault`, none of which are part of this signer capability
  architecture (see [ADR-0004](./adr/0004-signer-capability-architecture.md#alternatives-considered)).
- **In-memory secrets are not zeroed or protected against process memory
  inspection.** `LocalSigner` reduces *accidental* exposure (serialization,
  logging) — it is not a substitute for a hardware wallet or HSM when that
  level of protection is required.
- **`isAvailable` on an `ExternalSignerAdapter` is advisory, not a
  guarantee.** A future adapter reporting `isAvailable: true` can still fail
  at `sign()` time.

## Simulation before signing

For state-changing smart contract calls (Soroban), a simulation step must occur **before** the transaction crosses the signing boundary. The `simulateContractCall()` function executes a dry run against the network, returning a `ContractSimulationResult` with a typed `status` (`success` | `warning` | `failed` | `unsupported` | `unknown`). See [Simulation result mapping](./simulation-result-mapping.md).

This ensures that:
1. **Errors are caught early**: If a contract call will fail, it fails during simulation before prompting the user for a signature.
2. **Resource constraints are known**: CPU, RAM, and fee requirements are accurately calculated.
3. **Signatures are valid for the exact outcome**: The user is signing a transaction with deterministic execution paths.

### Example: Simulating a contract call

```ts
import { simulateContractCall, ContractSimulationParams } from 'stellar-pocketpay-sdk';

const params: ContractSimulationParams = {
  contractId: 'C...', // Contract ID
  operation: 'deposit',
  args: [ /* ScVal arguments */ ],
  sourcePublicKey: 'G...',
};

const result = await simulateContractCall(params);

if (!result.success) {
  // failed | unsupported | unknown — do not sign
  console.error('Simulation failed:', result.status, result.error);
  return;
}

if (result.status === 'warning') {
  console.warn('Simulation advisories:', result.warnings);
}

// Proceed to build and sign the transaction using result metrics
console.log('Required CPU:', result.cost?.cpuInstructions);
console.log('Estimated Fee:', result.cost?.minResourceFee);
```

