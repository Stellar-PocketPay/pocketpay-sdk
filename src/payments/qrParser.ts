// src/payments/qrParser.ts
import { validatePublicKey, validateAmount, validateMemoInput } from '../utils';
import { PaymentErrorCode, PaymentParseError } from '../errors/payment-errors';
import { validateAssetSpec } from './trustline';
import type { StellarAssetSpec } from '../types';

/**
 * Supported QR payload format (URL query string):
 *   pocketpay://pay?address=G...&amount=10.5&asset=USD:ISSUER&memo=hello&metadata=key1%3Avalue1%2Ckey2%3Avalue2
 *
 * - `address` (required): destination public key (Stellar G... address)
 * - `amount` (required): decimal string, positive, up to 7 decimal places
 * - `asset` (optional): "CODE:ISSUER" or "XLM"/"native"
 * - `memo` (optional): free‑form memo, max 28 bytes when encoded as UTF‑8
 * - `metadata` (optional): URL‑encoded comma‑separated key:value pairs, each value string
 */
export interface QRPayload {
  address: string;
  amount: string;
  asset?: StellarAssetSpec;
  memo?: string;
  metadata?: Record<string, string>;
}

/**
 * Parse a QR payload string into structured data, performing validation.
 *
 * @throws {PaymentParseError} on the first field that fails validation; the
 *   error's `code` names the offending field (`INVALID_ADDRESS`,
 *   `INVALID_AMOUNT`, `INVALID_ASSET`, `INVALID_MEMO`, `INVALID_METADATA`).
 */
export function parseQRPayload(input: string): QRPayload {
  // Strip any scheme prefix (e.g. "pocketpay://pay?") and keep query part
  const queryStart = input.indexOf('?');
  const queryString = queryStart >= 0 ? input.slice(queryStart + 1) : input;
  const params = new URLSearchParams(queryString);

  const address = params.get('address');
  const amount = params.get('amount');
  const assetRaw = params.get('asset');
  const memo = params.get('memo') ?? undefined;
  const metadataRaw = params.get('metadata');

  // address validation
  if (!address) {
    throw new PaymentParseError('Destination address is required', PaymentErrorCode.InvalidAddress);
  }
  check(PaymentErrorCode.InvalidAddress, () => validatePublicKey(address));

  // amount validation
  if (!amount) {
    throw new PaymentParseError('Amount is required', PaymentErrorCode.InvalidAmount);
  }
  check(PaymentErrorCode.InvalidAmount, () => validateAmount(amount));

  // asset parsing & validation (optional)
  let asset: StellarAssetSpec | undefined;
  if (assetRaw) {
    const [code = '', issuer, ...rest] = assetRaw.split(':');
    if (rest.length > 0) {
      throw new PaymentParseError(
        'Asset must be "CODE" or "CODE:ISSUER"',
        PaymentErrorCode.InvalidAsset,
      );
    }
    const spec: StellarAssetSpec = issuer === undefined ? { code } : { code, issuer };
    check(PaymentErrorCode.InvalidAsset, () => validateAssetSpec(spec));
    asset = spec;
  }

  // memo validation (optional)
  if (memo !== undefined) {
    check(PaymentErrorCode.InvalidMemo, () => validateMemoInput(memo));
  }

  // metadata parsing (optional). format: "key1:value1,key2:value2"
  let metadata: Record<string, string> | undefined;
  if (metadataRaw) {
    // Untrusted QR keys must be stored as own data properties. A plain object
    // can lose "__proto__" or shadow inherited members such as "toString".
    const parsed: Record<string, string> = Object.create(null);
    check(PaymentErrorCode.InvalidMetadata, () => {
      for (const pair of metadataRaw.split(',')) {
        const separator = pair.indexOf(':');
        if (separator <= 0 || separator === pair.length - 1) {
          throw new Error('Invalid metadata pair');
        }
        const k = pair.slice(0, separator);
        const v = pair.slice(separator + 1);
        parsed[k] = v;
      }
    });
    metadata = parsed;
  }

  return {
    address,
    amount,
    ...(asset !== undefined && { asset }),
    ...(memo !== undefined && { memo }),
    ...(metadata !== undefined && { metadata }),
  };
}

/** Runs a throwing validator and re-throws any failure as a {@link PaymentParseError}. */
function check(code: PaymentErrorCode, validate: () => unknown): void {
  try {
    validate();
  } catch (e) {
    throw new PaymentParseError(e instanceof Error ? e.message : String(e), code);
  }
}
