import { Asset, IssuedAsset } from './asset';
import type { MemoInput } from './index';

/** Status of a payment intent lifecycle */
export type PaymentIntentStatus =
  | 'created'
  | 'valid'
  | 'requires_trustline'
  | 'unsupported_asset'
  | 'invalid'
  | 'executed'
  | 'failed';

/** State classification for multi-asset support */
export type AssetState = 'supported' | 'unsupported' | 'restricted' | 'pending_trustline';

/** Metadata associated with an asset in a payment intent */
export interface AssetMetadata {
  name?: string;
  domain?: string;
  decimals?: number;
  iconUrl?: string;
  description?: string;
  issuerName?: string;
}

/** Trustline validation strategy choices */
export type TrustlineValidationStrategy = 'require_existing' | 'auto_check' | 'skip';

/** Trustline evaluation result for an issued asset */
export interface TrustlineValidationResult {
  hasTrustline: boolean;
  asset: IssuedAsset;
  destination: string;
  requiredLimit?: string;
  error?: string;
}

/** Preflight validation issue for a payment intent */
export interface PaymentIntentValidationIssue {
  field: string;
  code: string;
  reason: string;
  message: string;
}

/** Detailed validation result for a PaymentIntent */
export interface PaymentIntentValidationResult {
  valid: boolean;
  status: PaymentIntentStatus;
  assetState: AssetState;
  issues: PaymentIntentValidationIssue[];
  trustlineCheck?: TrustlineValidationResult;
}

/** Core PaymentIntent model */
export interface PaymentIntent {
  /** Unique PaymentIntent identifier */
  id: string;
  /** Source public key or wallet address */
  source: string;
  /** Destination public key (G...) */
  destination: string;
  /** Payment amount as string (e.g. "100.5000000") */
  amount: string;
  /** Asset to transfer (Native XLM or Issued Asset) */
  asset: Asset;
  /** Optional asset metadata */
  assetMetadata?: AssetMetadata;
  /** Optional transaction memo */
  memo?: string | MemoInput;
  /** Current status of intent */
  status: PaymentIntentStatus;
  /** Asset state classification */
  assetState: AssetState;
  /** Strategy for trustline validation */
  trustlineStrategy: TrustlineValidationStrategy;
  /** Timestamp when intent was created (ISO string) */
  createdAt: string;
  /** Optional custom caller metadata */
  metadata?: Record<string, unknown>;
  /** Validation details */
  validationResult?: PaymentIntentValidationResult;
}

/** Parameters required to create a new PaymentIntent */
export interface CreatePaymentIntentParams {
  /** Source public key or wallet address (G...) */
  source: string;
  /** Destination public key (G...) */
  destination: string;
  /** Payment amount as string (e.g. "50.0000000") */
  amount: string;
  /** Asset to transfer (Native XLM or Issued Asset) */
  asset: Asset;
  /** Optional asset metadata (name, domain, decimals, icon) */
  assetMetadata?: AssetMetadata;
  /** Optional memo */
  memo?: string | MemoInput;
  /** Optional caller metadata */
  metadata?: Record<string, unknown>;
  /** Strategy for trustline validation (default: 'auto_check') */
  trustlineStrategy?: TrustlineValidationStrategy;
}
