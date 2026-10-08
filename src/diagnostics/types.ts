/**
 * Diagnostics report and lifecycle event types.
 *
 * All payloads that leave the SDK via hooks or reports are expected to be
 * redacted first — see {@link redactDiagnosticsValue}.
 */

import type {
  StellarNetwork,
  ConfigSourceMetadata,
  SDKConfig,
  BalanceResult,
} from '../types';
import type { CapabilityStatus } from '../errors';

/** Domains covered by diagnostics events and report sections. */
export type DiagnosticsDomain =
  | 'config'
  | 'network'
  | 'transaction'
  | 'wallet'
  | 'vault'
  | 'capability';

/**
 * Opt-in hooks for SDK lifecycle observability.
 * Hooks are off by default; register via {@link enableDiagnostics}.
 */
export interface DiagnosticsHooks {
  /**
   * Called for each lifecycle event when diagnostics are enabled.
   * Receives a redacted event — never secret keys, seeds, or signed XDR.
   */
  onEvent?: (event: DiagnosticsEvent) => void;
}

/** Options for enabling diagnostics. */
export interface EnableDiagnosticsOptions {
  /** Lifecycle hooks. Omit for report-only mode (no event callbacks). */
  hooks?: DiagnosticsHooks;
  /**
   * Also enable when `POCKETPAY_DEBUG=true`. Default true.
   * Environment alone does not register hooks — it only allows emit when
   * hooks were previously set, or when used with {@link isDiagnosticsEnabled}.
   */
  respectEnv?: boolean;
}

/** Safe configuration snapshot for support reports. */
export interface SafeConfigSnapshot {
  network: StellarNetwork;
  horizonUrl: string;
  sorobanRpcUrl: string;
  timeoutMs: number;
  /** Whether a vault/contract id is configured — never the raw id if you prefer opacity; we include the public contract id (C...) as it is on-chain public. */
  contractIdConfigured: boolean;
  /** Public contract id when configured; omitted when unset. */
  contractId?: string;
  /** Non-sensitive origin metadata for configuration settings. */
  sources?: ConfigSourceMetadata;
  /** Active experimental feature flags state. */
  featureFlags?: Record<string, boolean>;
}

/** Safe network / connectivity-oriented snapshot. */
export interface SafeNetworkSnapshot {
  network: StellarNetwork;
  horizonUrl: string;
  sorobanRpcUrl: string;
  passphraseKnown: boolean;
  friendbotAvailable: boolean;
}

/** One capability row in a diagnostics report. */
export interface CapabilityDiagnosticsEntry {
  name: string;
  status: CapabilityStatus;
  module: string;
  requires?: string;
  description: string;
}

/** Wallet surface readiness — never includes key material. */
export interface WalletCapabilitySnapshot {
  canCreate: boolean;
  canImport: boolean;
  canQueryBalance: boolean;
  canFundTestnet: boolean;
}

/** Vault readiness without secrets or raw invocation payloads. */
export interface VaultReadinessSnapshot {
  capabilityStatus: CapabilityStatus;
  contractIdConfigured: boolean;
  ready: boolean;
  reason?: string;
}

/**
 * Structured, shareable diagnostics report for support workflows.
 * Safe to attach to tickets when produced by {@link buildDiagnosticsReport}.
 */
export interface DiagnosticsReport {
  generatedAt: string;
  sdkName: string;
  sdkVersion: string;
  diagnosticsEnabled: boolean;
  config: SafeConfigSnapshot;
  network: SafeNetworkSnapshot;
  capabilities: CapabilityDiagnosticsEntry[];
  wallet: WalletCapabilitySnapshot;
  vault: VaultReadinessSnapshot;
}

/** Public account state included in an account-focused support report. */
export interface AccountDiagnosticsSnapshot {
  /**
   * The queried public key (`G...`). Replaced with `[REDACTED]` when the
   * input was not a valid public key, so mistaken input is never echoed.
   */
  publicKey: string;
  /** `funded` / `unfunded` (Horizon 404) / `error` (lookup failed or invalid key). */
  status: 'funded' | 'unfunded' | 'error';
  /** Native XLM balance as reported by Horizon (funded accounts only). */
  nativeBalance?: string;
  /** Number of balance entries, native included (funded accounts only). */
  assetCount?: number;
  /**
   * Lower-bound minimum balance: (2 + trustlines) x 0.5 XLM. Offers, extra
   * signers, data entries, sponsorships and liabilities can raise the real
   * minimum (funded accounts only).
   */
  estimatedMinimumBalance?: string;
  /** Stable machine-readable code when `status` is `error`. */
  errorCode?: string;
  /** Fixed, SDK-authored message; provider messages are never forwarded. */
  errorMessage?: string;
  /** HTTP status of a failed Horizon lookup, when one was available. */
  errorHttpStatus?: number;
}

/** Reason codes that can appear in {@link PaymentReadinessSnapshot.reasons}. */
export type PaymentReadinessReason =
  | 'INVALID_PUBLIC_KEY'
  | 'ACCOUNT_STATE_UNAVAILABLE'
  | 'ACCOUNT_UNFUNDED'
  | 'NO_NATIVE_XLM_FOR_FEES'
  | 'NETWORK_CONFIGURATION_UNAVAILABLE';

/**
 * Coarse payment readiness derived only from account/config prerequisites.
 * It does not replace destination, amount, trustline, sequence or operation
 * validation for an actual payment.
 */
export interface PaymentReadinessSnapshot {
  /** `unknown` only when account state could not be loaded. */
  status: 'ready' | 'not_ready' | 'unknown';
  accountFunded: boolean;
  /** Native balance exceeds the estimated minimum balance by at least 100 stroops. */
  feeBalancePresent: boolean;
  networkConfigured: boolean;
  /** Empty when `status` is `ready`. */
  reasons: PaymentReadinessReason[];
}

/** Deterministic account lookup seam for tests and offline support tooling. */
export type AccountDiagnosticsLookup = (
  publicKey: string,
  config?: Partial<SDKConfig>,
) => Promise<BalanceResult>;

export interface BuildAccountDiagnosticsOptions {
  /** SDK config overrides (same semantics as `resolveConfig`). */
  config?: Partial<SDKConfig>;
  /**
   * Account source. Defaults to one Horizon `loadAccount` read through the
   * configured server; `getBalanceOrUnfunded` or a stub can be injected.
   */
  lookup?: AccountDiagnosticsLookup;
}

/** Existing redacted SDK diagnostics plus account and payment-readiness state. */
export interface AccountDiagnosticsReport extends DiagnosticsReport {
  account: AccountDiagnosticsSnapshot;
  paymentReadiness: PaymentReadinessSnapshot;
}

/** Lifecycle event emitted to opt-in hooks. */
export interface DiagnosticsEvent {
  /** Event schema version for forward compatibility. */
  schemaVersion: 1;
  domain: DiagnosticsDomain;
  /** Stable event name, e.g. `config.resolved`, `transaction.submit.succeeded`. */
  type: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Redacted contextual data. */
  data: Record<string, unknown>;
}

/** Known sensitive object keys always replaced with `[REDACTED]`. */
export const DIAGNOSTICS_SENSITIVE_KEYS = [
  'secretKey',
  'secret',
  'seed',
  'seedPhrase',
  'mnemonic',
  'signedXDR',
  'xdr',
  'envelope',
  'signature',
  'signatures',
  'privateKey',
  'sourceSecret',
  'password',
  'passphrase',
  'token',
  'authorization',
  'apiKey',
] as const;

export type DiagnosticsSensitiveKey = (typeof DIAGNOSTICS_SENSITIVE_KEYS)[number];
