# Testing

The test suite is split into two lanes: fast offline unit tests that run by
default, and opt-in integration tests that may talk to a live Stellar network.

## Unit tests (default)

```bash
npm test          # or: npm run test:unit
```

This runs every `tests/**/*.test.ts` file except integration tests. These tests
are offline and deterministic: they mock `fetch` or use the injected mock
Horizon server (`setHorizonServerFactory`), so no real network call is made.
This is the suite CI runs on every push and pull request.

The offline guarantee is enforced, not just conventional. A setup file
(`tests/setup/offline-guard.ts`) replaces the global `fetch` with a guard that
throws on any un-mocked call. If a unit test accidentally tries to reach the
network, it fails immediately with a clear message instead of silently making a
real request and becoming flaky. Tests that stub `fetch` themselves keep working
normally; the guard is restored after each test.

## Integration tests (opt-in)

```bash
RUN_INTEGRATION=1 npm run test:integration
```

Integration tests live in `tests/**/*.integration.test.ts` and may make real
calls to Stellar Testnet (Horizon, Friendbot, Soroban RPC). They are:

- excluded from the default suite and from standard CI,
- run only through the integration config, and
- skipped unless `RUN_INTEGRATION=1` is set, so a bare
  `npm run test:integration` is safe and does nothing without the flag.

Because they depend on live Testnet availability, they can be slower and
occasionally non-deterministic. Keep them out of the critical path: the default
`npm test` must always pass offline.

## Adding a test

- Testing SDK logic with mocked responses → add a `*.test.ts` file. It runs in
  the default suite and must not touch the network.
- Testing behaviour against a real network → add a `*.integration.test.ts`
  file and gate it behind `RUN_INTEGRATION` as shown in the existing
  integration example.

For module-by-module expectations (wallet, payments, transactions, vault,
config, utils), see the [SDK Module Test Matrix](./module-test-matrix.md).

For generating and interpreting coverage reports (including CI upload
guidance), see [Test Coverage Baseline](./coverage-baseline.md).

## Scripts

| Command                        | What it runs                                  |
| ------------------------------ | --------------------------------------------- |
| `npm test`                     | Unit suite (offline, default)                 |
| `npm run test:unit`            | Unit suite (explicit alias of `npm test`)     |
| `npm run test:watch`           | Unit suite in watch mode                       |
| `npm run test:integration`     | Integration suite (opt-in, needs the env flag)|
| `npm run verify`               | Lint, circular-deps, unit tests, coverage, build, consumer smoke |
| `npm run presubmit`            | Pre-submission command (same checks + step banners / failure hints) |
| `npm run test:smoke`           | Build and run packaged consumer smoke offline  |
| `npm run smoke:consumer`       | Run consumer smoke after an existing build    |
| `npm run test:coverage`        | Unit suite with V8 coverage report (`coverage/`) |
| `npm run coverage:baseline`    | Coverage run + module baseline summary (see [coverage-baseline.md](./coverage-baseline.md)) |
| `npm run verify:pr`            | Pre-PR script: automated checks + docs/CI/criteria reminders |

For changed-module coverage expectations and CI upload guidance, see
[Test Coverage Baseline](./coverage-baseline.md).
