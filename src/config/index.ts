/**
 * Stellar PocketPay SDK — Network Configuration
 *
 * Resolves Horizon and Soroban RPC endpoints based on the selected network.
 * Defaults to Stellar Testnet. Override via environment variables or programmatic config.
 */
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  SDKConfig,
  ResolvedSDKConfig,
  StellarNetwork,
  ConfigValidationIssue,
  ConfigValidationResult,
  ConfigSource,
  ConfigSourceMetadata,
  FeatureFlagsConfig,
  PocketPayError,
} from '../types';
import { DisabledFeatureError, FeatureContext } from '../errors';
import { redactSensitive } from '../utils';
import { emitDiagnosticsEvent } from '../diagnostics/hooks';
import { redactEndpointUrl } from '../diagnostics/redact';
// ─── Default URLs ───────────────────────────────────────────────────────────
const HORIZON_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
};
const SOROBAN_RPC_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban.stellar.org',
};
const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  testnet: StellarSDK.Networks.TESTNET,
  mainnet: StellarSDK.Networks.PUBLIC,
};
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const DEFAULT_TIMEOUT_MS = 30_000;
// ─── Validation ─────────────────────────────────────────────────────────────
/**
 * Validates that a network name is supported.
 *
 * @param network - The network name to validate
 * @throws PocketPayError if network is not 'testnet' or 'mainnet'
 */
export function validateNetwork(network: unknown): asserts network is StellarNetwork {
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new PocketPayError(
      `Unsupported network: "${network}". Supported networks: testnet, mainnet`,
      'INVALID_NETWORK',
      {
        validation: {
          field: 'network',
          reason: 'unsupported',
          value: network as string
        }
      }
    );
  }
}
/** Only expose an endpoint origin when reporting malformed or risky config. */
function sanitizeEndpointValue(value: unknown): string {
  return typeof value === 'string' ? redactEndpointUrl(value) : '[INVALID ENDPOINT]';
}

/**
 * Validates that a URL string is a valid HTTP(S) URL.
 *
 * @param url - The URL to validate
 * @param fieldName - Human-readable field name (for error messages)
 * @param errorCode - Machine-readable error code to attach on failure
 * @throws PocketPayError if URL is invalid
 */
export function validateUrl(url: string, fieldName: string, errorCode: string, field: string): void {
  try {
    const parsed = new URL(url);
    if (((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || !!parsed.username || !!parsed.password || !!parsed.hash)) {
      throw new Error('Protocol must be http or https');
    }
  } catch (error) {
    throw new PocketPayError(
      `Invalid ${fieldName}. Must be a credential-free HTTP(S) URL without a fragment.`,
      errorCode,
      {
        validation: {
          field,
          reason: 'invalid_url',
          value: sanitizeEndpointValue(url)
        }
      }
    );
  }
}
/**
 * Validates Horizon URL format.
 *
 * @param url - The URL to validate
 * @throws PocketPayError if URL is invalid
 */
export function validateHorizonUrl(url: string): void {
  validateUrl(url, 'Horizon URL', 'INVALID_HORIZON_URL', 'horizonUrl');
}
/**
 * Validates Soroban RPC URL format.
 *
 * @param url - The URL to validate
 * @throws PocketPayError if URL is invalid
 */
export function validateSorobanRpcUrl(url: string): void {
  validateUrl(url, 'Soroban RPC URL', 'INVALID_SOROBAN_RPC_URL', 'sorobanRpcUrl');
}
/**
 * Validates timeout value.
 *
 * @param timeout - The timeout value to validate (in milliseconds)
 * @throws PocketPayError if timeout is invalid
 */
export function validateTimeout(timeout: unknown): asserts timeout is number {
  if (typeof timeout !== 'number') {
    throw new PocketPayError(
      `Invalid timeout: "${timeout}". Timeout must be a number (milliseconds).`,
      'INVALID_TIMEOUT',
      {
        validation: {
          field: 'timeout',
          reason: 'invalid_type',
          value: timeout as string
        }
      }
    );
  }
  if (timeout <= 0) {
    throw new PocketPayError(
      `Invalid timeout: ${timeout}. Timeout must be greater than 0.`,
      'INVALID_TIMEOUT',
      {
        validation: {
          field: 'timeout',
          reason: 'not_positive',
          value: timeout
        }
      }
    );
  }
  if (!Number.isFinite(timeout)) {
    throw new PocketPayError(
      `Invalid timeout: ${timeout}. Timeout must be a finite number.`,
      'INVALID_TIMEOUT',
      {
        validation: {
          field: 'timeout',
          reason: 'not_finite',
          value: timeout
        }
      }
    );
  }
}
/**
 * Validates Soroban contract ID format.
 * Contract IDs are 56-character base32-encoded strings starting with 'C'.
 *
 * @param contractId - The contract ID to validate
 * @throws PocketPayError if contract ID is invalid
 */
export function validateContractId(contractId: string): void {
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new PocketPayError(
      `Invalid contract ID: "${contractId}". Contract ID must be a non-empty string.`,
      'INVALID_CONTRACT_ID',
      {
        validation: {
          field: 'contractId',
          reason: 'empty',
          value: contractId
        }
      }
    );
  }
  if (!contractId.startsWith('C') || contractId.length !== 56) {
    throw new PocketPayError(
      `Invalid contract ID: "${contractId}". Contract ID must be a 56-character base32 string starting with 'C'.`,
      'INVALID_CONTRACT_ID',
      {
        validation: {
          field: 'contractId',
          reason: 'invalid_format',
          value: contractId
        }
      }
    );
  }
  // Validate base32 characters (base32 uses A-Z and 2-7)
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    throw new PocketPayError(
      `Invalid contract ID format: "${contractId}". Contract ID must contain only base32 characters (A-Z, 2-7).`,
      'INVALID_CONTRACT_ID',
      {
        validation: {
          field: 'contractId',
          reason: 'invalid_characters',
          value: contractId
        }
      }
    );
  }
}
// ─── Feature Flags ───────────────────────────────────────────────────────────

