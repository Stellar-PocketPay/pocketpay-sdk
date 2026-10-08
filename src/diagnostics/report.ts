/**
 * Build a redacted diagnostics report for support workflows.
 */

import { resolveConfig, getNetworkPassphrase, getFriendbotUrl } from '../config';
import { SDK_CAPABILITIES, getCapability } from '../errors';
import type { SDKConfig, ResolvedSDKConfig } from '../types';
import { isDiagnosticsEnabled } from './hooks';
import {
  DIAGNOSTICS_REDACTED_PLACEHOLDER,
  redactDiagnosticsValue,
} from './redact';
import type {
  CapabilityDiagnosticsEntry,
  DiagnosticsReport,
  SafeConfigSnapshot,
  SafeNetworkSnapshot,
  VaultReadinessSnapshot,
  WalletCapabilitySnapshot,
} from './types';

// Keep version aligned with package.json without creating a runtime dependency
// on package resolution in every environment.
const SDK_NAME = 'stellar-pocketpay-sdk';
const SDK_VERSION = '1.0.0';

/** Return only the endpoint origin in shareable diagnostics. */
function toSafeEndpointOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.origin === 'null'
      ? DIAGNOSTICS_REDACTED_PLACEHOLDER
      : parsed.origin;
  } catch {
    return DIAGNOSTICS_REDACTED_PLACEHOLDER;
  }
}

function toSafeConfig(config: ResolvedSDKConfig): SafeConfigSnapshot {
  const configured =
    typeof config.contractId === 'string' && config.contractId.length > 0;
  return {
    network: config.network,
    horizonUrl: toSafeEndpointOrigin(config.horizonUrl),
    sorobanRpcUrl: toSafeEndpointOrigin(config.sorobanRpcUrl),
    timeoutMs: config.timeout ?? 30_000,
    contractIdConfigured: configured,
    ...(configured ? { contractId: config.contractId } : {}),
    sources: config.sources,
    featureFlags: config.featureFlags,
  };
}

function toSafeNetwork(config: SDKConfig): SafeNetworkSnapshot {
  let passphraseKnown = false;
  try {
    passphraseKnown = getNetworkPassphrase(config.network).length > 0;
  } catch {
    passphraseKnown = false;
  }

  return {
    network: config.network,
    horizonUrl: toSafeEndpointOrigin(config.horizonUrl),
    sorobanRpcUrl: toSafeEndpointOrigin(config.sorobanRpcUrl),
    passphraseKnown,
    friendbotAvailable: config.network === 'testnet' && Boolean(getFriendbotUrl()),
  };
}

function capabilityEntries(): CapabilityDiagnosticsEntry[] {
  return Object.entries(SDK_CAPABILITIES).map(([name, spec]) => ({
    name,
    status: spec.status,
    module: spec.module,
    requires: spec.requires,
    description: spec.description,
  }));
}

function walletSnapshot(): WalletCapabilitySnapshot {
  return {
    canCreate: true,
    canImport: true,
    canQueryBalance: true,
    canFundTestnet: true,
  };
}

function vaultSnapshot(config: SDKConfig): VaultReadinessSnapshot {
  const spec = getCapability('vault.contract');
  const contractIdConfigured =
    typeof config.contractId === 'string' && config.contractId.length > 0;
  const envConfigured = Boolean(
    process.env.VAULT_CONTRACT_ID || process.env.STELLAR_CONTRACT_ID,
  );
  const configured = contractIdConfigured || envConfigured;

  if (!spec) {
    return {
      capabilityStatus: 'unsupported',
      contractIdConfigured: configured,
      ready: false,
      reason: 'vault.contract capability is not classified in the registry',
    };
  }

  if (spec.status === 'config-gated' && !configured) {
    return {
      capabilityStatus: spec.status,
      contractIdConfigured: false,
      ready: false,
      reason:
        'Vault contract id is not configured (SDKConfig.contractId or VAULT_CONTRACT_ID)',
    };
  }

  if (spec.status === 'supported' || (spec.status === 'config-gated' && configured)) {
    return {
      capabilityStatus: spec.status,
      contractIdConfigured: configured,
      ready: true,
    };
  }

  return {
    capabilityStatus: spec.status,
    contractIdConfigured: configured,
    ready: false,
    reason: `Vault capability status is '${spec.status}'`,
  };
}

/**
 * Produce a support-safe diagnostics report.
 *
 * @param overrides - Optional config overrides (same semantics as {@link resolveConfig})
 * @returns A deep-redacted {@link DiagnosticsReport}
 */
export function buildDiagnosticsReport(
  overrides?: Partial<SDKConfig>,
): DiagnosticsReport {
  const config = resolveConfig(overrides);
  const report: DiagnosticsReport = {
    generatedAt: new Date().toISOString(),
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
    diagnosticsEnabled: isDiagnosticsEnabled(),
    config: toSafeConfig(config),
    network: toSafeNetwork(config),
    capabilities: capabilityEntries(),
    wallet: walletSnapshot(),
    vault: vaultSnapshot(config),
  };

  return redactDiagnosticsValue(report);
}
