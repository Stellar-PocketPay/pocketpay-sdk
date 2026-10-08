/**
 * Stellar PocketPay SDK — Soroban Contract Client Factory
 *
 * Provides a reusable factory for creating typed contract clients.
 * Separates read-only and state-changing calls with consistent error mapping.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { resolveConfig, getNetworkPassphrase, validateContractId } from '../config';
import {
  PocketPayError,
  SDKConfig,
  SorobanInvocationStatus,
} from '../types';
import { withTimeout } from '../network';
import { ErrorCode, ERROR_CODES } from '../errors/codes';
import { UnsupportedFeatureError } from '../errors/unsupported';
import {
  toStroops,
  validateAmount,
  validatePublicKey,
  validateSecretKey,
} from '../utils';
import {
  mapSorobanContractError,
  mapSimulationResult,
  pocketPayErrorFromSimulation,
  simulationStatusToInvocationStatus,
} from './mapper';
import type { SimulationMappedResult, SimulationWarning } from '../types';
// ─── Type Definitions ───────────────────────────────────────────────────────────

/**
 * Configuration for creating a contract client.
 */
export interface ContractMethodDefinition {
  /** Whether the method is simulation-only or may change contract state. */
  kind: 'readOnly' | 'invoke';
  /** Soroban parameter encodings, in contract argument order. */
  paramTypes: ParamTypes;
}

/**
 * Runtime method schema used to reject unsupported or misrouted calls before
 * account lookup, simulation, or signing. Omit it for fully dynamic contracts.
 */
export type ContractMethodSchema = Record<string, ContractMethodDefinition>;

export interface ContractClientConfig<
  TMethods extends ContractMethodSchema = ContractMethodSchema,
> {
  /** The Soroban contract ID (C...) */
  contractId: string;
  /** Optional SDK configuration overrides */
  config?: Partial<SDKConfig>;
  /** Optional runtime schema of methods supported by this client. */
  methods?: TMethods;
}

/**
 * Result of a state-changing contract invocation.
 */
export interface ContractInvokeResult<T = unknown> {
  /** Whether the invocation succeeded */
  success: boolean;
  /** Stable SDK status for the invocation. */
  status: SorobanInvocationStatus;
  /** Transaction hash (if submitted on-chain) */
  hash?: string;
  /** Parsed return value from the contract (if available) */
  value?: T;
  /** Error message if failed */
  error?: string;
  /** Contract-specific or SDK error code if failed. */
  errorCode?: string | number;
  /**
   * Typed simulation classification when the invoke path stopped (or warned)
   * at simulation. See {@link mapSimulationResult}.
   */
  simulationStatus?: import('../types').SimulationResultStatus;
  /** Non-fatal simulation advisories when status is warning. */
  warnings?: SimulationWarning[];
}

/**
 * Soroban ScVal type specification for parameter encoding.
 */
export type ScValType = 
  | 'address'
  | 'bool'
  | 'i128'
  | 'i256'
  | 'i64'
  | 'i32'
  | 'u128'
  | 'u256'
  | 'u64'
  | 'u32'
  | 'bytes'
  | 'string'
  | 'symbol'
  | 'vec'
  | 'map'
  | 'option'
  | 'void';

/**
 * Parameter type mapping for contract method calls.
 */
export interface ParamTypes {
  [paramName: string]: ScValType;
}

/**
 * Parameters for a read-only contract call.
 */
export interface ReadOnlyCallOptions<
  TParams = Record<string, unknown>,
  TMethod extends string = string,
> {
  /** The contract method name to call */
  method: TMethod;
  /** Parameters to pass to the method */
  params: TParams;
  /** Type specification for each parameter (defaults to the method schema) */
  paramTypes?: ParamTypes;
  /** Optional parser for the return value (defaults to scValToNative) */
  resultParser?: (scVal: StellarSDK.xdr.ScVal) => unknown;
  /** Source account for building the transaction (required for read calls) */
  sourcePublicKey: string;
}

/**
 * Parameters for a state-changing contract call.
 */
export interface InvokeCallOptions<
  TParams = Record<string, unknown>,
  TMethod extends string = string,
> {
  /** The contract method name to call */
  method: TMethod;
  /** Parameters to pass to the method */
  params: TParams;
  /** Type specification for each parameter (defaults to the method schema) */
  paramTypes?: ParamTypes;
  /** Secret key of the account signing the transaction */
  signWith: string;
  /** Optional parser for the return value (defaults to scValToNative) */
  resultParser?: (scVal: StellarSDK.xdr.ScVal) => unknown;
}

