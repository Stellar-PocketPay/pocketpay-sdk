/**
 * Stellar PocketPay SDK — Account Module
 *
 * Provides the account abstraction layer that separates wallet identity,
 * signing capability, public account data, and transaction authorisation.
 *
 * Public API
 * ──────────
 * Types:
 *   - `AccountIdentity`     — public key identity; no secrets
 *   - `Signer`              — interface for any signing implementation
 *   - `ExternalSignerAdapter` — extension point for hardware/mobile/browser signers (contract only)
 *   - `LocalSignerConfig`   — configuration for a local (in-memory) signer
 *   - `AccountAbstraction`  — `ReadOnlyAccount | SigningAccount` discriminated union
 *   - `ReadOnlyAccount`     — identity only, no signer, `canSign: false`
 *   - `SigningAccount`      — identity + signer, `canSign: true`
 *
 * Classes:
 *   - `LocalSigner`         — `Signer` implementation backed by a local keypair
 *
 * Factory functions:
 *   - `createReadOnlyAccount(publicKey)`      — identity only, no signing
 *   - `createLocalAccount(secretKey)`         — identity + LocalSigner
 *   - `createAccountWithSigner(identity, signer?)` — identity + custom signer
 *   - `createLocalSigner(secretKey)`          — standalone LocalSigner helper
 *
 * Capability check:
 *   - `canSignTransaction(account)`           — type guard narrowing to `SigningAccount`
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  AccountIdentity,
  Signer,
  ExternalSignerAdapter,
  LocalSignerConfig,
  AccountAbstraction,
  ReadOnlyAccount,
  SigningAccount,
} from './types';

// ─── Capability check ─────────────────────────────────────────────────────────
export { canSignTransaction } from './types';

// ─── Signer implementations ──────────────────────────────────────────────────
export { LocalSigner, createLocalSigner } from './signer';

// ─── Account factories ───────────────────────────────────────────────────────
export {
  createReadOnlyAccount,
  createLocalAccount,
  createAccountWithSigner,
} from './account';

// ─── Sequence handling ───────────────────────────────────────────────────────
export {
  SequenceProvider,
  defaultSequenceProvider,
  validateSequenceValue,
  isSequenceStale,
  DEFAULT_SEQUENCE_MAX_AGE_MS,
} from './sequence';

export type { SequenceSnapshot, SequenceProviderOptions } from './sequence';

// ─── Testnet account diagnostics ─────────────────────────────────────────────
export { diagnoseTestnetAccount } from './testnet';
export type {
  TestnetAccountStatus,
  TestnetAccountDiagnostic,
  FundedTestnetAccountDiagnostic,
  UnfundedTestnetAccountDiagnostic,
  UnavailableTestnetAccountDiagnostic,
  TestnetAccountLookup,
  DiagnoseTestnetAccountOptions,
} from './testnet';
