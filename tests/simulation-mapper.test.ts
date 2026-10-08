import { describe, expect, it, vi } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  ErrorCode,
  mapSimulationResult,
  pocketPayErrorFromSimulation,
  simulationStatusToInvocationStatus,
} from '../src';
import {
  simulationFailedFixture,
  simulationSuccessFixture,
  simulationUnknownFixture,
  simulationUnsupportedFixture,
  simulationWarningFixture,
} from './fixtures/simulation-responses';

describe('mapSimulationResult', () => {
  it('maps a successful simulation response', () => {
    const mapped = mapSimulationResult(simulationSuccessFixture.response, {
      parseRetval: (retval) => (retval as { mock: string }).mock,
    });

    expect(mapped).toMatchObject({
      success: true,
      status: 'success',
      result: 'ok',
      cost: {
        cpuInstructions: '1000',
        ramBytes: '2048',
        minResourceFee: '100',
      },
    });
    expect(mapped.warnings).toBeUndefined();
    expect(mapped.rawSimulation).toBe(simulationSuccessFixture.response);
  });

  it('maps success-with-advisories as warning', () => {
    const mapped = mapSimulationResult(simulationWarningFixture.response);

    expect(mapped.success).toBe(true);
    expect(mapped.status).toBe('warning');
    expect(mapped.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AUTH_HINT' }),
        expect.objectContaining({ code: 'SIMULATION_EVENTS' }),
      ]),
    );
  });

  it('maps simulation errors as failed with typed code', () => {
    const mapped = mapSimulationResult(simulationFailedFixture.response);

    expect(mapped).toMatchObject({
      success: false,
      status: 'failed',
      errorCode: ErrorCode.SOROBAN_SIMULATION_FAILED,
    });
    expect(mapped.error).toContain('HostError');
  });

  it('refuses contradictory RPC simulation error even when the SDK error guard returns false', () => {
    const guard = vi.spyOn(StellarSDK.rpc.Api, 'isSimulationError')
      .mockReturnValue(false);
    try {
      // A success-looking response may carry a contract error; result and fee
      // metadata must never authorize signing in that case.
      const response = {
        ...simulationSuccessFixture.response,
        error: 'HostError: contract rejected this operation',
        result: { retval: { mock: 'ok' } },
        transactionData: 'present',
        minResourceFee: '100',
      };
      const mapped = mapSimulationResult(response);
      expect(mapped).toMatchObject({
        success: false,
        status: 'failed',
        errorCode: ErrorCode.SOROBAN_SIMULATION_FAILED,
      });
      expect(mapped.error).toContain('HostError');
      expect(mapped.result).toBeUndefined();
    } finally {
      guard.mockRestore();
    }
  });

  it('maps restore preamble as unsupported', () => {
    const mapped = mapSimulationResult(simulationUnsupportedFixture.response);

    expect(mapped).toMatchObject({
      success: false,
      status: 'unsupported',
      errorCode: ErrorCode.SOROBAN_SIMULATION_UNSUPPORTED,
      error: 'State requires restoration before simulation can complete',
    });
  });

  it('maps unclassifiable payloads as unknown', () => {
    const mapped = mapSimulationResult(simulationUnknownFixture.response);

    expect(mapped).toMatchObject({
      success: false,
      status: 'unknown',
      errorCode: ErrorCode.SOROBAN_SIMULATION_UNKNOWN,
    });
  });

  it('maps null/undefined as unknown safely', () => {
    expect(mapSimulationResult(null).status).toBe('unknown');
    expect(mapSimulationResult(undefined).status).toBe('unknown');
    expect(mapSimulationResult('nope').status).toBe('unknown');
  });

  it('applies custom mapError for contract-specific codes', () => {
    const mapped = mapSimulationResult(
      { error: 'insufficient balance' },
      {
        mapError: (error) => ({
          error: String(error),
          errorCode: 'VAULT_INSUFFICIENT_BALANCE',
        }),
      },
    );

    expect(mapped).toMatchObject({
      status: 'failed',
      errorCode: 'VAULT_INSUFFICIENT_BALANCE',
      error: 'Simulation failed: insufficient balance',
    });
  });
});

describe('pocketPayErrorFromSimulation', () => {
  it('builds a typed PocketPayError for failed simulations', () => {
    const mapped = mapSimulationResult(simulationFailedFixture.response);
    const err = pocketPayErrorFromSimulation(mapped);

    expect(err.code).toBe(ErrorCode.SOROBAN_SIMULATION_FAILED);
    expect(err.message).toContain('HostError');
  });

  it('uses unsupported / unknown codes by status', () => {
    expect(
      pocketPayErrorFromSimulation(
        mapSimulationResult(simulationUnsupportedFixture.response),
      ).code,
    ).toBe(ErrorCode.SOROBAN_SIMULATION_UNSUPPORTED);

    expect(
      pocketPayErrorFromSimulation(
        mapSimulationResult(simulationUnknownFixture.response),
      ).code,
    ).toBe(ErrorCode.SOROBAN_SIMULATION_UNKNOWN);
  });
});

describe('simulationStatusToInvocationStatus', () => {
  it('maps simulation states onto invocation statuses', () => {
    expect(simulationStatusToInvocationStatus('success')).toBe('success');
    expect(simulationStatusToInvocationStatus('warning')).toBe('success');
    expect(simulationStatusToInvocationStatus('failed')).toBe('simulation_error');
    expect(simulationStatusToInvocationStatus('unsupported')).toBe(
      'simulation_error',
    );
    expect(simulationStatusToInvocationStatus('unknown')).toBe('simulation_error');
  });
});
