import * as StellarSDK from '@stellar/stellar-sdk';
import { SDKConfig, PaymentPreviewParams, PaymentPreview } from '../types';
import { resolveConfig } from '../config';
import { validatePublicKey, validateAmount, validateMemoInput, normalizeMemo } from '../utils';
import { validateAssetSpec } from './trustline';
import { checkTransactionReadiness } from './readiness';
import type { TransactionReadiness } from './readiness';

/**
 * Previews a payment without signing or submitting a transaction.
 *
 * This function performs synchronous validation on the input parameters
 * (public keys, amount, memo, asset spec) and returns a typed preview
 * object suitable for UI confirmation screens.
 *
 * @param params - Preview parameters including source, destination, amount, asset, and memo
 * @param config - Optional SDK config overrides
 * @returns A promise that resolves to a {@link PaymentPreview}
 * @throws {PocketPayError} on any validation error
 */
export async function previewPayment(
  params: PaymentPreviewParams,
  config?: Partial<SDKConfig>
): Promise<PaymentPreview> {
  const { sourceAccount, destination, amount, memo, asset } = params;

  // Validate inputs synchronously
  validatePublicKey(sourceAccount);
  validatePublicKey(destination);
  validateAmount(amount);
  validateMemoInput(memo);
  const normalizedMemo = normalizeMemo(memo);

  const finalAsset = asset || { code: 'XLM' };
  validateAssetSpec(finalAsset);

  const cfg = resolveConfig(config);

  return {
    sourceAccount,
    destination,
    amount,
    asset: finalAsset,
    memo: normalizedMemo ? String(normalizedMemo.value ?? '') : undefined,
    memoType: normalizedMemo?.type,
    network: cfg.network,
    estimatedFee: StellarSDK.BASE_FEE.toString(), // Hardcoded to Stellar base fee (100 stroops)
  };
}


/**
 * Preview plus the network-backed readiness snapshot for the same payment.
 *
 * This is the confirmation-screen seam for callers that want both display
 * details and typed blockers/warnings before they ask for a signature. It does
 * not build, sign, or submit a transaction.
 */
export interface PaymentReadinessPreview {
  preview: PaymentPreview;
  readiness: TransactionReadiness;
}

/**
 * Builds the normal payment preview and runs the shared transaction-readiness
 * validator for the exact same payment.
 *
 * Unlike wrapping a send helper, this performs only the readiness Horizon
 * lookups; it does not duplicate a source-account lookup for a later submit.
 * Callers may render this result, obtain approval, and then call the existing
 * send helper separately.
 */
export async function previewPaymentWithReadiness(
  params: PaymentPreviewParams,
  config?: Partial<SDKConfig>,
): Promise<PaymentReadinessPreview> {
  const preview = await previewPayment(params, config);
  const readiness = await checkTransactionReadiness(
    {
      sourceAccount: preview.sourceAccount,
      destination: preview.destination,
      amount: preview.amount,
      asset: preview.asset,
      memo: params.memo,
      fee: preview.estimatedFee,
    },
    config,
  );

  return { preview, readiness };
}
