import { describe, expect, it, vi } from 'vitest';
import {
  requestExternalSignature,
  type AbortableExternalSignerAdapter,
  type ExternalDeviceSignOutcome,
} from '../src';
import type * as StellarSDK from '@stellar/stellar-sdk';

type Tx = StellarSDK.Transaction | StellarSDK.FeeBumpTransaction;
const tx = {} as Tx;
const publicKey = 'G' + 'A'.repeat(55);

function device(
  requestSignature: (args: { transaction: Tx; networkPassphrase: string; signal: AbortSignal }) =>
    Promise<ExternalDeviceSignOutcome>,
): AbortableExternalSignerAdapter {
  return {
    publicKey,
    kind: 'hardware',
    isAvailable: true,
    async sign(transaction) { return transaction; }, // legacy signer compatibility
    requestSignature,
  };
}

describe('issue #212: cancel-aware external signer contract', () => {
  it('returns a typed signed result without requesting a secret key', async () => {
    const call = vi.fn(async (args: { transaction: Tx; networkPassphrase: string; signal: AbortSignal }) => ({
      status: 'signed' as const,
      transaction: args.transaction,
    }));
    const out = await requestExternalSignature(device(call), tx, 'Test SDF Network ; September 2015', {
      expectedPublicKey: publicKey,
    });
    expect(out).toEqual({ status: 'signed', transaction: tx });
    expect(call).toHaveBeenCalledOnce();
    expect(Object.keys(call.mock.calls[0][0]).sort()).toEqual([
      'networkPassphrase', 'signal', 'transaction',
    ]);
  });

  it('rejects mismatched signers without invoking hardware', async () => {
    const call = vi.fn(async () => ({ status: 'signed' as const, transaction: tx }));
    const out = await requestExternalSignature(device(call), tx, 'testnet', { expectedPublicKey: 'GOTHER' });
    expect(out.status).toBe('mismatch');
    expect(call).not.toHaveBeenCalled();
  });

  it('returns cancellation immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn(async () => ({ status: 'signed' as const, transaction: tx }));
    const out = await requestExternalSignature(device(call), tx, 'testnet', { signal: controller.signal });
    expect(out.status).toBe('cancelled');
    expect(call).not.toHaveBeenCalled();
  });

  it('settles cancellation without waiting for an unresponsive device', async () => {
    const controller = new AbortController();
    let resolveDevice!: (out: ExternalDeviceSignOutcome) => void;
    const call = vi.fn(() => new Promise<ExternalDeviceSignOutcome>((resolve) => {
      resolveDevice = resolve;
    }));
    const request = requestExternalSignature(device(call), tx, 'testnet', { signal: controller.signal });
    // Allow the first microtask to start the device call before aborting.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect((await request).status).toBe('cancelled');
    // A late signature is ignored and cannot turn the cancelled result into success.
    resolveDevice({ status: 'signed', transaction: tx });
  });

  it('maps user denial and unavailable devices to typed nonretryable states', async () => {
    expect((await requestExternalSignature(device(async () => ({ status: 'rejected' })), tx, 'testnet')).status)
      .toBe('rejected');
    const unavailable = { ...device(async () => ({ status: 'signed', transaction: tx })), isAvailable: false };
    expect((await requestExternalSignature(unavailable, tx, 'testnet')).status).toBe('unavailable');
  });

  it('redacts arbitrary device failure details and rejects malformed outcomes', async () => {
    const failure = await requestExternalSignature(
      device(async () => { throw new Error('sensitive upstream device error'); }),
      tx,
      'testnet',
    );
    expect(failure.status).toBe('failed');
    expect(JSON.stringify(failure)).not.toContain('sensitive upstream');
    const malformed = await requestExternalSignature(
      device(async () => ({ status: 'signed' } as ExternalDeviceSignOutcome)),
      tx,
      'testnet',
    );
    expect(malformed.status).toBe('failed');
  });
});
