import * as StellarSDK from '@stellar/stellar-sdk';
import {
  SorobanInvocationResult,
  SorobanInvocationStatus,
  SorobanInvocationMapperOptions,
  VaultMappedResult,
  VaultOperationType,
  PocketPayError,
  SimulationMappedResult,
  SimulationResultStatus,
  SimulationWarning,
} from '../types';
import { ErrorCode, ERROR_CODES, type ErrorCodeValue } from '../errors/codes';
import { formatStroops, safeParseAmount } from '../utils/amount';

/** Optional remapping for contract-specific simulation error strings. */
export interface MapSimulationResultOptions {
  /**
   * Maps a raw simulation `error` field (or thrown value) into a stable
   * `{ error, errorCode }` pair. Used by {@link ContractClient} error maps.
   */
  mapError?: (error: unknown) => { error: string; errorCode?: string | number };
  /** Optional parser for `result.retval` (defaults to `scValToNative`). */
  parseRetval?: (retval: unknown) => unknown;
}

/**
 * Maps contract error objects or thrown exceptions into a standardized error representation.
 *
 * @param error - Raw error object, string, or Exception
 * @returns Standardized error string and optional errorCode
 */
export function mapSorobanContractError(error: unknown): { error: string; errorCode?: string | number } {
  if (!error) {
    return { error: 'Unknown Soroban contract error', errorCode: 'UNKNOWN_SOROBAN_ERROR' };
  }

  if (error instanceof PocketPayError) {
    return {
      error: error.message,
      errorCode: error.code || 'POCKETPAY_ERROR',
    };
  }

  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('Simulation failed')) {
      return { error: msg, errorCode: 'SIMULATION_ERROR' };
    }
    if (msg.includes('Send error')) {
      return { error: msg, errorCode: 'TRANSACTION_SEND_ERROR' };
    }
    if (msg.includes('MISSING_CONTRACT_ID') || msg.includes('contract ID')) {
      return { error: msg, errorCode: 'MISSING_CONTRACT_ID' };
    }
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      return { error: msg, errorCode: 'REQUEST_TIMEOUT' };
    }
    return { error: msg, errorCode: 'SOROBAN_EXECUTION_ERROR' };
  }

  if (typeof error === 'string') {
    return { error, errorCode: 'SOROBAN_ERROR' };
  }

  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, any>;
    const message = errObj.error || errObj.message || errObj.reason || JSON.stringify(error);
    const errorCode = errObj.code || errObj.errorCode || errObj.status || 'SOROBAN_CONTRACT_ERROR';
    return { error: String(message), errorCode };
  }

  return { error: String(error), errorCode: 'UNKNOWN_ERROR' };
}

/**
 * Maps raw Soroban RPC invocation responses (simulateTransaction, sendTransaction, getTransaction, or raw ScVal)
 * into a stable typed SDK value (`SorobanInvocationResult<T>`).
 *
 * @param rawResponse - The raw response returned from Soroban RPC or contract invocation
 * @param options - Configuration options for mapping context
 * @returns Strongly typed SorobanInvocationResult<T>
 */
