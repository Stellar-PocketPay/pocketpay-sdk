/**
 * Stellar PocketPay SDK — Multi-Asset Payment Intent Model
 *
 * Implements preflight validation, asset metadata enrichment, trustline checks,
 * and lifecycle tracking for multi-asset payment intents.
 */

import {
  Asset,
  AssetMetadata,
  AssetState,
  CreatePaymentIntentParams,
  IssuedAsset,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentIntentValidationIssue,
  PaymentIntentValidationResult,
  TrustlineValidationResult,
  TrustlineValidationStrategy,
  isIssuedAsset,
  isNativeAsset,
  validateAsset,
} from '../types';
import { PocketPayError } from '../types';
import { validateAmount, validateMemoInput, validatePublicKey } from '../utils';
import { checkDestinationTrustline } from './trustline';
import { normalizeRecipient, validateRecipient, type RecipientInput } from './recipient';

/**
 * Evaluates the asset state classification for a given Asset.
 */
export function evaluateAssetState(asset: Asset, metadata?: AssetMetadata): AssetState {
  const assetValidation = validateAsset(asset);
  if (!assetValidation.valid) {
    return 'unsupported';
  }

  if (isNativeAsset(asset)) {
    return 'supported';
  }

  if (isIssuedAsset(asset)) {
    // If metadata indicates restricted domain or explicitly unsupported state
    if (metadata?.description?.includes('RESTRICTED') || metadata?.description?.includes('UNSUPPORTED')) {
      return 'restricted';
    }
    return 'supported';
  }

  return 'unsupported';
}

/**
 * Generates a unique PaymentIntent ID.
 */
function generatePaymentIntentId(): string {
  const hex = Math.random().toString(36).substring(2, 10);
  return `pi_${Date.now()}_${hex}`;
}

/**
 * Creates a new PaymentIntent object from input parameters.
 * Does not perform network checks or submission.
 */
export function createPaymentIntent(params: CreatePaymentIntentParams): PaymentIntent {
  if (!params || typeof params !== 'object') {
    throw new PocketPayError('Invalid CreatePaymentIntentParams object', 'INVALID_PAYMENT_INTENT', {
      validation: { field: 'params', reason: 'invalid_object' },
    });
  }

  const asset = params.asset;
  const assetMetadata = params.assetMetadata;
  const trustlineStrategy: TrustlineValidationStrategy = params.trustlineStrategy ?? 'auto_check';
  const assetState = evaluateAssetState(asset, assetMetadata);

  const intent: PaymentIntent = {
    id: generatePaymentIntentId(),
    source: params.source ? params.source.trim() : '',
    destination: params.destination ? params.destination.trim() : '',
    amount: params.amount ? params.amount.trim() : '',
    asset,
    assetMetadata,
    memo: params.memo ? params.memo.trim() : undefined,
    status: assetState === 'unsupported' ? 'unsupported_asset' : 'created',
    assetState,
    trustlineStrategy,
    createdAt: new Date().toISOString(),
    metadata: params.metadata,
  };

  // Perform immediate synchronous preflight validation
  intent.validationResult = validatePaymentIntent(intent);
  intent.status = intent.validationResult.status;

  return intent;
}

export type CreateRecipientPaymentIntentParams =
  Omit<CreatePaymentIntentParams, 'destination'> & {
    recipient: RecipientInput;
  };

/**
 * Creates a PaymentIntent from a typed recipient descriptor.
 *
 * Existing createPaymentIntent callers can continue passing a destination
 * string directly. This helper adds saved-contact and destination-metadata
 * inputs while ensuring the stored intent destination is always a canonical
 * Stellar public key.
 */
export function createPaymentIntentForRecipient(
  params: CreateRecipientPaymentIntentParams,
): PaymentIntent {
  if (!params || typeof params !== 'object') {
    throw new PocketPayError('Invalid recipient payment intent params', 'INVALID_PAYMENT_INTENT', {
      validation: { field: 'params', reason: 'invalid_object' },
    });
  }

  const normalized = normalizeRecipient(params.recipient);
  const { recipient: _recipient, metadata, memo, ...rest } = params;

  const recipientMetadata = {
    source: normalized.source,
    ...(normalized.contactId ? { contactId: normalized.contactId } : {}),
    ...(normalized.label ? { label: normalized.label } : {}),
    ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
  };

  return createPaymentIntent({
    ...rest,
    destination: normalized.publicKey,
    memo: memo ?? normalized.memo,
    metadata: {
      ...metadata,
      recipient: recipientMetadata,
    },
  });
}

