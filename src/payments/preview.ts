import * as StellarSDK from '@stellar/stellar-sdk';
import { SDKConfig, PaymentPreviewParams, PaymentPreview } from '../types';
import { resolveConfig } from '../config';
import {
  validatePublicKey,
  validateAmount,
  validateMemoInput,
  normalizeMemo,
  formatMemoForDisplay,
} from '../utils';
import { validateAssetSpec } from './trustline';

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
  const displayMemo = formatMemoForDisplay(normalizedMemo);

  const finalAsset = asset || { code: 'XLM' };
  validateAssetSpec(finalAsset);

  const cfg = resolveConfig(config);

  return {
    sourceAccount,
    destination,
    amount,
    asset: finalAsset,
    memo: displayMemo,
    memoType: normalizedMemo?.type,
    network: cfg.network,
    estimatedFee: StellarSDK.BASE_FEE.toString(), // Hardcoded to Stellar base fee (100 stroops)
  };
}
