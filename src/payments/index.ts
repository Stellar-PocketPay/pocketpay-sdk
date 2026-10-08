/**
 * Stellar PocketPay SDK — Payments Module
 *
 * Send XLM payments on the Stellar network.
 */
import * as StellarSDK from '@stellar/stellar-sdk';
import { getHorizonServer, getNetworkPassphrase, resolveConfig } from '../config';
import { SendXLMParams, SendAssetParams, PaymentResult, PocketPayError, SDKConfig, PocketPayResult, EnhancedPocketPayResult } from '../types';
import { buildMemo, wrapError, toResult, toEnhancedSuccessResult, toEnhancedFailureResult, toEnhancedResult } from '../utils';
import type { ResultWarning, RecoveryHint } from '../errors';
import { withTimeout } from '../network';
import { submitWithGuard } from '../transactions/guarded-submit';
import { assertTransactionBuildValid } from '../transactions/build-validation';
import { validateAssetSpec, verifyPaymentTrustlineOrThrow } from './trustline';

/**
 * Sends XLM from one account to another.
 *
 * All inputs are validated before any transaction is built or submitted, so
 * invalid parameters produce a synchronous PocketPayError rather than a late
 * network failure. An unfunded or nonexistent source account is surfaced as a
 * clear ACCOUNT_NOT_FOUND error.
 *
 * @param params - Payment parameters (sourceSecret, destination, amount, memo?)
 * @param config - Optional SDK config overrides
 * @returns Payment result with transaction hash and details
 * @throws PocketPayError on validation or network errors
 */
export async function sendXLM(
  params: SendXLMParams,
  config?: Partial<SDKConfig>
): Promise<PaymentResult> {
  const { sourceSecret, destination, amount, memo } = params;
  // ─── Preflight validation (before any network call) ─────────────────────────
  // Runs through the shared build-validation pipeline (issue #249) rather than
  // hand-chaining the same four validators here and again in `sendAsset`. The
  // pipeline rethrows the originating PocketPayError untouched, so every
  // published code below is unchanged. `network` is excluded because this
  // function resolves config itself inside the try block, and moving that would
  // change when a configuration error surfaces relative to the handler below.
  assertTransactionBuildValid(
    { sourceSecret, destination, amount, memo },
    {
      stages: ['sourceAccount', 'destination', 'amount', 'memo'],
      selfPaymentMessage: 'Cannot send XLM to yourself',
    },
  );
  const sourceKeypair = StellarSDK.Keypair.fromSecret(sourceSecret);
  const sourcePublic = sourceKeypair.publicKey();
  try {
    const cfg = resolveConfig(config);
    const server = getHorizonServer(config);
    const networkPassphrase = getNetworkPassphrase(cfg.network);
    const sourceAccount = await withTimeout(
      'Horizon source account lookup',
      cfg.timeout,
      server.loadAccount(sourcePublic),
    );
    // Build transaction
    const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    });
    builder.addOperation(
      StellarSDK.Operation.payment({
        destination,
        asset: StellarSDK.Asset.native(),
        amount,
      })
    );
    const builtMemo = buildMemo(memo);
    if (builtMemo) {
      builder.addMemo(builtMemo);
    }
    builder.setTimeout(30);
    const transaction = builder.build();
    transaction.sign(sourceKeypair);
    // Submission goes through the duplicate-submission guard (issue #305).
    // A bare `server.submitTransaction` treats a timeout as a failure, but the
    // signed envelope may already be on-chain, and "resubmit to be sure" is how
    // a payment gets made twice. The guard polls instead; a definitive
    // rejection still arrives here unchanged, so the mapping below is intact.
    const result = await submitWithGuard(transaction, {}, config);
    const resultObj = result as any;
    return {
      success: true,
      hash: resultObj.hash,
      ledger: resultObj.ledger,
      fee: resultObj.fee_charged || String(StellarSDK.BASE_FEE),
      sourceAccount: sourcePublic,
      destinationAccount: destination,
      amount,
      createdAt: resultObj.created_at || new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof PocketPayError) throw error;
    const horizonError = error as any;
    // Unfunded / nonexistent source account → clear preflight-style error
    if (horizonError?.response?.status === 404) {
      throw new PocketPayError(
        `Source account not found: ${sourcePublic}. It may not be funded yet.`,
        'ACCOUNT_NOT_FOUND',
        404
      );
    }
    // Horizon transaction-failure result codes
    if (horizonError?.response?.data?.extras?.result_codes) {
      const codes = horizonError.response.data.extras.result_codes;
      // Only include transaction result code, not operation details (may contain sensitive data)
      throw new PocketPayError(
        `Payment failed with transaction result code: ${codes.transaction}`,
        'PAYMENT_FAILED',
        400
      );
    }
    throw wrapError(error, 'Failed to send XLM', 'SEND_ERROR');
  }
}