/**
 * Error mapping configuration for contract-specific error codes.
 */
export interface ErrorMapping {
  /** Map contract error strings to SDK error codes */
  [contractError: string]: string;
}

type MethodNameForKind<
  TMethods extends ContractMethodSchema,
  TKind extends ContractMethodDefinition['kind'],
> = string extends keyof TMethods
  ? string
  : Extract<
      {
        [TName in keyof TMethods]: TMethods[TName]['kind'] extends TKind
          ? TName
          : never;
      }[keyof TMethods],
      string
    >;

// ─── Contract Client Class ───────────────────────────────────────────────────────

/**
 * Typed contract client for Soroban smart contracts.
 *
 * Provides methods for read-only (simulated) calls and state-changing
 * (signed/submitted) calls with consistent error handling.
 */
export class ContractClient<
  TMethods extends ContractMethodSchema = ContractMethodSchema,
> {
  private readonly contractId: string;
  private readonly config: SDKConfig;
  private readonly sorobanServer: StellarSDK.rpc.Server;
  private readonly networkPassphrase: string;
  private readonly contract: StellarSDK.Contract;
  private readonly errorMapping: ErrorMapping;
  private readonly methods?: TMethods;

  constructor(
    config: ContractClientConfig<TMethods>,
    errorMapping: ErrorMapping = {}
  ) {
    validateContractId(config.contractId);
    this.contractId = config.contractId;
    this.config = resolveConfig(config.config);
    this.sorobanServer = new StellarSDK.rpc.Server(this.config.sorobanRpcUrl);
    this.networkPassphrase = getNetworkPassphrase(this.config.network);
    this.contract = new StellarSDK.Contract(this.contractId);
    this.errorMapping = errorMapping;
    this.methods = config.methods;
  }

  /**
   * Performs a read-only contract call via simulation.
   *
   * This method builds a transaction, simulates it, and returns the
   * parsed result without signing or submitting to the network.
   *
   * @param options - Read-only call options
   * @returns Parsed return value from the contract
   * @throws PocketPayError if the call fails
   */
  /**
   * Simulates a contract call and returns the authorisation entries it requires.
   *
   * `simulateTransaction` reports these in `result.auth`, naming the addresses
   * that must approve the invocation. Until now the SDK read only
   * `result.retval` here and let `assembleTransaction` consume the entries
   * internally, so it acted on requirements it never surfaced. Pass the result
   * to `mapAuthRequirements` to fold them into a full authorisation summary.
   *
   * @param options - The same options as {@link ContractClient.readOnly}
   * @returns The authorisation entries, empty when the call needs none
   */
  public async getAuthorizationEntries(
    options: ReadOnlyCallOptions<
      Record<string, unknown>,
      MethodNameForKind<TMethods, 'readOnly'>
    >,
  ): Promise<StellarSDK.xdr.SorobanAuthorizationEntry[]> {
    const { method, params, sourcePublicKey } = options;
    this.assertSupportedMethod(method, 'readOnly');
    const paramTypes = this.resolveParamTypes(
      method,
      params,
      options.paramTypes,
    );

    const account = await this.getAccount(sourcePublicKey);
    const tx = this.buildTransaction(account, method, params, paramTypes);

    const simulated = await withTimeout(
      'Soroban transaction simulation',
      this.config.timeout,
      this.sorobanServer.simulateTransaction(tx),
    );

    const mapped = this.mapSimulation(simulated);
    if (!mapped.success) {
      throw pocketPayErrorFromSimulation(mapped);
    }

    const success = mapped.rawSimulation as StellarSDK.rpc.Api.SimulateTransactionSuccessResponse;
    return success.result?.auth ? [...success.result.auth] : [];
  }

  public async readOnly<T = unknown>(
    options: ReadOnlyCallOptions<
      Record<string, unknown>,
      MethodNameForKind<TMethods, 'readOnly'>
    >,
  ): Promise<T> {
    const { method, params, resultParser, sourcePublicKey } = options;

    try {
      this.assertSupportedMethod(method, 'readOnly');
      const paramTypes = this.resolveParamTypes(
        method,
        params,
        options.paramTypes,
      );

      // Build transaction with the contract call
      const account = await this.getAccount(sourcePublicKey);
      const tx = this.buildTransaction(account, method, params, paramTypes);

      // Simulate the transaction
      const simulated = await withTimeout(
        'Soroban transaction simulation',
        this.config.timeout,
        this.sorobanServer.simulateTransaction(tx),
      );

      const mapped = this.mapSimulation(
        simulated,
        resultParser
          ? (retval) => resultParser(retval as StellarSDK.xdr.ScVal)
          : undefined,
      );
      if (!mapped.success) {
        throw pocketPayErrorFromSimulation(mapped);
      }

      if (mapped.result !== undefined) {
        return mapped.result as T;
      }

      return undefined as T;
    } catch (error) {
      if (error instanceof PocketPayError) throw error;
      throw this.wrapError(error, `Read-only call to ${method} failed`, 'CONTRACT_READONLY_ERROR');
    }
  }

  /**
   * Performs a state-changing contract call.
   *
   * This method builds, simulates, signs, and submits a transaction,
   * then polls for the final result.
   *
   * @param options - Invoke call options
   * @returns Contract invocation result with transaction details
   * @throws PocketPayError if the call fails
   */
  public async invoke<T = unknown>(
    options: InvokeCallOptions<
      Record<string, unknown>,
      MethodNameForKind<TMethods, 'invoke'>
    >,
  ): Promise<ContractInvokeResult<T>> {
    const { method, params, signWith, resultParser } = options;

    try {
      this.assertSupportedMethod(method, 'invoke');
      const paramTypes = this.resolveParamTypes(
        method,
        params,
        options.paramTypes,
      );

      const keypair = StellarSDK.Keypair.fromSecret(signWith);
      const publicKey = keypair.publicKey();
      const account = await this.getAccount(publicKey);

      // Build transaction with the contract call
      const tx = this.buildTransaction(account, method, params, paramTypes);

      // Simulate the transaction
      const simulated = await withTimeout(
        'Soroban transaction simulation',
        this.config.timeout,
        this.sorobanServer.simulateTransaction(tx),
      );

      const mapped = this.mapSimulation(simulated);
      if (!mapped.success) {
        return {
          success: false,
          status: simulationStatusToInvocationStatus(mapped.status),
          error: mapped.error ?? 'Simulation failed',
          errorCode: mapped.errorCode ?? ErrorCode.SOROBAN_SIMULATION_FAILED,
          simulationStatus: mapped.status,
        };
      }

      // Prepare and sign the transaction
      const prepared = StellarSDK.rpc
        .assembleTransaction(
          tx,
          mapped.rawSimulation as StellarSDK.rpc.Api.SimulateTransactionResponse,
        )
        .build();
      prepared.sign(keypair);

      // Submit the transaction
      const sendResult = await withTimeout(
        'Soroban transaction submission',
        this.config.timeout,
        this.sorobanServer.sendTransaction(prepared),
      );

      if (sendResult.status === 'ERROR') {
        return {
          success: false,
          status: 'failed',
          error: `Send error: ${sendResult.errorResult}`,
          errorCode: 'SUBMISSION_ERROR',
        };
      }

      // The transaction has already been submitted. A timeout, missing
      // confirmation or unreachable RPC endpoint does NOT prove failure.
      // Keep the hash so consumers can reconcile without resubmitting.
      const getResult = await this.pollTransactionStatus(sendResult.hash)
        .catch(() => null);

      if (getResult === null || getResult.status === 'NOT_FOUND') {
        return {
          success: false,
          status: 'pending',
          hash: sendResult.hash,
          error: 'Transaction was submitted but its final status is unknown. Check the hash before retrying.',
          errorCode: 'TX_STATUS_UNKNOWN',
          simulationStatus: mapped.status,
          warnings: mapped.warnings,
        };
      }

      if (getResult.status === 'SUCCESS') {
        let value: T | undefined;
        const successResult = getResult as StellarSDK.rpc.Api.GetSuccessfulTransactionResponse;
        if (successResult.returnValue) {
          const parser = resultParser || StellarSDK.scValToNative;
          value = parser(successResult.returnValue) as T;
        }

        return {
          success: true,
          status: 'success',
          hash: sendResult.hash,
          value,
          simulationStatus: mapped.status,
          warnings: mapped.warnings,
        };
      }

      if (getResult.status === 'FAILED') {
        return {
          success: false,
          status: 'failed',
          hash: sendResult.hash,
          error: 'Transaction was confirmed failed',
          errorCode: 'TX_STATUS_FAILED',
        };
      }

      // Unknown future SDK status: never claim a definitive failure.
      return {
        success: false,
        status: 'pending',
        hash: sendResult.hash,
        error: 'Transaction status is not final. Reconcile by hash before retrying.',
        errorCode: 'TX_STATUS_UNKNOWN',
      };
    } catch (error) {
      if (error instanceof PocketPayError) throw error;
      throw this.wrapError(error, `Invoke call to ${method} failed`, 'CONTRACT_INVOKE_ERROR');
    }
  }

  /**
   * Gets the account information for building transactions.
   */
  private async getAccount(publicKey: string) {
    return await withTimeout(
      'Soroban account lookup',
      this.config.timeout,
      this.sorobanServer.getAccount(publicKey),
    );
  }

  /**
   * Builds a transaction with a contract call operation.
   */
  private buildTransaction(
    account: any,
    method: string,
    params: Record<string, unknown>,
    paramTypes: ParamTypes
  ): StellarSDK.Transaction {
    const scParams = this.encodeParams(params, paramTypes);

    return new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...scParams))
      .setTimeout(30)
      .build();
  }

  /**
   * Encodes parameters to ScVal format based on type specifications.
   *
   * `ScValType` advertises every member below as usable, but the underlying
   * Stellar SDK rejects `vec` during encoding (`invalid type: vec`). Callers
   * used to receive that bare message with no code or category; the capability
   * is now reported through the published standard instead.
   */
  private encodeParams(params: Record<string, unknown>, paramTypes: ParamTypes): StellarSDK.xdr.ScVal[] {
    return Object.entries(paramTypes).map(([paramName, type]) => {
      const value = params[paramName];
      if (value === undefined) {
        throw new PocketPayError(
          `Missing parameter: ${paramName}`,
          'MISSING_CONTRACT_PARAM',
          { validation: { field: paramName, reason: 'missing' } }
        );
      }
      if (type === 'vec') {
        throw new UnsupportedFeatureError({
          module: 'soroban',
          operation: 'encodeParams',
          capability: 'soroban.param-type.vec',
          message:
            `Parameter "${paramName}" declares the ScVal type "vec", which this SDK cannot encode.`,
        });
      }
      return StellarSDK.nativeToScVal(value, { type });
    });
  }

  /**
   * Rejects methods that are absent from the configured schema, as well as
   * attempts to route a read-only method through the signing path (or vice
   * versa). Dynamic clients without a schema continue to accept any non-empty
   * method name.
   */
  private assertSupportedMethod(
    method: string,
    expectedKind: ContractMethodDefinition['kind'],
  ): void {
    const definition = this.methods?.[method];
    const unsupported = method.trim().length === 0 || (this.methods && !definition);
    const wrongKind = definition && definition.kind !== expectedKind;

    if (unsupported || wrongKind) {
      const reason = wrongKind
        ? `Method "${method}" is declared as ${definition.kind}, not ${expectedKind}.`
        : `Method "${method}" is not supported by this contract client.`;
      throw new UnsupportedFeatureError({
        module: 'soroban',
        operation: method || '<empty>',
        capability: `soroban.contract-method.${expectedKind}`,
        message: reason,
      });
    }
  }

  /**
   * Uses call-local encodings when supplied, otherwise the factory schema.
   * Parameterized dynamic calls must provide encodings explicitly.
   */
  private resolveParamTypes(
    method: string,
    params: Record<string, unknown>,
    supplied?: ParamTypes,
  ): ParamTypes {
    const resolved = supplied ?? this.methods?.[method]?.paramTypes;
    if (!resolved && Object.keys(params).length > 0) {
      throw new PocketPayError(
        `Parameter types are required for contract method "${method}".`,
        'MISSING_CONTRACT_PARAM_TYPES',
        {
          validation: {
            field: 'paramTypes',
            reason: 'missing',
          },
        },
      );
    }
    return resolved ?? {};
  }

  /**
   * Polls for transaction status until it resolves.
   */
  private async pollTransactionStatus(hash: string): Promise<
    StellarSDK.rpc.Api.GetSuccessfulTransactionResponse
    | StellarSDK.rpc.Api.GetFailedTransactionResponse
    | { status: 'NOT_FOUND' }
  > {
    // Limit total confirmation time, not just each individual RPC request.
    // A permanently NOT_FOUND hash must not block invoke() forever.
    const deadline = Date.now() + this.config.timeout;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'NOT_FOUND' };

      const result = await withTimeout(
        'Soroban transaction status request',
        remaining,
        this.sorobanServer.getTransaction(hash),
      );
      if (result.status !== 'NOT_FOUND') return result;

      const wait = Math.min(1000, deadline - Date.now());
      if (wait <= 0) return { status: 'NOT_FOUND' };
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * Maps contract-specific errors to SDK error codes.
   */
  private mapContractError(
    error: unknown,
  ): { error: string; errorCode?: string | number } {
    const mapped = mapSorobanContractError(error);
    for (const [contractError, sdkCode] of Object.entries(this.errorMapping)) {
      if (mapped.error.toLowerCase().includes(contractError.toLowerCase())) {
        return { error: mapped.error, errorCode: sdkCode };
      }
    }
    return mapped;
  }

  /**
   * Classifies a raw `simulateTransaction` response via {@link mapSimulationResult}.
   */
  private mapSimulation(
    simulated: unknown,
    parseRetval?: (retval: unknown) => unknown,
  ): SimulationMappedResult {
    return mapSimulationResult(simulated, {
      mapError: (error) => this.mapContractError(error),
      parseRetval,
    });
  }

  /**
   * Wraps an error in a PocketPayError.
   */
  private wrapError(error: unknown, message: string, code: string): PocketPayError {
    if (error instanceof PocketPayError) return error;
    return new PocketPayError(message, code, { cause: error as Error });
  }

  /**
   * Gets the contract ID for this client.
   */
  getContractId(): string {
    return this.contractId;
  }

  /**
   * Gets the Soroban RPC server instance.
   */
  getSorobanServer(): StellarSDK.rpc.Server {
    return this.sorobanServer;
  }
}

