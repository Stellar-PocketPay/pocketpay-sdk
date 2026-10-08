/**
 * Diagnostics redaction + opt-in hooks tests (issue #276).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  redactDiagnosticsValue,
  redactDiagnosticsString,
  isDiagnosticsSensitiveKey,
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
  DIAGNOSTICS_SENSITIVE_KEYS,
  enableDiagnostics,
  disableDiagnostics,
  resetDiagnosticsHooks,
  isDiagnosticsEnabled,
  emitDiagnosticsEvent,
  buildDiagnosticsReport,
  createWallet,
  resolveConfig,
  type DiagnosticsEvent,
} from '../src/index';

describe('diagnostics redaction', () => {
  it('redacts deny-listed object keys', () => {
    const secret = StellarSDK.Keypair.random().secret();
    const input = {
      publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      secretKey: secret,
      seedPhrase: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
      mnemonic: 'word '.repeat(12).trim(),
      signedXDR: 'AAAAAgAAAAD...',
      signature: 'sig-bytes',
      signatures: ['a', 'b'],
      sourceSecret: secret,
      privateKey: secret,
      nested: { secret: 'top-secret', ok: true },
    };

    const redacted = redactDiagnosticsValue(input);

    expect(redacted.publicKey).toBe(input.publicKey);
    expect(redacted.secretKey).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.seedPhrase).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.mnemonic).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.signedXDR).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.signature).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.signatures).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.sourceSecret).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.privateKey).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.nested.secret).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
    expect(redacted.nested.ok).toBe(true);
  });

  it('scrubs Stellar secret keys embedded in free-form strings', () => {
    const secret = StellarSDK.Keypair.random().secret();
    const scrubbed = redactDiagnosticsString(`failed with key ${secret} end`);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toBe(`failed with key ${DIAGNOSTICS_REDACTED_PLACEHOLDER} end`);
  });

  it('exposes the documented sensitive key set', () => {
    expect(DIAGNOSTICS_SENSITIVE_KEYS).toContain('secretKey');
    expect(DIAGNOSTICS_SENSITIVE_KEYS).toContain('mnemonic');
    expect(isDiagnosticsSensitiveKey('secretKey')).toBe(true);
    expect(isDiagnosticsSensitiveKey('publicKey')).toBe(false);
  });
});

describe('diagnostics hooks (opt-in)', () => {
  beforeEach(() => {
    resetDiagnosticsHooks();
    delete process.env.POCKETPAY_DEBUG;
  });

  afterEach(() => {
    resetDiagnosticsHooks();
    delete process.env.POCKETPAY_DEBUG;
  });

  it('does not emit events when diagnostics are disabled', () => {
    const events: DiagnosticsEvent[] = [];
    // Intentionally do not enable — only set would enable; here we leave disabled.
    emitDiagnosticsEvent('config', 'config.resolved', { network: 'testnet' });
    expect(events).toHaveLength(0);
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it('emits redacted lifecycle events only after enableDiagnostics', () => {
    const events: DiagnosticsEvent[] = [];
    enableDiagnostics({
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    const secret = StellarSDK.Keypair.random().secret();
    emitDiagnosticsEvent('wallet', 'wallet.created', {
      publicKey: 'GTEST',
      secretKey: secret,
    });

    expect(isDiagnosticsEnabled()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].domain).toBe('wallet');
    expect(events[0].type).toBe('wallet.created');
    expect(events[0].schemaVersion).toBe(1);
    expect(events[0].data.publicKey).toBe('GTEST');
    expect(events[0].data.secretKey).toBe(DIAGNOSTICS_REDACTED_PLACEHOLDER);
  });

  it('createWallet emits a secret-free event when enabled', () => {
    const events: DiagnosticsEvent[] = [];
    enableDiagnostics({
      hooks: { onEvent: (e) => events.push(e) },
    });

    const wallet = createWallet();
    expect(wallet.secretKey.startsWith('S')).toBe(true);

    const created = events.find((e) => e.type === 'wallet.created');
    expect(created).toBeDefined();
    expect(created!.data.publicKey).toBe(wallet.publicKey);
    expect(created!.data.hasSecretKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain(wallet.secretKey);
  });

  it('resolveConfig emits support-safe config.resolved endpoint origins', () => {
    const events: DiagnosticsEvent[] = [];
    enableDiagnostics({
      hooks: { onEvent: (e) => events.push(e) },
    });

    const horizonSecret = 'horizon-credential-value';
    const rpcSecret = 'soroban-credential-value';
    resolveConfig({
      network: 'testnet',
      horizonUrl:
        `https://user:${horizonSecret}@horizon.example.test/private/${horizonSecret}?api_key=${horizonSecret}#secret`,
      sorobanRpcUrl:
        `https://rpcuser:${rpcSecret}@soroban.example.test/private/${rpcSecret}?token=${rpcSecret}#secret`,
    });
    const resolved = events.find((e) => e.type === 'config.resolved');
    expect(resolved).toBeDefined();
    expect(resolved!.data.network).toBe('testnet');
    expect(resolved!.data.horizonUrl).toBe('https://horizon.example.test');
    expect(resolved!.data.sorobanRpcUrl).toBe('https://soroban.example.test');
    expect(JSON.stringify(resolved)).not.toContain(horizonSecret);
    expect(JSON.stringify(resolved)).not.toContain(rpcSecret);
    expect(resolved!.data).not.toHaveProperty('secretKey');
  });

  it('disableDiagnostics stops further emits', () => {
    const events: DiagnosticsEvent[] = [];
    enableDiagnostics({ hooks: { onEvent: (e) => events.push(e) } });
    emitDiagnosticsEvent('network', 'probe', { ok: true });
    disableDiagnostics();
    emitDiagnosticsEvent('network', 'probe', { ok: true });
    expect(events).toHaveLength(1);
  });

  it('hook exceptions do not throw to the caller', () => {
    enableDiagnostics({
      hooks: {
        onEvent: () => {
          throw new Error('consumer boom');
        },
      },
    });
    expect(() =>
      emitDiagnosticsEvent('config', 'config.resolved', { network: 'testnet' }),
    ).not.toThrow();
  });
});

describe('diagnostics report', () => {
  beforeEach(() => {
    resetDiagnosticsHooks();
  });

  it('builds a support-safe report without secrets', () => {
    const report = buildDiagnosticsReport({ network: 'testnet' });

    expect(report.sdkName).toBe('stellar-pocketpay-sdk');
    expect(report.config.network).toBe('testnet');
    expect(report.network.horizonUrl).toMatch(/^https?:\/\//);
    expect(report.capabilities.length).toBeGreaterThan(0);
    expect(report.wallet.canCreate).toBe(true);
    expect(report.vault).toHaveProperty('ready');
    expect(report.diagnosticsEnabled).toBe(false);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(serialized.toLowerCase()).not.toContain('mnemonic');
  });
});
