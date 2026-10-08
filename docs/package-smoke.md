# Packaged SDK consumer smoke gate (#339)

The smoke lane checks the built SDK package entrypoint, not only the TypeScript source tree. It catches broken package-root exports and offline helper regressions that source unit tests may miss.

## Run

At repository root with dependencies installed:

    npm run test:smoke

This compiles the package, then executes one offline consumer script. It checks both the compiled entrypoint and Node's self-referencing require('stellar-pocketpay-sdk') plus its exported package.json subpath.

After an existing successful build, run:

    npm run smoke:consumer

The consumer gate also runs once after build in npm run verify and npm run presubmit; it adds neither another unit suite nor another build to those pipelines.

## Acceptance coverage

- Real package import through exports["."], explicit package.json export and required public API symbols
- Wallet creation, safeImportWallet positive round trip, and malformed-key rejection without logging secrets
- createPaymentIntent and validatePaymentIntent native-XLM happy and invalid cases using locally generated public addresses
- Explicit valid and invalid Testnet configuration via the public validator
- Public ErrorCode, ErrorCategory, describeError and getErrorCategory for an HTTP 429 failure
- Existing stroop conversion, address formatting and typed-amount validation

The smoke test makes no network calls, signs or submits no transactions, creates no accounts on-chain and performs no vault actions. Generated secret key material stays in process memory, never in diagnostic output.

## Maintaining the gate

When supported package-root exports or consumer-facing config/payment/error contracts change, update this script to cover the new behavior. Avoid importing private src modules or mocking the package boundary, as that would undermine its purpose. Focused failures identify the consumer contract that changed, without requiring a full live integration run.

## Execution note

These changes are authored but were not run with Node dependencies in the contributor environment. No hosted CI or Testnet result is claimed.
