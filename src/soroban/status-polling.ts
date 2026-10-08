import { withTimeout } from '../network';
import { classifySubmitError } from '../errors';

/**
 * Resolve a submitted Soroban transaction without exceeding an overall
 * confirmation budget. Each RPC read consumes the *remaining* budget.
 *
 * null means status is UNKNOWN: an RPC failure, unexpected status, or repeated
 * NOT_FOUND cannot prove the transaction failed. The caller must preserve the
 * submitted hash and must not automatically submit a replacement.
 *
 * This is deliberately independent of Horizon's transaction polling API.
 */
export async function pollSorobanTransactionStatus<T extends { status: string }>(
  getTransaction: () => Promise<T>,
  budgetMs?: number,
): Promise<T | null> {
  const budget = typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0
    ? budgetMs
    : 30_000;
  const deadline = Date.now() + budget;

  // The time limit protects normal RPC use; this separate attempt fence
  // protects frozen clocks and test doubles that resolve instantaneously.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    let response: T;
    try {
      response = await withTimeout(
        'Soroban transaction status request',
        remaining,
        getTransaction(),
      );
    } catch {
      return null;
    }

    // Runtime RPC adapters can violate their TypeScript response contract:
    // a null result or a throwing status accessor must never turn an already
    // submitted transfer into a generic exception that loses its hash.
    try {
      const status = response?.status;
      if (status === 'SUCCESS' || status === 'FAILED') return response;
      if (status !== 'NOT_FOUND') return null;
    } catch {
      return null;
    }

    const delay = Math.min(1000, deadline - Date.now());
    if (delay <= 0) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  return null;
}

/**
 * Submit a pre-signed Soroban envelope once, retaining its locally known hash
 * when the transport times out before returning a server-side response.
 * An unknown submission may ALREADY be on-chain and is never retried here.
 * Definitive rejections propagate unchanged to the caller.
 *
 * `timeoutMs` is the SDK's optional request timeout; when it is unset the
 * shared network fallback applies, as for every other Soroban RPC call.
 */
export async function submitSorobanWithKnownHash<T>(
  signedHash: string,
  send: () => Promise<T>,
  timeoutMs?: number,
): Promise<{ kind: 'response'; response: T } | { kind: 'unknown'; hash: string }> {
  try {
    const response = await withTimeout(
      'Soroban transaction submission',
      timeoutMs,
      send(),
    );

    // The signed envelope already fixes the transaction identity. Runtime RPC
    // adapters must not be allowed to redirect confirmation to a different
    // transaction hash (or omit the identity entirely) after submission.
    try {
      const record = response as unknown as { status?: unknown; hash?: unknown } | null;
      if (record?.status !== 'ERROR') {
        if (typeof record?.hash !== 'string' || record.hash !== signedHash) {
          return { kind: 'unknown', hash: signedHash };
        }
      }
    } catch {
      return { kind: 'unknown', hash: signedHash };
    }

    return { kind: 'response', response };
  } catch (error) {
    let classified;
    try {
      classified = classifySubmitError(error, signedHash);
    } catch {
      return { kind: 'unknown', hash: signedHash };
    }
    if (classified.code === 'TX_STATUS_UNKNOWN') {
      return { kind: 'unknown', hash: signedHash };
    }
    throw error;
  }
}