// ─── Safe Wrappers ──────────────────────────────────────────────────────────

export async function safeSendXLM(
  params: SendXLMParams,
  config?: Partial<SDKConfig>
): Promise<PocketPayResult<PaymentResult>> {
  return toResult(() => sendXLM(params, config), 'Failed to send XLM', 'SEND_ERROR');
}

/**
 * Sends XLM with an enriched result containing warnings and recovery hints.
 *
 * This is a pilot of the enhanced result pattern. It wraps {@link sendXLM}
 * and returns an {@link EnhancedPocketPayResult} that may include:
 * - **Warnings** when the operation succeeds but with caveats (e.g. high fee
 *   relative to amount).
 * - **Recovery hints** on failure to guide the consumer toward a fix (e.g.
 *   "fund_account" when the source account doesn't exist).
 *
 * @param params - Payment parameters (sourceSecret, destination, amount, memo?)
 * @param config - Optional SDK config overrides
 * @returns An enriched result with optional warnings and recovery hints
 */
export async function enhancedSendXLM(
  params: SendXLMParams,
  config?: Partial<SDKConfig>,
): Promise<EnhancedPocketPayResult<PaymentResult>> {
  const { amount } = params;
  const warnings: ResultWarning[] = [];
  const recoveryHints: RecoveryHint[] = [];

  try {
    const result = await sendXLM(params, config);

    const feeNum = parseFloat(result.fee);
    const amountNum = parseFloat(amount);
    if (amountNum > 0 && feeNum / amountNum > 0.1) {
      warnings.push({
        code: 'HIGH_FEE_RATIO',
        message: `Transaction fee (${result.fee} stroops) is more than 10% of the payment amount.`,
      });
    }

    return toEnhancedSuccessResult(result, warnings, recoveryHints);
  } catch (error) {
    const pocketErr =
      error instanceof PocketPayError
        ? error
        : wrapError(error, 'Failed to send XLM', 'SEND_ERROR');

    if (pocketErr.code === 'ACCOUNT_NOT_FOUND') {
      recoveryHints.push({
        action: 'fund_account',
        message: 'Fund the source account with XLM before sending a payment.',
        retryable: false,
      });
    }

    if (pocketErr.code === 'PAYMENT_FAILED') {
      recoveryHints.push({
        action: 'check_input',
        message: 'Verify that the destination account exists and the amount is within your available balance.',
        retryable: false,
      });
    }

    // A submission or confirmation timeout leaves the payment's outcome
    // undetermined — it may already be on-chain. Advising a plain retry here
    // risks paying twice, so those surface as TX_STATUS_UNKNOWN and get a
    // check-status hint instead.
    if (pocketErr.code === 'TX_STATUS_UNKNOWN') {
      recoveryHints.push({
        action: 'check_status',
        message:
          'The payment was sent but its result is unknown. Check the transaction status ' +
          'before sending again — resubmitting may pay twice.',
        retryable: false,
      });
    }

    if (pocketErr.code === 'REQUEST_TIMEOUT' || pocketErr.code === 'SEND_ERROR') {
      recoveryHints.push({
        action: 'retry',
        message: 'The network may be temporarily unavailable. Try again in a few seconds.',
        retryable: true,
        suggestedDelayMs: 3000,
      });
    }

    if (pocketErr.validation) {
      recoveryHints.push({
        action: 'check_input',
        message: `Fix the ${pocketErr.validation.field} field: ${pocketErr.validation.reason}.`,
        retryable: false,
      });
    }

    return toEnhancedFailureResult(pocketErr, warnings, recoveryHints);
  }
}

