# Offline, deterministic SDK integration scenarios

These utilities live in `tests/fixtures` and are **test-only**. They are not
part of the published package API. Their purpose is to exercise real SDK
callers while controlling the remote Horizon, Soroban and vault boundaries.

## Reuse existing domain builders, not clock-driven mocks

The fixtures export `accountFixtures`, `paymentFixtures`,
`transactionFixtures`, `networkFixtures`, `sorobanFixtures` and
`vaultFixtures`, plus the corresponding builders. Four timestamp-bearing
builders default to the fixed instant `2024-01-15T10:30:00.000Z`.
`set`, `merge`, `clone`, `reset` and `build` preserve independent copies
of nested data and dates. `reset()` restores complete constructor defaults.

Do not edit the exported singleton fixture objects. For test isolation,
build or clone your own fixture, or use `createSdkScenario`, which returns
new values for each request. Use `builder.set('createdAt', new Date(...))`
when a particular timestamp is required.

## Integrated scenarios

```ts
import { createSdkScenario } from './fixtures';

const ready = createSdkScenario('success');
const declined = createSdkScenario('failure');
const timedOut = createSdkScenario('timeout');
const unsupported = createSdkScenario('unsupported');
const uncertain = createSdkScenario('unknown');

expect(uncertain.transaction.status).toBe('unknown');
expect(timedOut.network.timeout).toBe(true);
expect(unsupported.soroban.error).toBe('Unsupported feature');
```

The five names correlate account, payment, transaction, network, Soroban and
vault mock outcomes. They do **not** assert that all of these states occur
simultaneously on a live network. An unknown submission is not a failed
submission and must not be blindly re-sent.

## Production-facing network tests

```ts
import { vi, expect } from 'vitest';
import { NetworkClient } from '../../src/network';
import { createFetchFromFixture, networkFixtures } from './fixtures';

vi.stubGlobal('fetch', vi.fn(createFetchFromFixture(networkFixtures.rateLimited)));
const client = new NetworkClient({ baseUrl: 'https://example.test' });
await expect(client.get('/ping')).rejects.toMatchObject({
  statusCode: 429,
  retryable: true,
});
vi.unstubAllGlobals();
```

`createFetchFromFixture` creates a **new** response per call, with JSON and
text readers. `timeout` rejects with `AbortError`, HTTP scenarios resolve
with the specified status, headers and body. The adapter never fetches a URL;
installation and cleanup of the mock remain explicit in the calling test.
This covers transport-classification paths, not a real timed AbortController
or actual Horizon/RPC calls.

## Adding a scenario

Add a named fixture via an existing builder in its domain file and export it
through that domain's index. Add it to `createSdkScenario` only when it
represents a useful cross-boundary state. Choose fixed timestamps, literal
IDs and self-contained objects. Exercise the real SDK boundary with a mock;
avoid sleeps, live Testnet, nondeterministic keys and mutation of shared
singleton fixture objects. Existing focused regressions:
`tests/fixture-framework.test.ts` and `tests/network-client.test.ts`.
