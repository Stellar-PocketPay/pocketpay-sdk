# Configuration (Environment Variables)

This SDK can be configured via environment variables. If you also pass configuration objects to SDK functions, **function-level overrides take precedence** over environment variables, which in turn take precedence over SDK defaults.

## Quick reference

| Variable | Purpose | Required? | Default (when omitted) | Example |
|---|---|---:|---|---|
| `STELLAR_NETWORK` | Selects the Stellar network to connect to. | No | `testnet` | `STELLAR_NETWORK=testnet` |
| `STELLAR_HORIZON_URL` | Overrides the Horizon server URL used for ledger queries. | No | Based on `STELLAR_NETWORK` | `STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org` |
| `STELLAR_SOROBAN_RPC_URL` | Overrides the Soroban RPC endpoint used for Soroban contract interactions. | Required on `mainnet` | Testnet SDF endpoint; no Mainnet SDF default | `STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org` |
| `STELLAR_TIMEOUT` | Request timeout in milliseconds. | No | `30000` | `STELLAR_TIMEOUT=45000` |
| `STELLAR_CONTRACT_ID` | Optional Soroban contract id used when resolving config (validated if provided). | No | Not set | `STELLAR_CONTRACT_ID=C...` |
| `VAULT_CONTRACT_ID` | Vault contract id used by vault functions when `contractId` is not provided via params. | Conditional | No default — must be provided for vault ops without param | `VAULT_CONTRACT_ID=C...` |
| `POCKETPAY_FEATURE_FLAGS` | Comma-separated list of experimental feature flags to enable. | No | Not set | `POCKETPAY_FEATURE_FLAGS=experimentalVault` |
| `POCKETPAY_FEATURE_<FLAG>` | Enable specific experimental feature flag (e.g. `POCKETPAY_FEATURE_EXPERIMENTAL_VAULT=true`). | No | `false` | `POCKETPAY_FEATURE_EXPERIMENTAL_VAULT=true` |

## Supported network presets

The SDK supports Testnet and Mainnet network/passphrase presets. Testnet also has an SDF Soroban RPC default; Mainnet requires an explicit ecosystem-provider RPC URL.

| Network | Horizon URL | Soroban RPC URL | Network passphrase |
|---|---|---|---|
| `testnet` | `https://horizon-testnet.stellar.org` | `https://soroban-testnet.stellar.org` | `getNetworkPassphrase('testnet')` (`Networks.TESTNET`) |
| `mainnet` | `https://horizon.stellar.org` | **Provider required** (no public SDF Mainnet RPC) | `getNetworkPassphrase('mainnet')` (`Networks.PUBLIC`) |

Only exact `http:` and `https:` endpoint schemes are accepted. Similar-looking schemes such as `httpx:` or `httpsx:` are invalid.

SDF publishes public Stellar RPC endpoints for Testnet/Futurenet, not Mainnet. Mainnet consumers must choose an ecosystem RPC provider and set `STELLAR_SOROBAN_RPC_URL` or pass `sorobanRpcUrl` programmatically. `resolveConfig({ network: 'mainnet' })` therefore fails closed when neither is supplied instead of advertising an unavailable default.

A programmatic `networkPassphrase` is optional. When supplied, it must exactly match the selected network preset; otherwise both `resolveConfig` and `validatePocketPayConfig` report `INVALID_NETWORK_PASSPHRASE`. Explicit invalid values such as `null` are rejected rather than replaced with a default.

```ts
import {
  getNetworkPassphrase,
  resolveConfig,
  validatePocketPayConfig,
} from 'stellar-pocketpay-sdk';

const mainnet = resolveConfig({
  network: 'mainnet',
  networkPassphrase: getNetworkPassphrase('mainnet'),
  sorobanRpcUrl: 'https://rpc.mainnet.example.com',
});

const validation = validatePocketPayConfig({
  network: 'testnet',
  networkPassphrase: getNetworkPassphrase('testnet'),
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
});
```

## Vault contract id behavior

Vault functions require a contract id.

- If you pass `contractId` via the function params, that value is used.
- Otherwise, the SDK reads `SDKConfig.contractId` from the config you pass to the
  vault function.
- Otherwise, the SDK falls back to the `VAULT_CONTRACT_ID` env var, then
  `STELLAR_CONTRACT_ID`.
- If none is provided, vault functions throw a `CapabilityMismatchError` with the
  published code `VAULT_CONTRACT_NOT_CONFIGURED`. See
  [Capability Error Standard](./capability_error_standard.md).

## Example `.env`

```bash
# Network (default: testnet)
STELLAR_NETWORK=testnet

# Optional overrides (defaults are resolved from STELLAR_NETWORK)
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Vault (required unless you pass contractId in params)
VAULT_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Optional
STELLAR_TIMEOUT=45000
# STELLAR_CONTRACT_ID=C...   # optional (validated if provided)
```

## Request timeouts

Network-dependent SDK functions use a 30 second timeout by default. Override it
with `STELLAR_TIMEOUT` or pass `{ timeout: 10000 }` to functions that accept SDK
config, such as `getBalance`, `getTransactions`, `getPayments`, `sendXLM`, and
`fundTestnetAccount`.

When a request times out, the SDK throws a `PocketPayError` with code
`REQUEST_TIMEOUT` and a message that includes the operation and timeout duration.
Timeouts also carry `error.timeout.stage`; submission and confirmation timeouts
report `TX_STATUS_UNKNOWN` instead, because the transaction's outcome is
undetermined. See [Timeout Classification](./timeout-classification.md).

## Early Configuration Validation

Applications can validate SDK configurations early before initiating network or transaction operations using `validatePocketPayConfig`.

Unlike `resolveConfig`, `validatePocketPayConfig` does not throw exceptions. Instead, it returns a structured `ConfigValidationResult` containing:
- `valid`: `boolean` (`true` when zero errors are found)
- `errors`: List of fatal validation issues (e.g. invalid network, malformed URLs, invalid timeout, bad contract ID format, or a network-passphrase mismatch)
- `warnings`: Advisory non-fatal issues (e.g. HTTP/HTTPS protocol mismatches, mainnet/testnet endpoint mismatches, extreme timeout values)
- `issues`: Complete list of all errors and warnings
- `config`: Resolved `SDKConfig` (populated when `valid` is `true`)

### Usage Example

```ts
import { validatePocketPayConfig } from 'stellar-pocketpay-sdk';

const validationResult = validatePocketPayConfig({
  network: 'testnet',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  timeout: 30000,
});

if (!validationResult.valid) {
  console.error('Configuration validation failed:');
  for (const error of validationResult.errors) {
    console.error(`- [${error.field}] ${error.code}: ${error.message}`);
  }
} else {
  console.log('SDK Configuration is valid:', validationResult.config);
  
  if (validationResult.warnings.length > 0) {
    for (const warning of validationResult.warnings) {
      console.warn(`- [${warning.field}] Warning ${warning.code}: ${warning.message}`);
    }
  }
}
```

### Security & Secret Redaction

Validation issue outputs never expose sensitive keys (e.g. Stellar secret keys `S...`). Any sensitive value passed in malformed inputs is automatically redacted (masked as `S[REDACTED]`) before being returned in validation issues.
