import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollTransaction } from '../src/transactions/polling';
import * as configModule from '../src/config';

describe('pollTransaction', () => {
  const MOCK_HASH = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockServerWith(call: ReturnType<typeof vi.fn>) {
    return {
      transactions: () => ({
        transaction: (_hash: string) => ({ call }),
      }),
    };
  }

  it('returns confirmed success with the number of status lookups', async () => {
    const mockCall = vi.fn().mockResolvedValue({
      hash: MOCK_HASH,
      ledger_attr: 100,
      created_at: '2023-01-01T00:00:00Z',
      source_account: 'GABC',
      fee_charged: '100',
      operation_count: 1,
      successful: true,
      memo: 'hello',
      memo_type: 'text',
    });

    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, { interval: 10, timeout: 500 });

    expect(result.status).toBe('success');
    expect(result.state).toBe('confirmed');
    expect(result.hash).toBe(MOCK_HASH);
    expect(result.attempts).toBe(1);
    expect(result.transaction?.successful).toBe(true);
    expect(result.transaction?.ledger).toBe(100);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('returns failed when Horizon confirms an unsuccessful transaction', async () => {
    const mockCall = vi.fn().mockResolvedValue({
      hash: MOCK_HASH,
      ledger_attr: 101,
      created_at: '2023-01-01T00:00:00Z',
      source_account: 'GABC',
      fee_charged: '100',
      operation_count: 1,
      successful: false,
    });

    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, { interval: 10, timeout: 500 });

    expect(result.status).toBe('failure');
    expect(result.state).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.transaction?.successful).toBe(false);
  });

  it('treats Horizon 404 as pending and retries until confirmation', async () => {
    const mockCall = vi.fn()
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({
        hash: MOCK_HASH,
        ledger_attr: 102,
        created_at: '2023-01-01T00:00:01Z',
        source_account: 'GABC',
        fee_charged: '100',
        operation_count: 1,
        successful: true,
      });

    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, { interval: 1, timeout: 500, maxAttempts: 5 });

    expect(result.status).toBe('success');
    expect(result.state).toBe('confirmed');
    expect(result.attempts).toBe(3);
    expect(mockCall).toHaveBeenCalledTimes(3);
  });

  it('stops at maxAttempts and reports the last observed state as pending', async () => {
    const mockCall = vi.fn().mockRejectedValue({ response: { status: 404 } });
    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, {
      interval: 1,
      timeout: 500,
      maxAttempts: 2,
    });

    expect(result.status).toBe('timeout');
    expect(result.state).toBe('pending');
    expect(result.attempts).toBe(2);
    expect(result.error).toMatch(/2 attempts/);
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('returns timeout with pending state when the time bound expires', async () => {
    const mockCall = vi.fn().mockRejectedValue({ response: { status: 404 } });
    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, {
      interval: 10,
      timeout: 40,
      maxAttempts: 100,
    });

    expect(result.status).toBe('timeout');
    expect(result.state).toBe('pending');
    expect(result.error).toMatch(/timed out/);
    expect(mockCall.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('applies the timeout while a Horizon lookup is still in flight', async () => {
    const mockCall = vi.fn(() => new Promise(() => {}));
    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, {
      interval: 5,
      timeout: 20,
      maxAttempts: 4,
    });

    expect(result.status).toBe('timeout');
    expect(result.state).toBe('unknown');
    expect(result.attempts).toBe(1);
    expect(result.error).toMatch(/timed out/);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable lookup error within the configured bounds', async () => {
    const mockCall = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce({
        hash: MOCK_HASH,
        ledger_attr: 103,
        created_at: '2023-01-01T00:00:02Z',
        source_account: 'GABC',
        fee_charged: '100',
        operation_count: 1,
        successful: true,
      });

    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, {
      interval: 1,
      timeout: 500,
      maxAttempts: 2,
    });

    expect(result.status).toBe('success');
    expect(result.state).toBe('confirmed');
    expect(result.attempts).toBe(2);
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('returns unknown for a non-retryable status lookup error', async () => {
    const mockCall = vi.fn().mockRejectedValue({ status: 400, message: 'Bad request' });
    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    const result = await pollTransaction(MOCK_HASH, { interval: 10, timeout: 500 });

    expect(result.status).toBe('unknown');
    expect(result.state).toBe('unknown');
    expect(result.attempts).toBe(1);
    expect(result.error).toMatch(/Bad request/i);
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('supports AbortSignal cancellation without issuing a status request when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const mockCall = vi.fn();

    vi.spyOn(configModule, 'getHorizonServer').mockReturnValue(mockServerWith(mockCall) as any);

    await expect(
      pollTransaction(MOCK_HASH, {
        interval: 10,
        timeout: 500,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockCall).not.toHaveBeenCalled();
  });
});