// ─── Factory Function ───────────────────────────────────────────────────────────

/**
 * Factory function for creating typed contract clients.
 *
 * @param config - Contract client configuration
 * @param errorMapping - Optional error mapping for contract-specific errors
 * @returns A new ContractClient instance
 */
export function createContractClient<
  TMethods extends ContractMethodSchema = ContractMethodSchema,
>(
  config: ContractClientConfig<TMethods>,
  errorMapping?: ErrorMapping
): ContractClient<TMethods> {
  return new ContractClient(config, errorMapping);
}

// ─── Specialized Vault Client ────────────────────────────────────────────────────

/**
 * Specialized client for the PocketPay Savings Vault contract.
 *
 * Provides typed methods for vault-specific operations with built-in
 * parameter encoding and result parsing.
 */
const VAULT_METHODS = {
  deposit: {
    kind: 'invoke',
    paramTypes: { user: 'address', amount: 'i128' },
  },
  withdraw: {
    kind: 'invoke',
    paramTypes: { user: 'address', amount: 'i128' },
  },
  get_balance: {
    kind: 'readOnly',
    paramTypes: { user: 'address' },
  },
} as const satisfies ContractMethodSchema;

export class VaultClient extends ContractClient<typeof VAULT_METHODS> {
  constructor(config: ContractClientConfig) {
    const errorMapping: ErrorMapping = {
      'insufficient balance': 'VAULT_INSUFFICIENT_BALANCE',
      'unauthorized': 'VAULT_UNAUTHORIZED',
      'invalid amount': 'VAULT_INVALID_AMOUNT',
    };
    super({ ...config, methods: VAULT_METHODS }, errorMapping);
  }

