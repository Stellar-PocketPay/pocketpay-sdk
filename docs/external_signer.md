# External signer integration — abort-aware approvals (Issue #212)

PocketPay has a public `Signer` and `ExternalSignerAdapter` for hardware,
mobile, browser and remote services. The existing type remains compatible with
`createAccountWithSigner(identity, adapter)`. It keeps private key material
outside the SDK, but its original two-argument `sign` call does **not** define
cancellation or typed transport outcomes.

For interactive integrations, implement the opt-in
`AbortableExternalSignerAdapter` and call `requestExternalSignature`.
The contract takes an unsigned Stellar transaction, a network passphrase and
an `AbortSignal` — **never a secret key**. Its results are discriminated:

| Status | Meaning | Automatic retry |
| --- | --- | --- |
| `signed` | The adapter returned a signed transaction | No (use the normal guarded submission flow) |
| `cancelled` | The caller or device cancelled | No |
| `rejected` | User denied the request | No |
| `unavailable` | Signer disconnected or not ready | No; reconnect and ask for explicit new consent |
| `mismatch` | Signer public key differs from requested identity | No |
| `failed` | Transport or unknown error (details redacted) | No |

```ts
import {
  requestExternalSignature,
  type AbortableExternalSignerAdapter,
} from 'pocketpay-sdk';

// An app/device integration implements requestSignature, including AbortSignal
// handling and explicit approval before returning a signed transaction.
declare const device: AbortableExternalSignerAdapter;
declare const transaction: import('@stellar/stellar-sdk').Transaction;

const controller = new AbortController();
const outcome = await requestExternalSignature(
  device,
  transaction,
  'Test SDF Network ; September 2015',
  { expectedPublicKey: device.publicKey, signal: controller.signal },
);
if (outcome.status === 'signed') {
  // Explicit next action: inspect and submit with the SDK's guarded
  // transaction lifecycle. requestExternalSignature itself never submits.
  console.log('Signing approved');
} else {
  console.log(outcome.status); // safe, stable status only
}
// On user cancellation: controller.abort();
```

## Adapter obligations and failure handling

- `kind` and `isAvailable` from the original interface remain descriptive.
- Implement `requestSignature({transaction, networkPassphrase, signal})`
  with real user approval, matching account identity and correct network
  selection. Return a typed `signed/rejected/cancelled/unavailable/failed`
  outcome. Keep raw device exceptions and private material out of results.
- Honor the passed `AbortSignal` by stopping approval prompts and
  communication where the hardware/transport permits. The SDK races
  cancellation so consumers promptly receive `cancelled` and discard any
  late signature even when an adapter fails to stop. This does **not**
  forcibly cancel hardware cryptographic work that has already begun.
- Never auto-resubmit after timeout, cancellation, or unknown state. Signature
  acquisition and network submission are separate; only explicitly signed
  outcomes enter guarded transaction submission.
- The existing `Signer.sign(transaction, networkPassphrase)` signature and
  local `LocalSigner` remain untouched; legacy adapters keep working.
- Public contracts: `src/account/types.ts`,
  `src/account/external-signer.ts`, `src/account/index.ts` and the root
  `src/index.ts` exports. Focused tests: `tests/external-signer.test.ts`.
