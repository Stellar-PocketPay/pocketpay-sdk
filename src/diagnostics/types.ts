/**
 * Diagnostics report and lifecycle event types.
 *
 * All payloads that leave the SDK via hooks or reports are expected to be
 * redacted first — see {@link redactDiagnosticsValue}.
 */

import type { StellarNetwork, ConfigSourceMetadata } from '../types';
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
  // Keep existing synchronous callbacks (including callbacks returning a value)
  // assignable while also accepting asynchronous lifecycle consumers.
  onEvent?: ((event: DiagnosticsEvent) => void) | ((event: DiagnosticsEvent) => Promise<void>);
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
