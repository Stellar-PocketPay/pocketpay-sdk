/**
 * Opt-in diagnostics hook registry.
 *
 * Mirrors the Horizon server factory pattern: disabled by default, process-local,
 * and resettable for tests. Emit is a no-op unless diagnostics are enabled.
 */

import { redactDiagnosticsValue } from './redact';
import type {
  DiagnosticsDomain,
  DiagnosticsEvent,
  DiagnosticsHooks,
  EnableDiagnosticsOptions,
} from './types';

let hooks: DiagnosticsHooks | null = null;
let explicitlyEnabled = false;

function envDebugEnabled(): boolean {
  return process.env.POCKETPAY_DEBUG === 'true';
}

/**
 * Enable diagnostics and optionally register lifecycle hooks.
 * Off by default — call this explicitly from app bootstrap or support tooling.
 */
export function enableDiagnostics(options: EnableDiagnosticsOptions = {}): void {
  explicitlyEnabled = true;
  if (options.hooks) {
    hooks = { ...options.hooks };
  }
}

/**
 * Replace the active hooks without toggling the enabled flag.
 * Prefer {@link enableDiagnostics} for first-time setup.
 */
export function setDiagnosticsHooks(next: DiagnosticsHooks): void {
  hooks = { ...next };
  explicitlyEnabled = true;
}

/**
 * Disable diagnostics and clear hooks.
 */
export function disableDiagnostics(): void {
  explicitlyEnabled = false;
  hooks = null;
}

/**
 * Alias for {@link disableDiagnostics} — matches `resetHorizonServerFactory`.
 */
export function resetDiagnosticsHooks(): void {
  disableDiagnostics();
}

/**
 * True when diagnostics are explicitly enabled, or when `POCKETPAY_DEBUG=true`
 * and hooks have been registered (env alone does not fire events with no hooks).
 */
export function isDiagnosticsEnabled(): boolean {
  if (explicitlyEnabled) return true;
  return envDebugEnabled() && hooks !== null;
}

/** Current hooks (or null). */
export function getDiagnosticsHooks(): DiagnosticsHooks | null {
  return hooks;
}

/**
 * Emit a lifecycle event to the registered hook when diagnostics are enabled.
 * Always deep-redacts `data` before delivery. Hook errors are swallowed so
 * observability never breaks SDK call paths.
 */
export function emitDiagnosticsEvent(
  domain: DiagnosticsDomain,
  type: string,
  data: Record<string, unknown> = {},
): void {
  if (!isDiagnosticsEnabled()) return;

  try {
    // Hook lookup and event preparation are deliberately inside the guard:
    // an accessor on caller-supplied data may throw during deep redaction.
    const onEvent = hooks?.onEvent;
    if (!onEvent) return;

    const event: DiagnosticsEvent = {
      schemaVersion: 1,
      domain,
      type,
      timestamp: new Date().toISOString(),
      data: redactDiagnosticsValue(data) as Record<string, unknown>,
    };

    const pending = onEvent(event);
    if (pending) {
      // Attach the rejection handler immediately; async observers cannot
      // produce unhandled rejections or affect the SDK's transaction flow.
      void Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // Neither malformed diagnostic data nor consumer errors may escape.
  }
}
