# Simulation result mapping

The SDK converts raw Soroban `simulateTransaction` responses into a typed
{@link SimulationMappedResult} with one of five statuses:

| Status | `success` | Meaning |
| --- | --- | --- |
| `success` | `true` | Simulation completed; safe to assemble / sign when applicable |
| `warning` | `true` | Simulation completed with non-fatal advisories (events, RPC warnings) |
| `failed` | `false` | Simulation returned a contract or runtime error |
| `unsupported` | `false` | Response requires a path this client cannot complete (e.g. state restore) |
| `unknown` | `false` | Response shape could not be classified safely |

## API

```ts
import {
  mapSimulationResult,
  simulateContractCall,
  pocketPayErrorFromSimulation,
  ErrorCode,
} from 'stellar-pocketpay-sdk';

const mapped = mapSimulationResult(rawRpcResponse);

if (!mapped.success) {
  // failed | unsupported | unknown — do not sign
  throw pocketPayErrorFromSimulation(mapped);
}

if (mapped.status === 'warning') {
  // Inspect mapped.warnings before proceeding
}

// success — use cost metrics / retval as needed
console.log(mapped.cost?.minResourceFee);
```

`simulateContractCall()` runs a dry-run against Soroban RPC and returns the same
mapped shape (`ContractSimulationResult`).

## Contradictory RPC fields: fail closed

An explicit non-null RPC `error` field always wins over success-looking
`result`, `transactionData`, or `minResourceFee` metadata, **including**
when the installed Stellar SDK's `isSimulationError` helper returns
`false`. Such a payload maps to `{ success: false, status: 'failed' }`
and remains ineligible for signing or transaction submission. A structured
error mapper may still supply a contract-specific error code; it cannot
make the simulation proceedable. This is a response-integrity rule, not a
claim that the SDK helper was called incorrectly.

The focused `tests/simulation-mapper.test.ts` regression explicitly mocks
a conflicting SDK guard and confirms that failure takes precedence. This
test must be executed in a checkout with the existing Vitest dependencies
before describing this change as a verified runtime pass.

## Soroban client integration

`ContractClient` (`readOnly`, `invoke`, and auth simulation) runs every response
through `mapSimulationResult` before assembling or signing:

- **readOnly** — throws a typed `PocketPayError` when `success` is false
- **invoke** — returns `{ success: false, status: 'simulation_error', simulationStatus }`
  without signing when simulation is not proceedable
- **warning** — treated as proceedable; `warnings` are attached to successful invoke results

Error codes:

- `SOROBAN_SIMULATION_FAILED` — `failed`
- `SOROBAN_SIMULATION_UNSUPPORTED` — `unsupported` (e.g. restore preamble)
- `SOROBAN_SIMULATION_UNKNOWN` — unclassifiable payload

Contract-specific remaps (via `ContractClient` error maps) still apply on the
simulation `error` string before the default Soroban codes.

## Safety

- Mapped results may include `rawSimulation` for diagnostics; the SDK does not
  log raw RPC payloads.
- Prefer checking `status` (not only `success`) when handling restore /
  unknown cases differently from contract failures.
- Do not prompt for signatures when `success` is `false`.

See also [Signing boundaries](./signing-boundaries.md).
