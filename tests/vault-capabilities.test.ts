/**
 * Vault capability and action intent tests (issue #274).
 *
 * The gating this module needed was already published and never called from the
 * vault: `SDK_CAPABILITIES['vault.contract']` declares the contract requirement
 * and `assertCapability` already routes a `planned` capability to
 * `UnsupportedFeatureError`. Grepping `src/vault/` for `capabilit` or
 * `unsupported` used to return nothing.
 *
 * The test that matters is the last one in the "lock actions" block: enabling
 * the feature flag must NOT make a lock action work. A disabled flag and a
 * missing contract entry point are different problems, and collapsing them is
 * exactly the confusion this issue is about.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  describeVaultReadiness,
  executeVaultIntent,
  isVaultActionSupported,
  listSupportedVaultActions,
  validateVaultIntent,
  VAULT_ACTION_READINESS,
  VAULT_LOCKS_FEATURE_FLAG,
  type VaultActionIntent,
  type VaultActionKind,
} from '../src/vault';
import {
  isCapabilityMismatchError,
  isDisabledFeatureError,
  isUnsupportedFeatureError,
  SDK_CAPABILITIES,
} from '../src/errors';
import * as soroban from '../src/soroban';
import * as StellarSDK from '@stellar/stellar-sdk';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET = StellarSDK.Keypair.random().secret();
const PUBLIC = StellarSDK.Keypair.random().publicKey();

/** Enables a flag for one call without touching the config module. */
const withLocksEnabled = { featureFlags: { [VAULT_LOCKS_FEATURE_FLAG]: true } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('readiness model', () => {
  it('models all six actions the issue names', () => {
    const kinds = describeVaultReadiness().map((r) => r.kind).sort();
    expect(kinds).toEqual(
      ['createLock', 'deposit', 'getBalance', 'listLocks', 'withdraw', 'withdrawMaturedLock'].sort(),
    );
  });

  it('marks exactly the three implemented actions as supported', () => {
    expect(listSupportedVaultActions()).toEqual(['deposit', 'withdraw', 'getBalance']);
    for (const kind of ['deposit', 'withdraw', 'getBalance'] as VaultActionKind[]) {
      expect(isVaultActionSupported(kind)).toBe(true);
    }
    for (const kind of ['createLock', 'listLocks', 'withdrawMaturedLock'] as VaultActionKind[]) {
      expect(isVaultActionSupported(kind)).toBe(false);
    }
  });

  it('gates the three lock actions on the published vault.lock capability', () => {
    for (const kind of ['createLock', 'listLocks', 'withdrawMaturedLock'] as VaultActionKind[]) {
      expect(VAULT_ACTION_READINESS[kind].capability).toBe('vault.lock');
      expect(VAULT_ACTION_READINESS[kind].featureFlag).toBe(VAULT_LOCKS_FEATURE_FLAG);
    }
    // The registry, not this module, is what makes the error unsupported.
    expect(SDK_CAPABILITIES['vault.lock']?.status).toBe('planned');
  });

  it('keeps the contract requirement on the existing vault.contract key', () => {
    for (const kind of ['deposit', 'withdraw', 'getBalance'] as VaultActionKind[]) {
      expect(VAULT_ACTION_READINESS[kind].capability).toBe('vault.contract');
    }
    expect(SDK_CAPABILITIES['vault.contract']?.status).toBe('config-gated');
  });

  it('promises no delivery dates anywhere in the readiness copy', () => {
    const copy = JSON.stringify(describeVaultReadiness()).toLowerCase();
    for (const banned of ['coming soon', 'next release', 'q1', 'q2', 'q3', 'q4', '2026', '2027']) {
      expect(copy).not.toContain(banned);
    }
  });
});

describe('supported actions', () => {
  it('routes a deposit intent to depositToVault', async () => {
    const spy = vi
      .spyOn(soroban, 'depositToVault')
      .mockResolvedValue({ success: true, status: 'success', operation: 'deposit' } as never);

    const intent: VaultActionIntent = {
      kind: 'deposit',
      sourceSecret: SECRET,
      amount: '10',
      contractId: CONTRACT_ID,
    };
    const result = await executeVaultIntent(intent);

    expect(spy).toHaveBeenCalledOnce();
    expect(result.operation).toBe('deposit');
  });

  it('routes a withdraw intent to withdrawFromVault', async () => {
    const spy = vi
      .spyOn(soroban, 'withdrawFromVault')
      .mockResolvedValue({ success: true, status: 'success', operation: 'withdraw' } as never);

    await executeVaultIntent({
      kind: 'withdraw',
      sourceSecret: SECRET,
      amount: '5',
      contractId: CONTRACT_ID,
    });

    expect(spy).toHaveBeenCalledOnce();
  });

  it('routes a getBalance intent to getVaultBalance', async () => {
    const spy = vi
      .spyOn(soroban, 'getVaultBalance')
      .mockResolvedValue({ success: true, status: 'success', operation: 'get_balance' } as never);

    await executeVaultIntent({ kind: 'getBalance', publicKey: PUBLIC, contractId: CONTRACT_ID });

    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('configured contract fallback for action intents (#311)', () => {
  it('uses SDKConfig.contractId for deposit, withdraw and balance without per-intent IDs', async () => {
    const deposit = vi.spyOn(soroban, 'depositToVault')
      .mockResolvedValue({ success: true, status: 'success', operation: 'deposit' } as never);
    const withdraw = vi.spyOn(soroban, 'withdrawFromVault')
      .mockResolvedValue({ success: true, status: 'success', operation: 'withdraw' } as never);
    const balance = vi.spyOn(soroban, 'getVaultBalance')
      .mockResolvedValue({ success: true, status: 'success', operation: 'get_balance' } as never);
    const config = { contractId: CONTRACT_ID };

    await executeVaultIntent({ kind: 'deposit', sourceSecret: SECRET, amount: '2' }, config);
    await executeVaultIntent({ kind: 'withdraw', sourceSecret: SECRET, amount: '1' }, config);
    await executeVaultIntent({ kind: 'getBalance', publicKey: PUBLIC }, config);

    expect(deposit).toHaveBeenCalledWith(
      { sourceSecret: SECRET, amount: '2', contractId: CONTRACT_ID }, config);
    expect(withdraw).toHaveBeenCalledWith(
      { sourceSecret: SECRET, amount: '1', contractId: CONTRACT_ID }, config);
    expect(balance).toHaveBeenCalledWith(
      { publicKey: PUBLIC, contractId: CONTRACT_ID }, config);
  });

  it('honors explicit > config > VAULT_CONTRACT_ID > STELLAR_CONTRACT_ID', async () => {
    const envVault = 'C' + 'B'.repeat(55);
    const envStellar = 'C' + 'D'.repeat(55);
    const configured = 'C' + 'E'.repeat(55);
    const balance = vi.spyOn(soroban, 'getVaultBalance')
      .mockResolvedValue({ success: true, status: 'success', operation: 'get_balance' } as never);
    vi.stubEnv('VAULT_CONTRACT_ID', envVault);
    vi.stubEnv('STELLAR_CONTRACT_ID', envStellar);

    await executeVaultIntent({ kind: 'getBalance', publicKey: PUBLIC });
    expect(balance).toHaveBeenLastCalledWith({ publicKey: PUBLIC, contractId: envVault }, undefined);

    await executeVaultIntent({ kind: 'getBalance', publicKey: PUBLIC }, { contractId: configured });
    expect(balance).toHaveBeenLastCalledWith(
      { publicKey: PUBLIC, contractId: configured }, { contractId: configured });

    await executeVaultIntent(
      { kind: 'getBalance', publicKey: PUBLIC, contractId: CONTRACT_ID },
      { contractId: configured },
    );
    expect(balance).toHaveBeenLastCalledWith(
      { publicKey: PUBLIC, contractId: CONTRACT_ID }, { contractId: configured });

    vi.stubEnv('VAULT_CONTRACT_ID', '');
    await executeVaultIntent({ kind: 'getBalance', publicKey: PUBLIC });
    expect(balance).toHaveBeenLastCalledWith(
      { publicKey: PUBLIC, contractId: envStellar }, undefined);
  });

  it('preserves feature-disabled versus unsupported-lock errors under config fallback', async () => {
    const intent: VaultActionIntent = {
      kind: 'createLock', sourceSecret: SECRET, amount: '2', unlockAt: 1893456000,
    };
    const disabled = await executeVaultIntent(intent, { contractId: CONTRACT_ID }).catch(e => e);
    expect(isDisabledFeatureError(disabled)).toBe(true);

    const unsupported = await executeVaultIntent(intent, {
      contractId: CONTRACT_ID,
      featureFlags: { [VAULT_LOCKS_FEATURE_FLAG]: true },
    }).catch(e => e);
    expect(isUnsupportedFeatureError(unsupported)).toBe(true);
    expect(isCapabilityMismatchError(unsupported)).toBe(false);
  });
});

describe('unconfigured contract', () => {
  it('raises a capability mismatch, not an unsupported error', async () => {
    vi.stubEnv('VAULT_CONTRACT_ID', '');
    vi.stubEnv('STELLAR_CONTRACT_ID', '');
    // Missing contractId is fixable by configuration, so it must not look like
    // a missing feature.
    const error = await executeVaultIntent({
      kind: 'deposit',
      sourceSecret: SECRET,
      amount: '10',
      contractId: '',
    }).catch((e) => e);

    expect(isCapabilityMismatchError(error)).toBe(true);
    expect(isUnsupportedFeatureError(error)).toBe(false);
    expect(error.code).toBe('VAULT_CONTRACT_NOT_CONFIGURED');
  });

  it('checks configuration before feature support, so the fixable error wins', async () => {
    vi.stubEnv('VAULT_CONTRACT_ID', '');
    vi.stubEnv('STELLAR_CONTRACT_ID', '');
    const error = await executeVaultIntent({
      kind: 'createLock',
      sourceSecret: SECRET,
      amount: '10',
      contractId: '',
      unlockAt: 1893456000,
    }).catch((e) => e);

    expect(isCapabilityMismatchError(error)).toBe(true);
  });
});

describe('lock actions', () => {
  it('raises DisabledFeatureError when the flag is off', async () => {
    const error = await executeVaultIntent({
      kind: 'createLock',
      sourceSecret: SECRET,
      amount: '10',
      contractId: CONTRACT_ID,
      unlockAt: 1893456000,
    }).catch((e) => e);

    expect(isDisabledFeatureError(error)).toBe(true);
  });

  it('raises DisabledFeatureError for listLocks and withdrawMaturedLock too', async () => {
    const listError = await executeVaultIntent({
      kind: 'listLocks',
      publicKey: PUBLIC,
      contractId: CONTRACT_ID,
    }).catch((e) => e);
    const maturedError = await executeVaultIntent({
      kind: 'withdrawMaturedLock',
      sourceSecret: SECRET,
      contractId: CONTRACT_ID,
      lockId: 'lock-1',
    }).catch((e) => e);

    expect(isDisabledFeatureError(listError)).toBe(true);
    expect(isDisabledFeatureError(maturedError)).toBe(true);
  });

  it('still raises UnsupportedFeatureError once the flag is enabled', async () => {
    // The promised case: configured, flag on, and still unsupported. Enabling
    // an experimental flag cannot conjure a contract entry point, and the error
    // has to say so rather than implying the caller mis-configured something.
    const error = await executeVaultIntent(
      {
        kind: 'createLock',
        sourceSecret: SECRET,
        amount: '10',
        contractId: CONTRACT_ID,
        unlockAt: 1893456000,
      },
      withLocksEnabled,
    ).catch((e) => e);

    expect(isUnsupportedFeatureError(error)).toBe(true);
    expect(isDisabledFeatureError(error)).toBe(false);
    expect(isCapabilityMismatchError(error)).toBe(false);
  });

  it('never reaches a Soroban helper for a lock action', async () => {
    const deposit = vi.spyOn(soroban, 'depositToVault');
    const withdraw = vi.spyOn(soroban, 'withdrawFromVault');
    const balance = vi.spyOn(soroban, 'getVaultBalance');

    await executeVaultIntent(
      {
        kind: 'withdrawMaturedLock',
        sourceSecret: SECRET,
        contractId: CONTRACT_ID,
        lockId: 'lock-1',
      },
      withLocksEnabled,
    ).catch(() => undefined);

    expect(deposit).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });
});

describe('input validation and secret handling', () => {
  it('rejects a malformed amount before any capability check', () => {
    expect(() =>
      validateVaultIntent({
        kind: 'deposit',
        sourceSecret: SECRET,
        amount: 'not-a-number',
        contractId: CONTRACT_ID,
      }),
    ).toThrow();
  });

  it('rejects a malformed public key', () => {
    expect(() =>
      validateVaultIntent({ kind: 'getBalance', publicKey: 'nope', contractId: CONTRACT_ID }),
    ).toThrow();
  });

  it('never echoes the source secret into an error', async () => {
    const error = await executeVaultIntent(
      {
        kind: 'createLock',
        sourceSecret: SECRET,
        amount: '10',
        contractId: CONTRACT_ID,
        unlockAt: 1893456000,
      },
      withLocksEnabled,
    ).catch((e) => e);

    const serialised = `${error.message} ${JSON.stringify(error)}`;
    expect(serialised).not.toContain(SECRET);
  });
});