/**
 * Default experimental feature flags. All experimental features are disabled by default.
 */
export const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  experimentalVault: false,
  experimentalSorobanEvents: false,
  experimentalMultiAssetVault: false,
  experimentalAsyncSigner: false,
  experimentalVaultLocks: false,
};

/**
 * Resolves feature flags from explicit overrides, environment variables, and defaults.
 *
 * Precedence: explicit override > env var (`POCKETPAY_FEATURE_<FLAG>`, `STELLAR_FEATURE_<FLAG>`, `POCKETPAY_FEATURE_FLAGS`) > default (false)
 *
 * @param overrides - Optional feature flags passed in SDKConfig
 * @returns Object containing resolved flags map and source metadata map
 */
export function resolveFeatureFlags(overrides?: FeatureFlagsConfig): {
  flags: Record<string, boolean>;
  sources: Record<string, ConfigSource>;
} {
  const flags: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS };
  const sources: Record<string, ConfigSource> = {};

  for (const key of Object.keys(flags)) {
    sources[key] = 'default';
  }

  // Comma-separated list in POCKETPAY_FEATURE_FLAGS or STELLAR_FEATURE_FLAGS
  const envFlagsList = process.env.POCKETPAY_FEATURE_FLAGS ?? process.env.STELLAR_FEATURE_FLAGS;
  if (envFlagsList) {
    const list = envFlagsList.split(',').map((s) => s.trim()).filter(Boolean);
    for (const key of list) {
      flags[key] = true;
      sources[key] = 'env';
    }
  }

  // Individual env vars e.g. POCKETPAY_FEATURE_EXPERIMENTAL_VAULT=true or STELLAR_FEATURE_EXPERIMENTAL_VAULT=true
  const knownKeys = new Set([...Object.keys(flags), ...(overrides ? Object.keys(overrides) : [])]);

  for (const key of knownKeys) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toUpperCase();
    const envVal =
      process.env[`POCKETPAY_FEATURE_${snakeKey}`] ??
      process.env[`STELLAR_FEATURE_${snakeKey}`] ??
      process.env[`POCKETPAY_${snakeKey}`];

    if (envVal !== undefined) {
      const boolVal = envVal.toLowerCase() === 'true' || envVal === '1';
      flags[key] = boolVal;
      sources[key] = 'env';
    }
  }

  // Overrides in config
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      if (typeof val === 'boolean') {
        flags[key] = val;
        sources[key] = 'override';
      }
    }
  }

  return { flags, sources };
}

