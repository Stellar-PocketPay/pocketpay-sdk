/**
 * Stellar PocketPay SDK — Vault action intents and capability gating.
 *
 * The vault module was a barrel: 31 lines of re-exports from `../soroban`, with
 * no logic of its own. Its real surface is `depositToVault`,
 * `withdrawFromVault` and `getVaultBalance`; lock creation, lock listing and
 * matured-lock withdrawal had no representation anywhere in the SDK, so a
 * consumer had no way to ask whether they existed short of reading the source.
 *
 * @remarks
 * The gating this module needs was already published and simply never called
 * from here. `SDK_CAPABILITIES['vault.contract']` (`src/errors/capabilities.ts`)
 * declares the contract requirement with its `requires` string, and
 * `assertCapability` already routes a `planned` or `unsupported` capability to
 * `UnsupportedFeatureError` and everything else to `CapabilityMismatchError`.
 * Grepping `src/vault/` for `capabilit` or `unsupported` used to return nothing.
 *
 * @security Intents carry `sourceSecret`. Nothing in this module echoes an
 * intent into an error message or a result — `DIAGNOSTICS_SENSITIVE_KEYS`
 * lists `sourceSecret` among the keys that must never surface.
 */

import { assertFeatureEnabled } from '../config';
import { ErrorCode, assertCapability } from '../errors';
import {
  depositToVault,
  getVaultBalance,
  withdrawFromVault,
} from '../soroban';
import type { SDKConfig, VaultMappedResult } from '../types';
import { validatePublicKey, validateSecretKey, validateAmount } from '../utils';

/** Capability key gating the contract requirement. Unchanged, already published. */
const VAULT_CONTRACT_CAPABILITY = 'vault.contract';

/** Capability key covering time-locked positions. Registered as `planned`. */
const VAULT_LOCK_CAPABILITY = 'vault.lock';

/**
 * Feature flag guarding lock intents.
 *
 * Deliberately not added to `DEFAULT_FEATURE_FLAGS`: unknown flags already
 * resolve to `false` (`isFeatureEnabled` reads the resolved map and coerces a
 * missing key), so the safe default holds without editing the config module,
 * which belongs to a separate issue. It can still be enabled explicitly or via
 * `POCKETPAY_FEATURE_FLAGS`.
 */
export const VAULT_LOCKS_FEATURE_FLAG = 'experimentalVaultLocks';

/** Every vault action the SDK models, implemented or not. */
export type VaultActionKind =
  | 'deposit'
  | 'withdraw'
  | 'getBalance'
  | 'createLock'
  | 'listLocks'
  | 'withdrawMaturedLock';

/**
 * A typed request to perform a vault action.
 *
 * Discriminated by `kind` so that an intent for an action the SDK cannot
 * perform is still a well-formed, inspectable value — which is the point: a
 * downstream app can build and inspect a `createLock` intent, and find out it
 * is unsupported through a typed error rather than through a missing function.
 */
export type VaultActionIntent =
  | { kind: 'deposit'; sourceSecret: string; amount: string; contractId?: string }
  | { kind: 'withdraw'; sourceSecret: string; amount: string; contractId?: string }
  | { kind: 'getBalance'; publicKey: string; contractId?: string }
  | {
      kind: 'createLock';
      sourceSecret: string;
      amount: string;
      contractId?: string;
      /** Unix seconds at which the position becomes withdrawable. */
      unlockAt: number;
    }
  | { kind: 'listLocks'; publicKey: string; contractId?: string }
  | { kind: 'withdrawMaturedLock'; sourceSecret: string; contractId?: string; lockId: string };

/** What a consumer can learn about one action without attempting it. */
export interface VaultActionReadiness {
  /** The action described. */
  kind: VaultActionKind;
  /** Whether the SDK can perform it today. */
  supported: boolean;
  /** Capability key this action depends on. */
  capability: string;
  /** Feature flag that must be enabled before the attempt, when one applies. */
  featureFlag?: string;
  /** Factual description. No delivery promises. */
  description: string;
}

/** Actions backed by a real contract entry point. */
const IMPLEMENTED_ACTIONS: readonly VaultActionKind[] = ['deposit', 'withdraw', 'getBalance'];

/**
 * Readiness of every modelled vault action.
 *
 * The three lock actions are `supported: false` because the deployed
 * savings-vault contract exposes `deposit`, `withdraw` and `get_balance` only.
 * Enabling {@link VAULT_LOCKS_FEATURE_FLAG} does not make them work; it only
 * changes which typed error you get, which is deliberate — a disabled flag and
 * a missing contract entry point are different problems with different fixes.
 */
export const VAULT_ACTION_READINESS: Record<VaultActionKind, VaultActionReadiness> = {
  deposit: {
    kind: 'deposit',
    supported: true,
    capability: VAULT_CONTRACT_CAPABILITY,
    description: 'Deposit XLM into the savings vault.',
  },
  withdraw: {
    kind: 'withdraw',
    supported: true,
    capability: VAULT_CONTRACT_CAPABILITY,
    description: 'Withdraw XLM from the savings vault.',
  },
  getBalance: {
    kind: 'getBalance',
    supported: true,
    capability: VAULT_CONTRACT_CAPABILITY,
    description: 'Read a public key’s vault balance.',
  },
  createLock: {
    kind: 'createLock',
    supported: false,
    capability: VAULT_LOCK_CAPABILITY,
    featureFlag: VAULT_LOCKS_FEATURE_FLAG,
    description: 'Create a time-locked vault position. No contract entry point exists.',
  },
  listLocks: {
    kind: 'listLocks',
    supported: false,
    capability: VAULT_LOCK_CAPABILITY,
    featureFlag: VAULT_LOCKS_FEATURE_FLAG,
    description: 'List a public key’s locked positions. No contract entry point exists.',
  },
  withdrawMaturedLock: {
    kind: 'withdrawMaturedLock',
    supported: false,
    capability: VAULT_LOCK_CAPABILITY,
    featureFlag: VAULT_LOCKS_FEATURE_FLAG,
    description: 'Withdraw a matured locked position. No contract entry point exists.',
  },
};

