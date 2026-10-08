# Public API Governance

This document defines what PocketPay SDK considers public, how contributors
detect API drift, and how maintainers review compatibility changes.

## Public versus internal modules

The supported package surface is the package root:

```ts
import { createWallet, sendXLM, type SDKConfig } from 'stellar-pocketpay-sdk';
```

`package.json` exports only `.` and `./package.json`. Files below
`src/`, generated files below `dist/`, and other repository paths are
implementation details unless they are re-exported from the root. Consumers
must not rely on deep imports such as
`stellar-pocketpay-sdk/dist/network/client`.

A symbol is public when it is intentionally reachable from the package root.
That includes runtime functions/classes/constants and TypeScript types.

## Compatibility gate

Run the focused gate whenever a pull request changes the public surface:

```bash
npm run check:public-api
```

The command runs `tests/exports.test.ts`, which provides two complementary
checks:

1. Required runtime symbols must still be reachable from the root module.
2. Public TypeScript types are imported from the root in the test file, so a
   removed or non-exported type fails TypeScript compilation.

The test also asserts that selected implementation-only helpers remain absent
from the package root.

When intentionally adding a public API, update the required runtime export list
and/or the root type imports in the same pull request. Removing an entry to make
the gate pass is not sufficient justification for a breaking change; the
versioning and changelog rules below still apply.

## Compatibility classes

### Additive

Examples:

- a new optional configuration field with a backwards-compatible default;
- a new root export that does not change existing behavior;
- a new error code for a previously untyped failure path.

Additive changes may ship in a minor release when they do not alter existing
consumer behavior.

### Deprecation

Keep the old API working during the documented migration window. Documentation
must name the replacement and `CHANGELOG.md` must record the deprecation.

### Breaking

Examples:

- removing or renaming a root export;
- changing parameter order or required parameters;
- narrowing or changing a public return/type shape;
- changing stable error-code meaning;
- making an existing synchronous/async contract incompatible.

Breaking changes require an explicit migration note and a major-version release
plan. Do not hide a breaking change inside an unrelated refactor.

## Changelog policy

Any user-visible public API change must add an entry under
`CHANGELOG.md#Unreleased` before merge. State whether it is additive,
deprecated, or breaking. Breaking/deprecation entries must include the
replacement or migration path.

Purely internal refactors that leave the root API and documented behavior
unchanged do not need a public API changelog entry.

## Examples and documentation

Examples and integration docs must consume the package exactly as users do:
through the root package import. Do not demonstrate `src/*` or `dist/*`
deep imports.

When adding a public API:

1. export it from the package root;
2. add it to the focused export gate;
3. document its behavior and compatibility expectations;
4. update `CHANGELOG.md`;
5. complete
   [the public API compatibility checklist](./PUBLIC_API_COMPATIBILITY_CHECKLIST.md).

## Reviewer guidance

Reviewers should reject accidental API drift even when the implementation
itself is correct. For a public-surface change, confirm:

- root exports and types are intentional;
- `npm run check:public-api` is green;
- examples use root imports only;
- compatibility is classified correctly;
- changelog/migration notes match the compatibility class.

This process is intentionally narrow: it protects the published SDK contract
without requiring a full test or build sweep for documentation-only changes.