/**
 * Checks whether an experimental feature flag is currently enabled.
 *
 * @param flag - Feature flag key (e.g. 'experimentalVault')
 * @param config - Optional SDK configuration overrides
 * @returns `true` if enabled
 */
export function isFeatureEnabled(flag: string, config?: Partial<SDKConfig>): boolean {
  const resolved = resolveConfig(config);
  return Boolean(resolved.featureFlags[flag]);
}

/**
 * Asserts that an experimental feature flag is enabled. Throws {@link DisabledFeatureError} if disabled.
 *
 * @param flag - Feature flag key
 * @param context - Feature context describing module and operation
 * @param config - Optional SDK configuration overrides
 * @throws DisabledFeatureError if the feature flag is disabled
 */
export function assertFeatureEnabled(
  flag: string,
  context: FeatureContext,
  config?: Partial<SDKConfig>
): void {
  if (!isFeatureEnabled(flag, config)) {
    throw new DisabledFeatureError({
      featureFlag: flag,
      module: context.module,
      operation: context.operation,
      capability: context.capability,
      message: `Experimental feature '${flag}' is disabled. Enable it in SDKConfig.featureFlags or environment variables to use ${context.module}.${context.operation}.`,
    });
  }
}

// ─── Resolve Config ─────────────────────────────────────────────────────────
/**
 * Resolves the SDK configuration by merging environment variables with defaults.
 *
 * Priority: explicit param > env var > default (testnet)
 * All configuration values are validated before returning. Values passed
 * explicitly in `overrides` are validated as-is: an explicit `null`, empty
 * string, or other invalid value is rejected rather than silently replaced
 * by a default.
 *
 * @param overrides - Optional partial config to override defaults
 * @returns Fully resolved and validated SDK configuration with config source metadata
 * @throws PocketPayError if any configuration value is invalid
 */
export function resolveConfig(overrides?: Partial<SDKConfig>): ResolvedSDKConfig {
  const networkSource: ConfigSource =
    overrides?.network !== undefined
      ? 'override'
      : process.env.STELLAR_NETWORK !== undefined
      ? 'env'
      : 'default';

  // Network: an explicitly-provided value (including null) must be validated
  // as-is; only undefined falls through to env var, then the testnet default.
  const network: unknown =
    overrides?.network !== undefined
      ? overrides.network
      : process.env.STELLAR_NETWORK ?? 'testnet';
  validateNetwork(network);

  const horizonUrlSource: ConfigSource =
    overrides?.horizonUrl !== undefined
      ? 'override'
      : process.env.STELLAR_HORIZON_URL !== undefined
      ? 'env'
      : 'default';

  // Horizon URL: an explicitly-provided value (including '') is validated
  // as-is; only undefined falls through to env var, then the network default.
  const horizonUrl =
    overrides?.horizonUrl !== undefined
      ? overrides.horizonUrl
      : process.env.STELLAR_HORIZON_URL ?? HORIZON_URLS[network];
  validateHorizonUrl(horizonUrl);

  const sorobanRpcUrlSource: ConfigSource =
    overrides?.sorobanRpcUrl !== undefined
      ? 'override'
      : process.env.STELLAR_SOROBAN_RPC_URL !== undefined
      ? 'env'
      : 'default';

  // Soroban RPC URL: same explicit-value semantics as Horizon URL.
  const sorobanRpcUrl =
    overrides?.sorobanRpcUrl !== undefined
      ? overrides.sorobanRpcUrl
      : process.env.STELLAR_SOROBAN_RPC_URL ?? SOROBAN_RPC_URLS[network];
  validateSorobanRpcUrl(sorobanRpcUrl);

  const timeoutSource: ConfigSource =
    overrides?.timeout !== undefined
      ? 'override'
      : process.env.STELLAR_TIMEOUT !== undefined
      ? 'env'
      : 'default';

  // Timeout: explicit override > env var > SDK default.
  const timeout =
    overrides?.timeout ??
    (process.env.STELLAR_TIMEOUT
      ? parseInt(process.env.STELLAR_TIMEOUT, 10)
      : DEFAULT_TIMEOUT_MS);
  validateTimeout(timeout);

  let contractIdSource: ConfigSource | undefined = undefined;
  if (overrides?.contractId !== undefined) {
    contractIdSource = 'override';
  } else if (process.env.STELLAR_CONTRACT_ID !== undefined || process.env.VAULT_CONTRACT_ID !== undefined) {
    contractIdSource = 'env';
  }

  // Contract ID: preserve an explicitly-provided value (including '').
  // An empty string is a valid "no contract configured" sentinel and is
  // passed through unvalidated; a non-empty value is validated.
  const contractId =
    overrides?.contractId !== undefined
      ? overrides.contractId
      : process.env.STELLAR_CONTRACT_ID;
  if (contractId !== undefined && contractId.length > 0) {
    validateContractId(contractId);
  }

  const resolvedFlags = resolveFeatureFlags(overrides?.featureFlags);

  const sources: ConfigSourceMetadata = {
    network: networkSource,
    horizonUrl: horizonUrlSource,
    sorobanRpcUrl: sorobanRpcUrlSource,
    timeout: timeoutSource,
    ...(contractIdSource ? { contractId: contractIdSource } : {}),
    featureFlags: resolvedFlags.sources,
  };

  const resolved: ResolvedSDKConfig = {
    network,
    horizonUrl,
    sorobanRpcUrl,
    timeout,
    contractId,
    featureFlags: resolvedFlags.flags,
    sources,
  };

  emitDiagnosticsEvent('config', 'config.resolved', {
    network: resolved.network,
    horizonUrl: resolved.horizonUrl,
    sorobanRpcUrl: resolved.sorobanRpcUrl,
    timeoutMs: resolved.timeout,
    contractIdConfigured:
      typeof resolved.contractId === 'string' && resolved.contractId.length > 0,
    sources: resolved.sources,
    featureFlags: resolved.featureFlags,
  });

  return resolved;
}