/**
 * Reports what the vault can and cannot do, without attempting anything.
 *
 * Intended for UI that decides whether to render a control at all, rather than
 * rendering it and surfacing an error after the user taps it.
 *
 * @returns Readiness for every modelled action.
 */
export function describeVaultReadiness(): VaultActionReadiness[] {
  return Object.values(VAULT_ACTION_READINESS);
}

/**
 * Whether the SDK can perform an action today.
 *
 * @param kind - The vault action.
 */
export function isVaultActionSupported(kind: VaultActionKind): boolean {
  return VAULT_ACTION_READINESS[kind].supported;
}

/**
 * Validates an intent's inputs locally — no network call, no submission.
 *
 * Delegates to the SDK's existing validators rather than adding a parallel set;
 * the reusable validation pipeline is the subject of a separate issue and this
 * is the boundary that will consume it.
 *
 * @param intent - The intent to validate.
 * @throws PocketPayError when a key, amount or identifier is malformed.
 */
export function validateVaultIntent(intent: VaultActionIntent): void {
  switch (intent.kind) {
    case 'deposit':
    case 'withdraw':
      validateSecretKey(intent.sourceSecret);
      validateAmount(intent.amount);
      return;
    case 'getBalance':
    case 'listLocks':
      validatePublicKey(intent.publicKey);
      return;
    case 'createLock':
      validateSecretKey(intent.sourceSecret);
      validateAmount(intent.amount);
      return;
    case 'withdrawMaturedLock':
      validateSecretKey(intent.sourceSecret);
      return;
    default: {
      // Adding a kind without handling it here is a compile error. The intent
      // is never interpolated — it carries `sourceSecret`.
      const exhaustive: never = intent;
      void exhaustive;
      return;
    }
  }
}

/**
 * Executes a vault intent, or explains in a typed error why it cannot.
 *
 * Gates run in order of how actionable the failure is:
 *
 * 1. **Contract configured?** No ID in intent, config or environment raises
 *    `CapabilityMismatchError` on `vault.contract` — fixable by configuration.
 * 2. **Feature flag enabled?** A lock intent with the flag off raises
 *    `DisabledFeatureError` — fixable by the caller.
 * 3. **Action supported?** A lock intent with the flag on raises
 *    `UnsupportedFeatureError` on `vault.lock`, whose registry status is
 *    `planned`. Nothing the caller does fixes this one, and saying so plainly
 *    is the point of the issue.
 *
 * @param intent - The action to perform.
 * @param config - Optional SDK config overrides.
 * @returns The mapped vault result for supported actions.
 */
export async function executeVaultIntent(
  intent: VaultActionIntent,
  config?: Partial<SDKConfig>,
): Promise<VaultMappedResult> {
  validateVaultIntent(intent);

  const readiness = VAULT_ACTION_READINESS[intent.kind];
  const context = { module: 'vault', operation: intent.kind } as const;

  // 1 — resolve the same contract-ID sources and precedence as Soroban's
  // resolveContractId: explicit intent > config > VAULT_CONTRACT_ID >
  // STELLAR_CONTRACT_ID. A configured vault must not fail this preflight merely
  // because the individual intent omitted the ID.
  const contractId =
    intent.contractId ||
    config?.contractId ||
    process.env.VAULT_CONTRACT_ID ||
    process.env.STELLAR_CONTRACT_ID ||
    '';
  assertCapability(VAULT_CONTRACT_CAPABILITY, Boolean(contractId), context, {
    code: ErrorCode.VAULT_CONTRACT_NOT_CONFIGURED,
  });

  // 2 — experimental gate, when the action declares one.
  if (readiness.featureFlag) {
    assertFeatureEnabled(readiness.featureFlag, { ...context, capability: readiness.capability }, config);
  }

  // 3 — support. `assertCapability` reads the registry: `planned` becomes an
  // UnsupportedFeatureError, so this branch carries no decision of its own.
  assertCapability(readiness.capability, readiness.supported, context);

  switch (intent.kind) {
    case 'deposit':
      return depositToVault(
        { sourceSecret: intent.sourceSecret, amount: intent.amount, contractId },
        config,
      );
    case 'withdraw':
      return withdrawFromVault(
        { sourceSecret: intent.sourceSecret, amount: intent.amount, contractId },
        config,
      );
    case 'getBalance':
      return getVaultBalance({ publicKey: intent.publicKey, contractId }, config);
    default:
      // Unreachable at runtime: gate 3 rejects every kind whose readiness is
      // `supported: false`, which is exactly the set left here. TypeScript
      // cannot see that, so this stays a plain throw rather than a `never`
      // assertion. The kind is not interpolated — the intent holds a secret.
      throw new Error('Unhandled vault intent kind');
  }
}

/** Actions the SDK can perform today, for callers that want the short list. */
export function listSupportedVaultActions(): readonly VaultActionKind[] {
  return IMPLEMENTED_ACTIONS;
}