/**
 * Performs preflight validation of a PaymentIntent.
 */
export function validatePaymentIntent(intent: PaymentIntent): PaymentIntentValidationResult {
  const issues: PaymentIntentValidationIssue[] = [];

  if (!intent || typeof intent !== 'object') {
    return {
      valid: false,
      status: 'invalid',
      assetState: 'unsupported',
      issues: [
        {
          field: 'intent',
          code: 'INVALID_INTENT',
          reason: 'invalid_object',
          message: 'Payment intent must be an object',
        },
      ],
    };
  }

  // 1. Source address check (Public key starting with G or valid secret key starting with S)
  if (!intent.source) {
    issues.push({
      field: 'source',
      code: 'INVALID_SOURCE',
      reason: 'missing',
      message: 'Source address or secret is required',
    });
  } else {
    try {
      validatePublicKey(intent.source);
    } catch {
      // Allow S-keys as source in params
      if (!intent.source.startsWith('S') || intent.source.length !== 56) {
        issues.push({
          field: 'source',
          code: 'INVALID_SOURCE',
          reason: 'invalid_format',
          message: 'Source must be a valid Stellar public key (G...) or secret key (S...)',
        });
      }
    }
  }

  // 2. Destination recipient check. Reuse recipient normalization so payment
  // intents and recipient helpers share one Stellar address-validation path.
  const recipientValidation = validateRecipient(intent.destination);
  if (!recipientValidation.valid) {
    issues.push({
      field: 'destination',
      code: recipientValidation.code,
      reason: recipientValidation.status,
      message: recipientValidation.message,
    });
  }

  // 3. Amount check
  if (!intent.amount) {
    issues.push({
      field: 'amount',
      code: 'INVALID_AMOUNT',
      reason: 'missing',
      message: 'Amount is required',
    });
  } else {
    try {
      validateAmount(intent.amount);
    } catch (err) {
      issues.push({
        field: 'amount',
        code: 'INVALID_AMOUNT',
        reason: 'invalid_format',
        message: err instanceof Error ? err.message : 'Invalid amount',
      });
    }
  }

  // 4. Asset check
  const assetValidation = validateAsset(intent.asset);
  if (!assetValidation.valid) {
    issues.push({
      field: 'asset',
      code: 'TX_INVALID_ASSET',
      reason: 'invalid_asset_structure',
      message: assetValidation.error || 'Invalid asset specification',
    });
  }

  // 5. Memo check
  if (intent.memo) {
    try {
      validateMemoInput(intent.memo);
    } catch (err) {
      issues.push({
        field: 'memo',
        code: 'INVALID_MEMO',
        reason: 'invalid_format',
        message: err instanceof Error ? err.message : 'Invalid memo',
      });
    }
  }

  const assetState = evaluateAssetState(intent.asset, intent.assetMetadata);
  const isValid = issues.length === 0 && assetState !== 'unsupported';
  let status: PaymentIntentStatus = isValid ? 'valid' : 'invalid';

  if (assetState === 'unsupported') {
    status = 'unsupported_asset';
  }

  return {
    valid: isValid,
    status,
    assetState,
    issues,
  };
}

/**
 * Validates destination trustline for an issued asset payment intent using Horizon.
 */
export async function checkPaymentIntentTrustline(
  intent: PaymentIntent,
  config?: any,
): Promise<TrustlineValidationResult> {
  if (isNativeAsset(intent.asset)) {
    return {
      hasTrustline: true,
      asset: intent.asset as any,
      destination: intent.destination,
      error: undefined,
    };
  }

  if (!isIssuedAsset(intent.asset)) {
    return {
      hasTrustline: false,
      asset: intent.asset as any,
      destination: intent.destination,
      error: 'Asset is not an issued asset',
    };
  }

  try {
    const result = await checkDestinationTrustline(intent.destination, {
      code: intent.asset.code,
      issuer: intent.asset.issuer,
    }, {
      amount: intent.amount,
      config,
    });

    return {
      hasTrustline: result.valid,
      asset: intent.asset,
      destination: intent.destination,
      requiredLimit: intent.amount,
      error: result.valid ? undefined : result.message,
    };
  } catch (err) {
    return {
      hasTrustline: false,
      asset: intent.asset,
      destination: intent.destination,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
