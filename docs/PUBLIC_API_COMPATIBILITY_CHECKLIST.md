# Public API Compatibility Checklist

Use this checklist for any pull request that changes exports, public types, public
error codes, function signatures, configuration fields, or documented package
behavior.

The governing policy is [Public API Governance](./public-api-governance.md).

## 1. Scope the public surface

- [ ] I checked whether the change affects anything imported from the package
  root (`stellar-pocketpay-sdk`).
- [ ] I did not add a supported deep-import path. Only the package root and
  `./package.json` are exported by `package.json`.
- [ ] New implementation helpers stay internal unless they are intentionally
  added to the root API.

## 2. Classify compatibility

- [ ] The change is classified as **additive**, **deprecation**, or
  **breaking**.
- [ ] Existing function signatures, parameter meaning, return shapes, public
  types, constants, and error-code semantics remain compatible unless this is
  an intentional breaking change.
- [ ] Any breaking change has an explicit migration path and release/versioning
  plan.

## 3. Run the focused export gate

- [ ] `npm run check:public-api` passes.
- [ ] New intended runtime exports are added to
  `tests/exports.test.ts`'s required export set.
- [ ] New intended public types are imported from the package root in the export
  test so TypeScript compilation verifies that they remain public.
- [ ] Internal helpers are not accidentally exposed from the package root.

## 4. Documentation and examples

- [ ] Public API documentation is updated for new or changed behavior.
- [ ] Examples import from the package root rather than `src/*`, `dist/*`,
  or another deep path.
- [ ] Deprecations name the replacement API and expected removal window.
- [ ] Known compatibility limitations are documented rather than hidden.

## 5. Changelog and acceptance

- [ ] `CHANGELOG.md` has an `[Unreleased]` entry for user-visible public API
  changes.
- [ ] The PR explains which issue acceptance criteria are satisfied.
- [ ] Review notes call out compatibility risk explicitly when the change is not
  purely additive.
