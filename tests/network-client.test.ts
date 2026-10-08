/**
 * Tests for the NetworkClient abstraction and its typed error classification
 * (issue #272). All fetch calls are mocked so the suite runs offline.
 */

import { describe, it, expect, vi } from 'vitest';
import { createFetchFromFixture, NetworkBuilder, networkFixtures } from './fixtures';
import { NetworkClient, checkEndpointReachability } from '../src/network';
import { PocketPayError } from '../src/types';
import { ErrorCode } from '../src/errors';

function mockFetchOk(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response),
  );
}

function mockFetchStatus(status: number, body: unknown = { message: 'failed' }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response),
  );
}

function mockFetchRejection(error: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
}

function connectionRefused(): Error {
  const error = new Error('connect ECONNREFUSED 127.0.0.1:443') as Error & { code: string };
  error.code = 'ECONNREFUSED';
  return error;
}

describe('NetworkClient', () => {
  it('returns parsed JSON on a successful GET', async () => {
    vi.stubGlobal('fetch', vi.fn(createFetchFromFixture(
      new NetworkBuilder().withData({ hello: 'world' }).build(),
    )));
    const client = new NetworkClient({ baseUrl: 'https://example.test' });
    await expect(client.get('/ping')).resolves.toEqual({ hello: 'world' });
  });

  it('classifies HTTP 429 as the typed NET_RATE_LIMITED code', async () => {
    vi.stubGlobal('fetch', vi.fn(createFetchFromFixture(networkFixtures.rateLimited)));
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: ErrorCode.NET_RATE_LIMITED,
      statusCode: 429,
      retryable: true,
    });
  });

  it('classifies HTTP 503 as the typed NET_UNREACHABLE code', async () => {
    vi.stubGlobal('fetch', vi.fn(createFetchFromFixture(networkFixtures.serverError)));
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: ErrorCode.NET_UNREACHABLE,
      statusCode: 503,
      retryable: true,
    });
  });

  it('keeps the legacy HTTP_ERROR_<status> code for other 4xx statuses', async () => {
    mockFetchStatus(404, 'Not Found');
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: 'HTTP_ERROR_404',
      statusCode: 404,
    });
  });

  it('classifies a connection-refused rejection as NET_UNREACHABLE', async () => {
    mockFetchRejection(connectionRefused());
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: ErrorCode.NET_UNREACHABLE,
      retryable: true,
    });
  });

  it('classifies a DNS lookup failure (ENOTFOUND) as NET_UNREACHABLE', async () => {
    const error = new Error('getaddrinfo ENOTFOUND example.invalid') as Error & { code: string };
    error.code = 'ENOTFOUND';
    mockFetchRejection(error);
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: ErrorCode.NET_UNREACHABLE,
    });
  });

  it('falls back to NETWORK_ERROR for unrecognized fetch rejections', async () => {
    mockFetchRejection(new Error('something odd happened'));
    const client = new NetworkClient({ baseUrl: 'https://example.test' });

    await expect(client.get('/ping')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('surfaces a REQUEST_TIMEOUT when the request exceeds its budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })),
    );
    const client = new NetworkClient({ baseUrl: 'https://example.test', defaultTimeoutMs: 5 });

    await expect(client.get('/slow')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
  });

  it('does not retry on its own — callers own retry behaviour', async () => {
    mockFetchStatus(500, 'boom');
    const client = new NetworkClient({ baseUrl: 'https://example.test' });
    const err = await client.get('/ping').catch((e) => e as PocketPayError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(PocketPayError);
  });
});

describe('checkEndpointReachability', () => {
  it('reports reachable:true for any HTTP response, including error statuses', async () => {
    mockFetchStatus(500, 'boom');
    const result = await checkEndpointReachability('https://example.test');
    expect(result.reachable).toBe(true);
    expect(result.url).toBe('https://example.test');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('reports reachable:false with a NET_UNREACHABLE code on connection failure', async () => {
    mockFetchRejection(connectionRefused());
    const result = await checkEndpointReachability('https://example.test');
    expect(result.reachable).toBe(false);
    expect(result.errorCode).toBe(ErrorCode.NET_UNREACHABLE);
  });

  it('never includes response bodies or headers in the result', async () => {
    mockFetchOk({ secretKey: 'SSHOULDNEVERAPPEAR' });
    const result = await checkEndpointReachability('https://example.test');
    expect(JSON.stringify(result)).not.toContain('secretKey');
  });
});