export function mapSorobanInvocationResult<T = unknown>(
  rawResponse: unknown,
  options?: SorobanInvocationMapperOptions
): SorobanInvocationResult<T> {
  if (rawResponse === null || rawResponse === undefined) {
    return {
      success: false,
      status: 'error',
      error: 'Empty or null response received from Soroban contract',
      errorCode: 'NULL_RESPONSE',
      rawResponse,
    };
  }

  // Handle direct boolean or primitive return values
  if (typeof rawResponse === 'boolean') {
    return {
      success: rawResponse,
      status: rawResponse ? 'success' : 'failed',
      result: rawResponse as unknown as T,
      rawResponse,
    };
  }

  if (typeof rawResponse === 'object') {
    const resp = rawResponse as Record<string, any>;

    // Case 1: StellarSDK Simulation Error check
    if (StellarSDK.rpc.Api.isSimulationError(resp as any)) {
      const errorMsg = resp.error || 'Soroban transaction simulation failed';
      return {
        success: false,
        status: 'simulation_error',
        error: `Simulation failed: ${errorMsg}`,
        errorCode: 'SIMULATION_FAILED',
        rawResponse,
      };
    }

    // Case 2: Object with explicit simulation error property
    if (resp.error && typeof resp.error === 'string' && resp.error.startsWith('Simulation failed:')) {
      return {
        success: false,
        status: 'simulation_error',
        error: resp.error,
        errorCode: 'SIMULATION_FAILED',
        rawResponse,
      };
    }

    // Case 3: SendTransaction response error status
    if (resp.status === 'ERROR') {
      const errorMsg = resp.errorResult || resp.error || 'Transaction submission rejected by Soroban RPC';
      return {
        success: false,
        status: 'failed',
        error: typeof errorMsg === 'string' && errorMsg.startsWith('Send error:') ? errorMsg : `Send error: ${errorMsg}`,
        errorCode: 'SUBMISSION_ERROR',
        hash: resp.hash,
        rawResponse,
      };
    }

    // Case 4: GetTransaction response status check
    if (resp.status === 'FAILED' || resp.status === 'NOT_FOUND') {
      return {
        success: false,
        status: 'failed',
        error: `Transaction status: ${resp.status}`,
        errorCode: `TX_STATUS_${resp.status}`,
        hash: resp.hash,
        rawResponse,
      };
    }

    // Case 5: Standard { success: false, error: ... } shape
    if (resp.success === false) {
      const mappedErr = mapSorobanContractError(resp.error || 'Operation failed');
      return {
        success: false,
        status: resp.error?.includes?.('Simulation') ? 'simulation_error' : 'failed',
        error: mappedErr.error,
        errorCode: resp.errorCode ?? mappedErr.errorCode,
        hash: resp.hash,
        rawResponse,
      };
    }

    // Case 6: Successful simulation with result.retval
    if (resp.result && resp.result.retval) {
      let nativeVal: any;
      try {
        nativeVal = StellarSDK.scValToNative(resp.result.retval);
      } catch {
        nativeVal = resp.result.retval;
      }
      return {
        success: true,
        status: 'success',
        result: nativeVal as T,
        rawResponse,
      };
    }

    // Case 7: Successful transaction completion status or SDK VaultResult shape
    if (resp.status === 'SUCCESS' || resp.success === true) {
      let resultVal: any =
        resp.value !== undefined
          ? resp.value
          : resp.result !== undefined
            ? resp.result
            : resp.balance;
      if (resp.retval) {
        try {
          resultVal = StellarSDK.scValToNative(resp.retval);
        } catch {
          resultVal = resp.retval;
        }
      }
      return {
        success: true,
        status: 'success',
        hash: resp.hash,
        result: resultVal as T,
        rawResponse,
      };
    }

    // Case 8: Pending transaction state
    if (resp.status === 'PENDING') {
      return {
        success: true,
        status: 'pending',
        hash: resp.hash,
        rawResponse,
      };
    }
  }

  // Fallback for primitive native values (number, bigint, string)
  return {
    success: true,
    status: 'success',
    result: rawResponse as T,
    rawResponse,
  };
}

/**
 * Maps vault contract responses (deposit, withdraw, get_balance) into a stable, typed `VaultMappedResult`.
 *
 * @param operation - Vault operation type ('deposit' | 'withdraw' | 'get_balance')
 * @param rawResponse - Raw response from Soroban vault invocation or VaultResult
 * @param context - Additional contextual parameters like requested amount
 * @returns Structured VaultMappedResult
 */
export function mapVaultInvocationResult(
  operation: VaultOperationType,
  rawResponse: unknown,
  context?: { amount?: string; contractId?: string; hash?: string }
): VaultMappedResult {
  const genericResult = mapSorobanInvocationResult(rawResponse, { operation });
  const hash = genericResult.hash || context?.hash;

  if (!genericResult.success) {
    return {
      success: false,
      status: genericResult.status,
      operation,
      hash,
      amount: context?.amount,
      error: genericResult.error || 'Vault operation failed',
      errorCode: genericResult.errorCode || 'VAULT_OPERATION_FAILED',
    };
  }

  if (operation === 'get_balance') {
    let rawValue = genericResult.result;
    let balanceXLM = '0';
    let rawStroops: string | undefined;

    // Exact conversions through the shared amount model: Number()/parseFloat
    // lose the low digits of any balance above 2^53 stroops (~900M XLM).
    if (rawValue !== undefined && rawValue !== null) {
      if (typeof rawValue === 'string') {
        // If already formatted as XLM string (e.g. "15.0000000"), require
        // the shared exact parser to accept it before exposing a balance.
        if (rawValue.includes('.')) {
          const parsed = safeParseAmount(rawValue);
          if (!parsed.valid) {
            return {
              success: false,
              status: 'error',
              operation,
              error: 'Vault balance response is not a valid non-negative amount.',
              errorCode: ErrorCode.SOROBAN_INVALID_RESPONSE,
            };
          }
          balanceXLM = rawValue;
          rawStroops = parsed.amount.toStroopString();
        } else {
          // Raw stroops must be an unsigned decimal integer. Validate before
          // BigInt() so malformed RPC data fails closed instead of throwing.
          if (!/^\\d+$/.test(rawValue)) {
            return {
              success: false,
              status: 'error',
              operation,
              error: 'Vault balance response is not a valid non-negative stroop value.',
              errorCode: ErrorCode.SOROBAN_INVALID_RESPONSE,
            };
          }
          rawStroops = rawValue;
          balanceXLM = formatStroops(BigInt(rawValue));
        }
      } else if (typeof rawValue === 'bigint') {
        rawStroops = rawValue.toString();
        balanceXLM = formatStroops(rawValue);
      } else if (typeof rawValue === 'number') {
        if (!Number.isSafeInteger(rawValue)) {
          return {
            success: false,
            status: 'error',
            operation,
            error: 'Vault balance cannot be represented exactly as a JavaScript number.',
            errorCode: ErrorCode.SOROBAN_INVALID_RESPONSE,
          };
        }
        rawStroops = String(rawValue);
        balanceXLM = formatStroops(BigInt(rawValue));
      }
    }

    return {
      success: true,
      status: 'success',
      operation,
      balance: balanceXLM,
      rawStroops,
    };
  }

  // deposit or withdraw operations
  return {
    success: true,
    status: genericResult.status,
    operation,
    hash,
    amount: context?.amount,
  };
}