/**
 * Non-throwing wrapper for {@link enhancedSendXLM}.
 *
 * @param params - Payment parameters
 * @param config - Optional SDK config overrides
 * @returns An enriched result that never throws
 */
export async function safeEnhancedSendXLM(
  params: SendXLMParams,
  config?: Partial<SDKConfig>,
): Promise<EnhancedPocketPayResult<PaymentResult>> {
  return toEnhancedResult(() => sendXLM(params, config), {
    errorContext: 'Failed to send XLM',
    errorCode: 'SEND_ERROR',
  });
}

// ─── Trustline Validation ───────────────────────────────────────────────────
export {
  validateAssetSpec,
  checkDestinationTrustline,
  safeCheckDestinationTrustline,
  verifyPaymentTrustlineOrThrow,
} from './trustline';

// ─── Destination Account Validation ─────────────────────────────────────────
export {
  validateDestinationLocal,
  validateDestinationNetwork,
  validateDestinationComplete,
  validateDestinationOrThrow,
  safeValidateDestination,
  safeValidateDestinationLocal,
  safeValidateDestinationNetwork,
} from './destination-validation';
export type {
  DestinationValidationLevel,
  DestinationValidationStatus,
  DestinationValidationOptions,
  DestinationValidationResult,
} from './destination-validation';
// ─── Send-XLM Input Validation (non-throwing) ───────────────────────────────
export {
  validateSendXLMParams,
} from './validation';
export { parseQRPayload, QRPayload, QRParseResult } from './qrParser';
export type {
  ValidationError,
  ValidationErrorCode,
  ValidationErrorField,
  SendXLMValidationResult,
} from './validation';

// ─── Payment Receipts ───────────────────────────────────────────────────────
export {
  buildPaymentReceipt,
  buildReceiptFromSubmission,
  buildReceiptFromSoroban,
} from './receipt';
export type { PaymentReceiptOptions } from './receipt';

// ─── Issued Asset Payments ──────────────────────────────────────────────────

/**
 * Resolves a {@link StellarAssetSpec} to a `@stellar/stellar-sdk` `Asset`
 * instance.  Native XLM is returned for `code: "XLM"` / `"native"`; all
 * other codes are treated as issued (credit) assets.
 */
function resolveAsset(asset: import('../types').StellarAssetSpec): StellarSDK.Asset {
  const code = asset.code.trim().toUpperCase();
  if (code === 'XLM' || asset.code.toLowerCase() === 'native') {
    return StellarSDK.Asset.native();
  }
  return new StellarSDK.Asset(asset.code, asset.issuer!);
}

/**
 * Sends a payment in any Stellar asset — native XLM or any issued asset.
 *
 * Mirrors the behaviour of {@link sendXLM} for native XLM payments (passing
 * `asset: { code: 'XLM' }` is fully equivalent). For issued assets a
 * mandatory preflight trustline check is run before the transaction is built,
 * so invalid destinations are surfaced as clear typed errors rather than
 * opaque Horizon result codes.
 *
 * Validation order (all synchronous before any network call):
 * 1. Source secret key format
 * 2. Destination public key format
 * 3. Amount (positive decimal string)
 * 4. Memo (≤ 28 bytes)
 * 5. Asset specification format (`validateAssetSpec`)
 * 6. Self-payment guard
 *
 * Then for issued assets only:
 * 7. Destination trustline preflight via Horizon (skippable via
 *    `skipTrustlineCheck: true`)
 *
 * @param params - Payment parameters including asset specification
 * @param config - Optional SDK config overrides
 * @returns Payment result with transaction hash and asset details
 * @throws {PocketPayError} on any validation, trustline, or network error
 */