  /**
   * Deposits XLM into the vault.
   */
  async deposit(sourceSecret: string, amount: string): Promise<ContractInvokeResult<void>> {
    validateSecretKey(sourceSecret);
    validateAmount(amount);
    const user = StellarSDK.Keypair.fromSecret(sourceSecret).publicKey();
    const amountInStroops = toStroops(amount);

    return this.invoke({
      method: 'deposit',
      params: { user, amount: amountInStroops },
      paramTypes: { user: 'address', amount: 'i128' },
      signWith: sourceSecret,
    });
  }

  /**
   * Withdraws XLM from the vault.
   */
  async withdraw(sourceSecret: string, amount: string): Promise<ContractInvokeResult<void>> {
    validateSecretKey(sourceSecret);
    validateAmount(amount);
    const user = StellarSDK.Keypair.fromSecret(sourceSecret).publicKey();
    const amountInStroops = toStroops(amount);

    return this.invoke({
      method: 'withdraw',
      params: { user, amount: amountInStroops },
      paramTypes: { user: 'address', amount: 'i128' },
      signWith: sourceSecret,
    });
  }

  /**
   * Gets the available balance for a user.
   */
  async getBalance(user: string): Promise<string> {
    validatePublicKey(user);
    const balance = await this.readOnly<bigint>({
      method: 'get_balance',
      params: { user },
      paramTypes: { user: 'address' },
      sourcePublicKey: user,
    });

    const balanceXLM = (Number(balance) / 10_000_000).toFixed(7);
    return balanceXLM;
  }
}

/**
 * Factory function for creating a specialized Vault client.
 *
 * @param config - Contract client configuration
 * @returns A new VaultClient instance
 */
export function createVaultClient(config: ContractClientConfig): VaultClient {
  return new VaultClient(config);
}