// ─── Simulation result mapper (issue #337) ───────────────────────────────────

function callApiGuard(
  name: 'isSimulationError' | 'isSimulationRestore' | 'isSimulationSuccess',
  response: unknown,
): boolean | undefined {
  const api = StellarSDK.rpc?.Api as
    | Partial<
        Record<
          'isSimulationError' | 'isSimulationRestore' | 'isSimulationSuccess',
          (value: unknown) => boolean
        >
      >
    | undefined;
  const fn = api?.[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return Boolean(fn(response));
  } catch {
    return undefined;
  }
}

function extractSimulationCost(resp: Record<string, any>): SimulationMappedResult['cost'] {
  const cpu =
    resp.cost?.cpuIns ??
    resp.cost?.cpuInstructions ??
    resp.cost?.cpuInsns;
  const mem = resp.cost?.memBytes ?? resp.cost?.ramBytes;
  const fee = resp.minResourceFee;
  if (cpu == null && mem == null && fee == null) return undefined;
  return {
    cpuInstructions: cpu != null ? String(cpu) : undefined,
    ramBytes: mem != null ? String(mem) : undefined,
    minResourceFee: fee != null ? String(fee) : undefined,
  };
}

function collectSimulationWarnings(resp: Record<string, any>): SimulationWarning[] {
  const warnings: SimulationWarning[] = [];

  if (Array.isArray(resp.warnings)) {
    for (const item of resp.warnings) {
      if (typeof item === 'string') {
        warnings.push({ code: 'SIMULATION_WARNING', message: item });
      } else if (item && typeof item === 'object') {
        const w = item as Record<string, unknown>;
        warnings.push({
          code: String(w.code ?? 'SIMULATION_WARNING'),
          message: String(w.message ?? w.detail ?? JSON.stringify(item)),
        });
      }
    }
  }

  if (Array.isArray(resp.events) && resp.events.length > 0) {
    warnings.push({
      code: 'SIMULATION_EVENTS',
      message: `Simulation emitted ${resp.events.length} diagnostic event(s).`,
    });
  }

  return warnings;
}

function parseSimulationRetval<T>(
  resp: Record<string, any>,
  parseRetval?: (retval: unknown) => unknown,
): T | undefined {
  const retval = resp.result?.retval;
  if (retval === undefined || retval === null) return undefined;
  if (parseRetval) {
    try {
      return parseRetval(retval) as T;
    } catch {
      return retval as T;
    }
  }
  try {
    return StellarSDK.scValToNative(retval) as T;
  } catch {
    return retval as T;
  }
}

/**
 * Classifies a raw Soroban `simulateTransaction` response into a typed
 * {@link SimulationMappedResult}.
 *
 * Prefers Stellar SDK Api guards when present; falls back to structural checks
 * so unit tests and alternate RPC shapes still map safely.
 */
