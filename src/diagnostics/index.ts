/**
 * SDK diagnostics and observability (opt-in, redacted).
 *
 * @packageDocumentation
 */

export type {
  DiagnosticsDomain,
  DiagnosticsHooks,
  EnableDiagnosticsOptions,
  SafeConfigSnapshot,
  SafeNetworkSnapshot,
  CapabilityDiagnosticsEntry,
  WalletCapabilitySnapshot,
  VaultReadinessSnapshot,
  DiagnosticsReport,
  DiagnosticsEvent,
  DiagnosticsSensitiveKey,
  AccountDiagnosticsSnapshot,
  PaymentReadinessSnapshot,
  PaymentReadinessReason,
  AccountDiagnosticsLookup,
  BuildAccountDiagnosticsOptions,
  AccountDiagnosticsReport,
} from './types';

export { DIAGNOSTICS_SENSITIVE_KEYS } from './types';

export {
  redactDiagnosticsValue,
  redactDiagnosticsString,
  isDiagnosticsSensitiveKey,
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
} from './redact';

export {
  enableDiagnostics,
  disableDiagnostics,
  setDiagnosticsHooks,
  resetDiagnosticsHooks,
  isDiagnosticsEnabled,
  getDiagnosticsHooks,
  emitDiagnosticsEvent,
} from './hooks';

export { buildDiagnosticsReport } from './report';
export { buildAccountDiagnosticsReport } from './account';

export { probeConfiguredEndpoints } from './probe';
export type { EndpointDiagnostics } from './probe';
