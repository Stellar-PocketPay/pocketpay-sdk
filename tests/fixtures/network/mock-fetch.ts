import { cloneFixture } from '../builders/fixture-builder';
import type { NetworkFixture } from './network-builder';

/**
 * A transport adapter for NetworkClient tests. Each invocation constructs a
 * new response body; shared fixture objects are never exposed to a consumer.
 * This deliberately does not install a global mock or make a network request.
 * Call vi.stubGlobal('fetch', vi.fn(createFetchFromFixture(...))) in the test.
 */
export function createFetchFromFixture(fixture: NetworkFixture): typeof fetch {
  const baseline = cloneFixture(fixture);
  return async () => {
    const response = cloneFixture(baseline);
    if (response.timeout) {
      const error = new Error(response.error ?? 'Network fixture timed out');
      error.name = 'AbortError';
      throw error;
    }
    const payload: unknown = response.data ?? { message: response.error ?? 'Request failed' };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.error ?? '',
      headers: new Headers(response.headers ?? {}),
      json: async () => cloneFixture(payload),
      text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
    } as Response;
  };
}
