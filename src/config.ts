export * from './config/index';

import {
  NETWORK_PRESETS,
  assertFeatureEnabled as assertFeatureEnabledBase,
  getHorizonServer as getHorizonServerBase,
  getNetworkPassphrase as getNetworkPassphraseBase,
  resolveConfig as resolveConfigBase,
  validateNetwork,
  validateNetworkPassphrase,
  validatePocketPayConfig as validatePocketPayConfigBase,
} from './config/index';
import type { FeatureContext } from './errors';
import {
  ConfigValidationIssue,
  ConfigValidationResult,
  PocketPayError,
  ResolvedSDKConfig,
  SDKConfig,
  StellarNetwork,
} from './types';

function isSupportedHttpProtocol(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertHttpUrl(
  value: unknown,
  fieldName: string,
  errorCode: string,
  field: string
): asserts value is string {
  if (typeof value !== 'string' || !isSupportedHttpProtocol(value)) {
    throw new PocketPayError(
      `Invalid ${fieldName}. Must be a valid HTTP(S) URL.`,
      errorCode,
      {
        validation: {
          field,
          reason: 'invalid_url',
          value: '[REDACTED]',
        },
      }
    );
  }
}

/** Validate an exact HTTP(S) Horizon endpoint. */
export function validateHorizonUrl(url: string): void {
  assertHttpUrl(url, 'Horizon URL', 'INVALID_HORIZON_URL', 'horizonUrl');
}

/** Validate an exact HTTP(S) Soroban RPC endpoint. */
export function validateSorobanRpcUrl(url: string): void {
  assertHttpUrl(
    url,
    'Soroban RPC URL',
    'INVALID_SOROBAN_RPC_URL',
    'sorobanRpcUrl'
  );
}

/**
 * Resolve configuration while preserving the existing explicit-value contract:
 * only `undefined` falls through to a preset; explicit null/invalid values fail.
 */
export function resolveConfig(
  overrides?: Partial<SDKConfig>
): ResolvedSDKConfig {
  const rawNetwork: unknown =
    overrides?.network !== undefined
      ? overrides.network
      : process.env.STELLAR_NETWORK ?? 'testnet';
  validateNetwork(rawNetwork);
  const network: StellarNetwork = rawNetwork;

  if (overrides?.networkPassphrase !== undefined) {
    validateNetworkPassphrase(network, overrides.networkPassphrase);
  }

  const horizonUrl: unknown =
    overrides?.horizonUrl !== undefined
      ? overrides.horizonUrl
      : process.env.STELLAR_HORIZON_URL ??
        NETWORK_PRESETS[network].horizonUrl;
  assertHttpUrl(
    horizonUrl,
    'Horizon URL',
    'INVALID_HORIZON_URL',
    'horizonUrl'
  );

  const sorobanRpcUrl: unknown =
    overrides?.sorobanRpcUrl !== undefined
      ? overrides.sorobanRpcUrl
      : process.env.STELLAR_SOROBAN_RPC_URL ??
        NETWORK_PRESETS[network].sorobanRpcUrl;
  assertHttpUrl(
    sorobanRpcUrl,
    'Soroban RPC URL',
    'INVALID_SOROBAN_RPC_URL',
    'sorobanRpcUrl'
  );

  return resolveConfigBase(overrides);
}

/** Resolve a Soroban RPC URL through the strict public configuration boundary. */
export function getSorobanRpcUrl(config?: Partial<SDKConfig>): string {
  return resolveConfig(config).sorobanRpcUrl;
}

/** Build a Horizon client only after strict configuration validation. */
export function getHorizonServer(config?: Partial<SDKConfig>) {
  const resolved = resolveConfig(config);
  return getHorizonServerBase(resolved);
}

/** Resolve a network passphrase through the strict network boundary. */
export function getNetworkPassphrase(network?: StellarNetwork): string {
  return getNetworkPassphraseBase(network);
}

/** Check a feature flag only after the supplied configuration is valid. */
export function isFeatureEnabled(
  flag: string,
  config?: Partial<SDKConfig>
): boolean {
  return Boolean(resolveConfig(config).featureFlags[flag]);
}

/** Assert a feature flag after applying the strict configuration boundary. */
export function assertFeatureEnabled(
  flag: string,
  context: FeatureContext,
  config?: Partial<SDKConfig>
): void {
  const resolved = resolveConfig(config);
  assertFeatureEnabledBase(flag, context, resolved);
}

function strictUrlIssue(
  currentIssues: ConfigValidationIssue[],
  field: 'horizonUrl' | 'sorobanRpcUrl',
  code: 'INVALID_HORIZON_URL' | 'INVALID_SOROBAN_RPC_URL',
  label: 'Horizon URL' | 'Soroban RPC URL',
  value: unknown
): ConfigValidationIssue | undefined {
  if (
    typeof value !== 'string' ||
    isSupportedHttpProtocol(value) ||
    currentIssues.some((issue) => issue.field === field && issue.code === code)
  ) {
    return undefined;
  }

  return {
    severity: 'error',
    field,
    code,
    message: `Invalid ${label}. Protocol must be http or https.`,
  };
}

/**
 * Non-throwing validation with the same exact HTTP(S) boundary as
 * {@link resolveConfig}.
 */
export function validatePocketPayConfig(
  overrides?: Partial<SDKConfig> | Record<string, unknown>
): ConfigValidationResult {
  const result = validatePocketPayConfigBase(overrides);
  const rawNetwork: unknown =
    overrides?.network !== undefined
      ? overrides.network
      : process.env.STELLAR_NETWORK ?? 'testnet';
  const network: StellarNetwork =
    rawNetwork === 'mainnet' ? 'mainnet' : 'testnet';

  const rawHorizonUrl: unknown =
    overrides?.horizonUrl !== undefined
      ? overrides.horizonUrl
      : process.env.STELLAR_HORIZON_URL ??
        NETWORK_PRESETS[network].horizonUrl;
  const rawSorobanRpcUrl: unknown =
    overrides?.sorobanRpcUrl !== undefined
      ? overrides.sorobanRpcUrl
      : process.env.STELLAR_SOROBAN_RPC_URL ??
        NETWORK_PRESETS[network].sorobanRpcUrl;

  const additions = [
    strictUrlIssue(
      result.issues,
      'horizonUrl',
      'INVALID_HORIZON_URL',
      'Horizon URL',
      rawHorizonUrl
    ),
    strictUrlIssue(
      result.issues,
      'sorobanRpcUrl',
      'INVALID_SOROBAN_RPC_URL',
      'Soroban RPC URL',
      rawSorobanRpcUrl
    ),
  ].filter((issue): issue is ConfigValidationIssue => issue !== undefined);

  if (additions.length === 0) return result;

  const issues = [...result.issues, ...additions];
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
    config: errors.length === 0 ? result.config : undefined,
  };
}
