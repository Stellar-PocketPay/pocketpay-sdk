# SDK Package Boundary & Dependency Direction Map

This is the authoritative reference for which `src/` module owns what, which
direction imports are allowed to flow, and which boundaries are
security-sensitive. [architecture.md](./architecture.md) explains what each
module *does* and how a call flows end to end; this document is the narrower,
enforceable rulebook for *who may import whom*.

Every dependency edge below was verified against the actual source
(`grep -rhoE "from '\.\./[a-z]+" src/<module>`), not inferred from module
names — see [Verifying this map yourself](#verifying-this-map-yourself) to
reproduce it.

## The layers

```
Layer 0   types
             │
Layer 1   errors ── utils ── config ── diagnostics ── network ── account
             │        │        │            │            │         │
Layer 2   wallet ── payments ── transactions ── soroban
                                                     │
Layer 2.5                                         vault
             │
Layer 3                                        src/index.ts
```

- **Layer 0 — `types`.** Shared interfaces and result/error shapes. Zero
  internal dependencies. Every other module depends on it directly or
  transitively.
- **Layer 1 — infrastructure: `errors`, `utils`, `config`, `diagnostics`,
  `network`, `account`.** Cross-cutting concerns available to every feature
  module. May depend on `types` and on each other within this layer (see
  [The config/diagnostics exception](#the-configdiagnostics-exception)
  below). **Must never import a Layer 2 feature module.**
- **Layer 2 — features: `wallet`, `payments`, `transactions`, `soroban`.**
  Domain logic exposed at the package root. May depend on Layer 0 and Layer
  1. Should not import each other — **`transactions` importing from
  `account`** is the one existing exception, and it's a Layer 1 import (see
  below), not a cross-feature one.
- **Layer 2.5 — `vault`.** Not an independent implementation: `vault/index.ts`
  re-exports `depositToVault`, `withdrawFromVault`, `getVaultBalance`, and
  the Soroban result mappers straight from `soroban`, plus vault-specific
  types. It exists purely to give consumers a more discoverable, intention-revealing
  import path for vault calls. Treat it as a facade over `soroban`, not a
  peer feature — new vault behaviour belongs in `soroban`, then gets
  re-exported here if it should be part of the public vault surface.
- **Layer 3 — `src/index.ts`.** The only supported public entry point.
  Re-exports the package's public API from Layers 0–2.5. Deep imports
  (`stellar-pocketpay-sdk/wallet`) are not supported.

`account` sits in Layer 1 rather than alongside the other feature modules
because nothing about it is feature-specific: it's an identity/signing
*abstraction* (`ReadOnlyAccount` vs. `SigningAccount`, a pluggable `Signer`
interface with `ExternalSignerAdapter` as an extension point for
hardware/mobile/browser signers) that any feature module can build on.
Today only `transactions` has adopted it (`offline-preparation.ts` uses
`account/sequence` for staleness checks and `canSignTransaction` for capability
narrowing) — `wallet`, `payments`, and `soroban` still manage keys and signing
inline. That's the intended migration direction, not a violation: as those
modules adopt the account abstraction, they'll import `account` too, the same
way they already import `config` or `network`.

## Per-module ownership

| Module | Owns | Depends on |
| --- | --- | --- |
| `types` | Shared interfaces: config, wallet/balance, payment/history, vault, result envelope (`PocketPayResult<T>`) shapes. No runtime behaviour. | — |
| `errors` | `PocketPayError`, error taxonomy/classification, capability gating (`SDK_CAPABILITIES`), unsupported-feature errors, submission-outcome classification (`classifySubmitError`, `classifySubmissionOutcome`). | `types` |
| `utils` | Validation (`validatePublicKey`, `validateAmount`, ...), unit conversion (`stroopsToXLM`), the `PocketPayResult` wrapping helpers (`toSuccessResult`, `wrapError`, `safe*`). | `errors`, `types` |
| `config` | Resolves caller overrides into `SDKConfig`; exposes `getHorizonServer`, `getSorobanRpcUrl`, `getNetworkPassphrase`. Every networked module reads endpoints from here. | `diagnostics` (hooks only — see below), `types`, `utils` |
| `diagnostics` | Opt-in redacted lifecycle hooks (`enableDiagnostics`, `emitDiagnosticsEvent`) and report building (`buildDiagnosticsReport`, `buildAccountDiagnosticsReport`). Off by default. | `config` (report building and account lookup only), `errors`, `network` (endpoint probe and account lookup), `types`, `utils` (amount math) |
| `network` | Timeout wrapping (`withTimeout`, `fetchWithTimeout`) so a slow endpoint fails instead of hanging. | `config`, `diagnostics`, `errors`, `types`, `utils` |
| `account` | Identity/signing abstraction: `AccountIdentity`, `Signer`, `LocalSigner`, `ExternalSignerAdapter` extension point, sequence-freshness helpers. | `config`, `errors`, `network`, `types`, `utils` |
| `wallet` | Keypair creation (`createWallet`), import, Friendbot funding, balance reads. Never persists a secret key. | `config`, `diagnostics`, `errors`, `network`, `types`, `utils` |
| `payments` | `sendXLM` — validates, resolves endpoints, submits to Horizon. | `config`, `errors`, `network`, `types`, `utils` |
| `transactions` | `getTransactions`/`getPayments` history reads; offline transaction preparation (uses `account` for sequence/signing checks). | `account`, `config`, `diagnostics`, `errors`, `network`, `types`, `utils` |
| `soroban` | Vault contract invocation and result mapping. The only module that talks to Soroban RPC. | `config`, `diagnostics`, `errors`, `network`, `types`, `utils` |
| `vault` | Public-facing re-export of `soroban`'s vault functions and types. No own logic. | `soroban`, `types` |

### The config/diagnostics exception

`config` and `diagnostics` reference each other, and at first glance that
looks like exactly the cycle the layer rule forbids. It isn't one in
practice, and the reason is worth understanding before you touch either
module: `diagnostics` isn't a single flat file, it has its own internal
sub-layer.

- `config/index.ts` imports `emitDiagnosticsEvent` from `diagnostics/hooks.ts`
  — a leaf file with no dependency back on `config`.
- `diagnostics/report.ts` imports `resolveConfig`, `getNetworkPassphrase`,
  and `getFriendbotUrl` from `config` — but `report.ts` is never imported
  *by* `config`.

So the real edge is `config → diagnostics/hooks.ts` and, separately,
`diagnostics/report.ts → config`. No file imports back into a file that
depends on it, which is exactly why `npm run check:circular` reports zero
cycles even though it looks circular at the module (directory) level. The
project's circular-dependency checker (`scripts/check-circular-deps.ts`)
operates on individual files, not directories — a genuine module-level
mutual dependency can still pass it as long as no single file is in both
directions. If you add a new import between `config` and `diagnostics`,
check which *file* you're importing before assuming the layer rule holds:
importing `report.ts` from `config` would create a real cycle that the
existing check might not catch cleanly depending on which file initiates it.

## Security-sensitive boundaries

- **`account` and `wallet`** are the only modules that ever hold or
  construct anything derived from a Stellar secret key (`LocalSigner`,
  `createLocalAccount`, `createWallet`, `importWallet`). Neither module
  persists a secret key anywhere — the caller is responsible for storage
  immediately after creation. Any new code path that touches a secret key
  belongs in one of these two modules, not scattered into `payments` or
  `transactions`.
- **`errors`** owns redaction (`redactSensitive`, `redactError`) and is the
  only place that should decide what's safe to include in a thrown error's
  message. Don't build error messages by hand in a feature module if the raw
  input could contain a secret key or signed XDR — route it through
  `errors`' classification functions instead.
- **`diagnostics`** is opt-in and off by default specifically because it can
  observe call-level events; its own redaction (`redactDiagnosticsValue`) is
  a second, independent redaction layer from `errors`'. If you add a new
  diagnostics event, redact it there too — don't assume `errors`' redaction
  already covers it, since diagnostics events aren't always constructed from
  a `PocketPayError`.
- **`account`'s `ExternalSignerAdapter`** is an extension point for
  hardware/mobile/browser signers that this SDK doesn't implement itself.
  Any consumer wiring one in is responsible for that signer's own security
  properties — the SDK's guarantees (no persistence, redaction) only cover
  the `LocalSigner` path.

## Cross-module integration examples

**Correct — feature module reading config through the resolver, not
constructing its own endpoint:**

```typescript
// src/payments/index.ts
import { resolveConfig, getHorizonServer } from '../config';

export async function sendXLM(params: SendXLMParams) {
  const config = resolveConfig(params.config);
  const server = getHorizonServer(config);
  // ...
}
```

**Incorrect — a feature module reaching past `config` to hardcode an
endpoint, or reaching into another feature module's internals instead of
its public exports:**

```typescript
// Don't do this in any feature module:
const server = new Horizon.Server('https://horizon-testnet.stellar.org'); // bypasses config's URL validation and pluggable server factory

// Don't do this either — reaching past `account`'s public index into an
// internal file:
import { LocalSigner } from '../account/signer'; // internal detail, not re-exported
```

**Correct — a new feature module adopting the account abstraction, the same
way `transactions` does:**

```typescript
// A hypothetical future feature module
import { canSignTransaction, type AccountAbstraction } from '../account';

function requireSigner(account: AccountAbstraction) {
  if (!canSignTransaction(account)) {
    throw new Error('This operation requires a signing account');
  }
  return account.signer;
}
```

**Correct — consuming applications only ever import from the package root:**

```typescript
import { createWallet, sendXLM, depositToVault } from 'stellar-pocketpay-sdk';
```

**Incorrect — a deep import into an internal module path:**

```typescript
import { createWallet } from 'stellar-pocketpay-sdk/wallet'; // not a supported entry point; not guaranteed to work across versions
```

## Verifying this map yourself

```bash
# Confirm no circular imports exist (file-level check):
npm run check:circular

# See exactly which modules a given module imports from:
grep -rhoE "from '\.\./[a-z]+" src/<module> | sed "s|from '\.\./||" | sort -u
```

## See also

- [Architecture Documentation](./architecture.md) — what each module does
  and how a call flows from the package root to the network.
- [Security Best Practices](./security.md) — key management and transaction
  safety from a consuming application's perspective.
- [SDK Diagnostics](./diagnostics.md) — the opt-in diagnostics module in
  depth.