export function mapSimulationResult<T = unknown>(
  response: unknown,
  options?: MapSimulationResultOptions,
): SimulationMappedResult<T> {
  if (response === null || response === undefined) {
    return {
      success: false,
      status: 'unknown',
      error: 'Empty or null simulation response',
      errorCode: ErrorCode.SOROBAN_SIMULATION_UNKNOWN,
      rawSimulation: response,
    };
  }

  if (typeof response !== 'object') {
    return {
      success: false,
      status: 'unknown',
      error: 'Simulation response is not an object',
      errorCode: ErrorCode.SOROBAN_SIMULATION_UNKNOWN,
      rawSimulation: response,
    };
  }

  const resp = response as Record<string, any>;
  const mapError = options?.mapError ?? mapSorobanContractError;

  const isError = callApiGuard('isSimulationError', response);
  const isRestore = callApiGuard('isSimulationRestore', response);
  const isSuccess = callApiGuard('isSimulationSuccess', response);

  const hasErrorField =
    resp.error != null &&
    (typeof resp.error === 'string' || typeof resp.error === 'object');
  const hasRestorePreamble =
    resp.restorePreamble != null && typeof resp.restorePreamble === 'object';
  const looksSuccessful =
    resp.result != null ||
    resp.transactionData != null ||
    resp.minResourceFee != null;

  const treatAsFailed =
    isError === true || (isError === undefined && hasErrorField);
  // Prefer restore when the SDK says so, or when a restore preamble is present
  // even if isSimulationRestore returns false for incomplete fixtures.
  const treatAsRestore =
    !treatAsFailed && (isRestore === true || hasRestorePreamble);
  const treatAsSuccess =
    !treatAsFailed &&
    !treatAsRestore &&
    (isSuccess === true || looksSuccessful);

  if (treatAsFailed) {
    const mapped = mapError(resp.error ?? 'Soroban transaction simulation failed');
    const genericCodes = new Set([
      'SOROBAN_ERROR',
      'UNKNOWN_SOROBAN_ERROR',
      'SOROBAN_CONTRACT_ERROR',
      'SIMULATION_ERROR',
      'SIMULATION_FAILED',
      'UNKNOWN_ERROR',
    ]);
    const mappedCode =
      mapped.errorCode != null ? String(mapped.errorCode) : undefined;
    const errorCode =
      mappedCode && !genericCodes.has(mappedCode)
        ? mapped.errorCode
        : ErrorCode.SOROBAN_SIMULATION_FAILED;
    return {
      success: false,
      status: 'failed',
      error:
        typeof mapped.error === 'string' && mapped.error.startsWith('Simulation failed')
          ? mapped.error
          : `Simulation failed: ${mapped.error}`,
      errorCode,
      rawSimulation: response,
    };
  }

  if (treatAsRestore) {
    return {
      success: false,
      status: 'unsupported',
      error: 'State requires restoration before simulation can complete',
      errorCode: ErrorCode.SOROBAN_SIMULATION_UNSUPPORTED,
      rawSimulation: response,
    };
  }

  if (treatAsSuccess) {
    const warnings = collectSimulationWarnings(resp);
    const status: SimulationResultStatus = warnings.length > 0 ? 'warning' : 'success';
    return {
      success: true,
      status,
      result: parseSimulationRetval<T>(resp, options?.parseRetval),
      cost: extractSimulationCost(resp),
      warnings: warnings.length > 0 ? warnings : undefined,
      rawSimulation: response,
    };
  }

  return {
    success: false,
    status: 'unknown',
    error: 'Unknown simulation response state',
    errorCode: ErrorCode.SOROBAN_SIMULATION_UNKNOWN,
    rawSimulation: response,
  };
}

/**
 * Builds a typed {@link PocketPayError} from a non-proceedable simulation map.
 * Callers must only invoke this when `mapped.success` is false.
 */
export function pocketPayErrorFromSimulation(
  mapped: SimulationMappedResult,
  fallbackMessage = 'Contract simulation failed',
): PocketPayError {
  const fallbackCode =
    mapped.status === 'unsupported'
      ? ErrorCode.SOROBAN_SIMULATION_UNSUPPORTED
      : mapped.status === 'unknown'
        ? ErrorCode.SOROBAN_SIMULATION_UNKNOWN
        : ErrorCode.SOROBAN_SIMULATION_FAILED;

  const codeStr = String(mapped.errorCode ?? fallbackCode);
  const spec =
    (ERROR_CODES as Record<string, (typeof ERROR_CODES)[ErrorCodeValue]>)[codeStr] ??
    ERROR_CODES[fallbackCode];

  return new PocketPayError(mapped.error ?? fallbackMessage, codeStr, {
    cause: mapped.error ? new Error(mapped.error) : undefined,
    category: spec.category,
    safeMessage: spec.safeMessage,
  });
}

/**
 * Maps simulation status onto {@link SorobanInvocationStatus} for invoke results.
 */
export function simulationStatusToInvocationStatus(
  status: SimulationResultStatus,
): SorobanInvocationStatus {
  switch (status) {
    case 'success':
    case 'warning':
      return 'success';
    case 'failed':
    case 'unsupported':
    case 'unknown':
      return 'simulation_error';
    default:
      return 'simulation_error';
  }
}