export async function sendAsset(
  params: SendAssetParams,
  config?: Partial<SDKConfig>,
): Promise<PaymentResult> {
  const { sourceSecret, destination, amount, asset, memo, skipTrustlineCheck } = params;

  // ─── Preflight validation (synchronous, no network) ──────────────────────
  // Same shared pipeline as `sendXLM` (issue #249). This path is where the
  // duplication was most visible: the identical four validators, plus the asset
  // check. Only the self-payment wording differs between the two flows, so that
  // sentence is passed in rather than the check being repeated.
  assertTransactionBuildValid(
    { sourceSecret, destination, amount, asset, memo },
    {
      stages: ['sourceAccount', 'destination', 'amount', 'asset', 'memo'],
      selfPaymentMessage: 'Cannot send asset to yourself',
    },
  );

  const sourceKeypair = StellarSDK.Keypair.fromSecret(sourceSecret);
  const sourcePublic = sourceKeypair.publicKey();

  const isNative =
    asset.code.toUpperCase() === 'XLM' || asset.code.toLowerCase() === 'native';

  // ─── Trustline preflight (issued assets only, network call) ──────────────
  if (!isNative && !skipTrustlineCheck) {
    await verifyPaymentTrustlineOrThrow(destination, asset, { amount, config });
  }

  let transaction: StellarSDK.Transaction | undefined;
  try {
    const cfg = resolveConfig(config);
    const server = getHorizonServer(config);
    const networkPassphrase = getNetworkPassphrase(cfg.network);

    const sourceAccount = await withTimeout(
      'Horizon source account lookup',
      cfg.timeout,
      server.loadAccount(sourcePublic),
    );

    const stellarAsset = resolveAsset(asset);

    const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    });

    builder.addOperation(
      StellarSDK.Operation.payment({
        destination,
        asset: stellarAsset,
        amount,
      }),
    );

    const builtMemo = buildMemo(memo);
    if (builtMemo) {
      builder.addMemo(builtMemo);
    }

    builder.setTimeout(30);
    transaction = builder.build();
    transaction.sign(sourceKeypair);

    // Guarded submission (issue #305) — same rationale as sendXLM above.
    const result = await submitWithGuard(transaction, {}, config);

    const resultObj = result as any;
    return {
      success: true,
      hash: resultObj.hash,
      ledger: resultObj.ledger,
      fee: resultObj.fee_charged || String(StellarSDK.BASE_FEE),
      sourceAccount: sourcePublic,
      destinationAccount: destination,
      amount,
      createdAt: resultObj.created_at || new Date().toISOString(),
      asset: isNative ? { code: 'XLM' } : { code: asset.code, issuer: asset.issuer },
    };
  } catch (error) {
    if (error instanceof PocketPayError) throw error;
    const horizonError = error as any;

    if (horizonError?.response?.status === 404) {
      throw new PocketPayError(
        `Source account not found: ${sourcePublic}. It may not be funded yet.`,
        'ACCOUNT_NOT_FOUND',
        404,
      );
    }

    if (horizonError?.response?.data?.extras?.result_codes) {
      const codes = horizonError.response.data.extras.result_codes;
      throw new PocketPayError(
        `Payment failed with transaction result code: ${codes.transaction}`,
        'PAYMENT_FAILED',
        400,
      );
    }

    throw wrapError(error, 'Failed to send asset', 'SEND_ERROR');
  }
}

/**
 * Non-throwing wrapper for {@link sendAsset}.
 *
 * @param params - Payment parameters including asset specification
 * @param config - Optional SDK config overrides
 * @returns `PocketPayResult<PaymentResult>` — never throws
 */
export async function safeSendAsset(
  params: SendAssetParams,
  config?: Partial<SDKConfig>,
): Promise<PocketPayResult<PaymentResult>> {
  return toResult(
    () => sendAsset(params, config),
    'Failed to send asset',
    'SEND_ERROR',
  );
}


export { previewPayment, previewPaymentWithReadiness } from './preview';
export type { PaymentReadinessPreview } from './preview';
export * from './intent';

// ─── Transaction Readiness (issue #441) ─────────────────────────────────────
export { checkTransactionReadiness, READINESS_CHECK_ORDER } from './readiness';
export type {
  TransactionReadiness,
  TransactionReadinessParams,
  TransactionReadinessCheck,
  TransactionReadinessCheckStatus,
  TransactionReadinessBlocker,
  TransactionReadinessBlockerCode,
  TransactionReadinessWarning,
  TransactionReadinessWarningCode,
  TransactionReadinessField,
  TransactionReadinessBalance,
} from './readiness';