/**
 * Helper to sanitize potential sensitive values in validation outputs.
 * Never exposes secret keys or sensitive strings in issue outputs.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitive(value);
  }
  return value;
}

/**
 * Validates SDK configuration and returns a structured summary of issues and warnings.
 *
 * Unlike {@link resolveConfig}, this helper does not throw on invalid parameters.
 * Instead, it collects all errors and advisory warnings into a structured {@link ConfigValidationResult}.
 *
 * @param overrides - Optional partial SDK configuration or unvalidated config object to evaluate
 * @returns Structured validation result containing `valid`, `issues`, `errors`, `warnings`, and resolved `config` if valid
 *
 * @example
 * ```ts
 * const result = validatePocketPayConfig({
 *   network: 'testnet',
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 * });
 *
 * if (!result.valid) {
 *   console.error('Config validation failed:', result.errors);
 * } else {
 *   console.log('Resolved config:', result.config);
 * }
 * ```
 */
export function validatePocketPayConfig(
  overrides?: Partial<SDKConfig> | Record<string, unknown>
): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];

  // 1. Network Validation
  const rawNetwork: unknown =
    overrides?.network !== undefined
      ? overrides.network
      : process.env.STELLAR_NETWORK ?? 'testnet';

  let network: StellarNetwork = 'testnet';
  if (rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
    const safeVal = sanitizeValue(rawNetwork);
    issues.push({
      severity: 'error',
      field: 'network',
      code: 'INVALID_NETWORK',
      message: `Unsupported network: "${safeVal}". Supported networks: testnet, mainnet`,
      value: safeVal,
    });
  } else {
    network = rawNetwork;
  }

  // 2. Horizon URL Validation & Warnings
  const rawHorizonUrl: unknown =
    overrides?.horizonUrl !== undefined
      ? overrides.horizonUrl
      : process.env.STELLAR_HORIZON_URL ?? HORIZON_URLS[network];

  if (typeof rawHorizonUrl !== 'string') {
    issues.push({
      severity: 'error',
      field: 'horizonUrl',
      code: 'INVALID_HORIZON_URL',
      message: `Invalid Horizon URL: "${sanitizeEndpointValue(rawHorizonUrl)}". Must be a non-empty string.`,
      value: sanitizeEndpointValue(rawHorizonUrl),
    });
  } else {
    try {
      const parsed = new URL(rawHorizonUrl);
      if (((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || !!parsed.username || !!parsed.password || !!parsed.hash)) {
        issues.push({
          severity: 'error',
          field: 'horizonUrl',
          code: 'INVALID_HORIZON_URL',
          message: `Invalid Horizon URL: "${sanitizeEndpointValue(rawHorizonUrl)}". Protocol must be http or https.`,
          value: sanitizeEndpointValue(rawHorizonUrl),
        });
      } else {
        // Advisory Warnings for Horizon URL
        if (
          parsed.protocol === 'http:' &&
          parsed.hostname !== 'localhost' &&
          parsed.hostname !== '127.0.0.1'
        ) {
          issues.push({
            severity: 'warning',
            field: 'horizonUrl',
            code: 'INSECURE_HTTP_URL',
            message: `Horizon URL "${sanitizeEndpointValue(rawHorizonUrl)}" uses unencrypted HTTP protocol for a non-localhost host.`,
            value: sanitizeEndpointValue(rawHorizonUrl),
          });
        }
        if (
          network === 'mainnet' &&
          rawHorizonUrl.toLowerCase().includes('testnet')
        ) {
          issues.push({
            severity: 'warning',
            field: 'horizonUrl',
            code: 'NETWORK_MISMATCH',
            message: `Horizon URL "${sanitizeEndpointValue(rawHorizonUrl)}" contains "testnet" but network is configured as mainnet.`,
            value: sanitizeEndpointValue(rawHorizonUrl),
          });
        } else if (
          network === 'testnet' &&
          rawHorizonUrl.toLowerCase().includes('horizon.stellar.org') &&
          !rawHorizonUrl.toLowerCase().includes('testnet')
        ) {
          issues.push({
            severity: 'warning',
            field: 'horizonUrl',
            code: 'NETWORK_MISMATCH',
            message: `Horizon URL "${sanitizeEndpointValue(rawHorizonUrl)}" points to Stellar public mainnet endpoint but network is configured as testnet.`,
            value: sanitizeEndpointValue(rawHorizonUrl),
          });
        }
      }
    } catch {
      issues.push({
        severity: 'error',
        field: 'horizonUrl',
        code: 'INVALID_HORIZON_URL',
        message: `Invalid Horizon URL: "${sanitizeEndpointValue(rawHorizonUrl)}". Must be a valid HTTP(S) URL.`,
        value: sanitizeEndpointValue(rawHorizonUrl),
      });
    }
  }

  // 3. Soroban RPC URL Validation & Warnings
  const rawSorobanRpcUrl: unknown =
    overrides?.sorobanRpcUrl !== undefined
      ? overrides.sorobanRpcUrl
      : process.env.STELLAR_SOROBAN_RPC_URL ?? SOROBAN_RPC_URLS[network];

  if (typeof rawSorobanRpcUrl !== 'string') {
    issues.push({
      severity: 'error',
      field: 'sorobanRpcUrl',
      code: 'INVALID_SOROBAN_RPC_URL',
      message: `Invalid Soroban RPC URL: "${sanitizeEndpointValue(rawSorobanRpcUrl)}". Must be a non-empty string.`,
      value: sanitizeEndpointValue(rawSorobanRpcUrl),
    });
  } else {
    try {
      const parsed = new URL(rawSorobanRpcUrl);
      if (((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || !!parsed.username || !!parsed.password || !!parsed.hash)) {
        issues.push({
          severity: 'error',
          field: 'sorobanRpcUrl',
          code: 'INVALID_SOROBAN_RPC_URL',
          message: `Invalid Soroban RPC URL: "${sanitizeEndpointValue(rawSorobanRpcUrl)}". Protocol must be http or https.`,
          value: sanitizeEndpointValue(rawSorobanRpcUrl),
        });
      } else {
        // Advisory Warnings for Soroban RPC URL
        if (
          parsed.protocol === 'http:' &&
          parsed.hostname !== 'localhost' &&
          parsed.hostname !== '127.0.0.1'
        ) {
          issues.push({
            severity: 'warning',
            field: 'sorobanRpcUrl',
            code: 'INSECURE_HTTP_URL',
            message: `Soroban RPC URL "${sanitizeEndpointValue(rawSorobanRpcUrl)}" uses unencrypted HTTP protocol for a non-localhost host.`,
            value: sanitizeEndpointValue(rawSorobanRpcUrl),
          });
        }
        if (
          network === 'mainnet' &&
          rawSorobanRpcUrl.toLowerCase().includes('testnet')
        ) {
          issues.push({
            severity: 'warning',
            field: 'sorobanRpcUrl',
            code: 'NETWORK_MISMATCH',
            message: `Soroban RPC URL "${sanitizeEndpointValue(rawSorobanRpcUrl)}" contains "testnet" but network is configured as mainnet.`,
            value: sanitizeEndpointValue(rawSorobanRpcUrl),
          });
        } else if (
          network === 'testnet' &&
          rawSorobanRpcUrl.toLowerCase().includes('soroban.stellar.org') &&
          !rawSorobanRpcUrl.toLowerCase().includes('testnet')
        ) {
          issues.push({
            severity: 'warning',
            field: 'sorobanRpcUrl',
            code: 'NETWORK_MISMATCH',
            message: `Soroban RPC URL "${sanitizeEndpointValue(rawSorobanRpcUrl)}" points to Stellar public mainnet endpoint but network is configured as testnet.`,
            value: sanitizeEndpointValue(rawSorobanRpcUrl),
          });
        }
      }
    } catch {
      issues.push({
        severity: 'error',
        field: 'sorobanRpcUrl',
        code: 'INVALID_SOROBAN_RPC_URL',
        message: `Invalid Soroban RPC URL: "${sanitizeEndpointValue(rawSorobanRpcUrl)}". Must be a valid HTTP(S) URL.`,
        value: sanitizeEndpointValue(rawSorobanRpcUrl),
      });
    }
  }

  // 4. Timeout Validation & Warnings
  const rawTimeout: unknown =
    overrides?.timeout ??
    (process.env.STELLAR_TIMEOUT
      ? parseInt(process.env.STELLAR_TIMEOUT, 10)
      : DEFAULT_TIMEOUT_MS);

  if (typeof rawTimeout !== 'number' || Number.isNaN(rawTimeout)) {
    issues.push({
      severity: 'error',
      field: 'timeout',
      code: 'INVALID_TIMEOUT',
      message: `Invalid timeout: "${rawTimeout}". Timeout must be a number (milliseconds).`,
      value: sanitizeValue(rawTimeout),
    });
  } else if (rawTimeout <= 0) {
    issues.push({
      severity: 'error',
      field: 'timeout',
      code: 'INVALID_TIMEOUT',
      message: `Invalid timeout: ${rawTimeout}. Timeout must be greater than 0.`,
      value: rawTimeout,
    });
  } else if (!Number.isFinite(rawTimeout)) {
    issues.push({
      severity: 'error',
      field: 'timeout',
      code: 'INVALID_TIMEOUT',
      message: `Invalid timeout: ${rawTimeout}. Timeout must be a finite number.`,
      value: sanitizeValue(rawTimeout),
    });
  } else {
    if (rawTimeout < 1000) {
      issues.push({
        severity: 'warning',
        field: 'timeout',
        code: 'EXTREME_TIMEOUT',
        message: `Timeout of ${rawTimeout}ms is unusually low (< 1000ms) and may lead to frequent timeouts.`,
        value: rawTimeout,
      });
    } else if (rawTimeout > 120000) {
      issues.push({
        severity: 'warning',
        field: 'timeout',
        code: 'EXTREME_TIMEOUT',
        message: `Timeout of ${rawTimeout}ms is unusually high (> 120000ms).`,
        value: rawTimeout,
      });
    }
  }

  // 5. Contract ID Validation
  const rawContractId: unknown =
    overrides?.contractId !== undefined
      ? overrides.contractId
      : process.env.STELLAR_CONTRACT_ID;

  if (
    rawContractId !== undefined &&
    rawContractId !== null &&
    rawContractId !== ''
  ) {
    if (typeof rawContractId !== 'string') {
      issues.push({
        severity: 'error',
        field: 'contractId',
        code: 'INVALID_CONTRACT_ID',
        message: `Invalid contract ID: "${rawContractId}". Contract ID must be a non-empty string.`,
        value: sanitizeValue(rawContractId),
      });
    } else if (
      !rawContractId.startsWith('C') ||
      rawContractId.length !== 56 ||
      !/^C[A-Z2-7]{55}$/.test(rawContractId)
    ) {
      issues.push({
        severity: 'error',
        field: 'contractId',
        code: 'INVALID_CONTRACT_ID',
        message: `Invalid contract ID: "${rawContractId}". Contract ID must be a 56-character base32 string starting with 'C'.`,
        value: sanitizeValue(rawContractId),
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const valid = errors.length === 0;

  let resolvedConfig: ResolvedSDKConfig | undefined = undefined;
  if (valid) {
    resolvedConfig = resolveConfig(overrides as Partial<SDKConfig>);
  }

  return {
    valid,
    issues,
    errors,
    warnings,
    config: resolvedConfig,
  };
}
/**
 * Factory used to construct Horizon server instances. Defaults to a real
 * Horizon server. Tests can override this via {@link setHorizonServerFactory}
 * to run offline without live network calls, then restore the default with
 * {@link resetHorizonServerFactory}. Production code never needs to touch it.
 */
type HorizonServerFactory = (url: string) => StellarSDK.Horizon.Server;

const defaultHorizonServerFactory: HorizonServerFactory = (url) =>
  new StellarSDK.Horizon.Server(url);

let horizonServerFactory: HorizonServerFactory = defaultHorizonServerFactory;

/**
 * Overrides the Horizon server factory. Intended for tests, so SDK modules
 * can be exercised against a mock Horizon client instead of a live server.
 *
 * @param factory - A function that returns a Horizon.Server-like object for a URL
 */
export function setHorizonServerFactory(factory: HorizonServerFactory): void {
  horizonServerFactory = factory;
}

/**
 * Restores the default factory that builds a real Horizon server.
 * Call this in test teardown to avoid leaking a mock between test files.
 */
export function resetHorizonServerFactory(): void {
  horizonServerFactory = defaultHorizonServerFactory;
}

/**
 * Creates a configured Horizon server instance.
 *
 * By default this returns a real Horizon server. In tests, the instance is
 * produced by whatever factory was installed via {@link setHorizonServerFactory},
 * which is how SDK modules are tested offline.
 *
 * @param config - Optional SDK config (resolved automatically if omitted)
 * @returns Horizon.Server instance
 * @throws PocketPayError if configuration is invalid
 */
export function getHorizonServer(
  config?: Partial<SDKConfig>
): StellarSDK.Horizon.Server {
  const resolved = resolveConfig(config);
  return horizonServerFactory(resolved.horizonUrl);
}

/**
 * Returns the resolved Soroban RPC URL for the given (or ambient) config.
 *
 * Resolution follows the same precedence as {@link resolveConfig}:
 * explicit override > STELLAR_SOROBAN_RPC_URL env var > network default.
 *
 * @param config - Optional SDK config (resolved automatically if omitted)
 * @returns The resolved Soroban RPC URL
 * @throws PocketPayError if configuration is invalid
 */
export function getSorobanRpcUrl(config?: Partial<SDKConfig>): string {
  return resolveConfig(config).sorobanRpcUrl;
}
/**
 * Returns the network passphrase for the configured network.
 *
 * @param network - Target network (default: resolved from config)
 * @returns Network passphrase string
 * @throws PocketPayError if network is unsupported
 */
export function getNetworkPassphrase(network?: StellarNetwork): string {
  const resolvedNetwork = network ?? resolveConfig().network;
  validateNetwork(resolvedNetwork);
  return NETWORK_PASSPHRASES[resolvedNetwork];
}
/**
 * Returns the Friendbot URL for testnet funding.
 *
 * @returns Friendbot URL string
 */
export function getFriendbotUrl(): string {
  return FRIENDBOT_URL;
}
export {
  HORIZON_URLS,
  SOROBAN_RPC_URLS,
  NETWORK_PASSPHRASES,
  DEFAULT_TIMEOUT_MS,
};
