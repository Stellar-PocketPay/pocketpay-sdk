import { PocketPayError } from '../types';
import { validateDestinationLocal } from './destination-validation';

export type RecipientSource = 'direct' | 'saved_contact' | 'destination_metadata';

export interface SavedContactRecipient {
  kind: 'saved_contact';
  publicKey: string;
  contactId?: string;
  name?: string;
  memo?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentDestinationRecipient {
  kind: 'destination';
  address: string;
  label?: string;
  memo?: string;
  metadata?: Record<string, unknown>;
}

export type RecipientInput = string | SavedContactRecipient | PaymentDestinationRecipient;

export interface NormalizedRecipient {
  publicKey: string;
  source: RecipientSource;
  contactId?: string;
  label?: string;
  memo?: string;
  metadata?: Record<string, unknown>;
}

export type RecipientValidationStatus =
  | 'valid'
  | 'missing'
  | 'invalid_shape'
  | 'invalid_public_key';

export type RecipientValidationResult =
  | {
      valid: true;
      status: 'valid';
      recipient: NormalizedRecipient;
    }
  | {
      valid: false;
      status: Exclude<RecipientValidationStatus, 'valid'>;
      code: 'INVALID_PUBLIC_KEY' | 'INVALID_RECIPIENT';
      message: string;
    };

interface RecipientCandidate extends NormalizedRecipient {}

function own(descriptor: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(descriptor, key)
    ? descriptor[key] : undefined;
}

function trimmedOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function invalidRecipientShape(message: string): RecipientValidationResult {
  return {
    valid: false,
    status: 'invalid_shape',
    code: 'INVALID_RECIPIENT',
    message,
  };
}

function hasInvalidOptionalString(
  descriptor: Record<string, unknown>,
  field: string,
): boolean {
  const value = own(descriptor, field);
  return value !== undefined && typeof value !== 'string';
}

function hasInvalidMetadata(descriptor: Record<string, unknown>): boolean {
  const value = own(descriptor, 'metadata');
  if (value === undefined) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;

  // Runtime callers can bypass the TypeScript Record type. A Date, Map, Set
  // or class instance would spread to incomplete/empty recipient metadata.
  // Permit ordinary dictionaries, including null-prototype JSON records.
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return true;
    // Never execute property accessors while copying untrusted metadata.
    return Object.values(Object.getOwnPropertyDescriptors(value)).some(
      descriptor => !Object.prototype.hasOwnProperty.call(descriptor, 'value'),
    );
  } catch {
    return true;
  }
}

function candidateFromInput(
  input: unknown,
): RecipientCandidate | RecipientValidationResult {
  if (typeof input === 'string') {
    const publicKey = input.trim();
    if (!publicKey) {
      return {
        valid: false,
        status: 'missing',
        code: 'INVALID_PUBLIC_KEY',
        message: 'Recipient public key is required',
      };
    }
    return { publicKey, source: 'direct' };
  }

  if (!input || typeof input !== 'object') {
    return {
      valid: false,
      status: 'invalid_shape',
      code: 'INVALID_RECIPIENT',
      message: 'Recipient must be a Stellar public key or recipient descriptor',
    };
  }

  const descriptor = input as Record<string, unknown>;
  // Only literal dictionary descriptors can supply a destination. Classes,
  // inherited recipient fields and proxy traps must not impersonate user data.
  const prototype = Object.getPrototypeOf(descriptor);
  if (prototype !== null && prototype !== Object.prototype) {
    return invalidRecipientShape('Recipient descriptor must be a plain object');
  }
  // An accessor-bearing object can mutate a recipient between validation
  // and use. Accept JSON data properties only, never execute getters.
  if (Object.values(Object.getOwnPropertyDescriptors(descriptor)).some(
    property => !Object.prototype.hasOwnProperty.call(property, 'value'),
  )) {
    return invalidRecipientShape('Recipient descriptor must use data properties');
  }
  const kind = own(descriptor, 'kind');

  if (kind === 'saved_contact') {
    if (
      own(descriptor, 'publicKey') !== undefined &&
      typeof own(descriptor, 'publicKey') !== 'string'
    ) {
      return invalidRecipientShape('Saved contact public key must be a string');
    }
    if (
      ['contactId', 'name', 'memo'].some((field) =>
        hasInvalidOptionalString(descriptor, field),
      )
    ) {
      return invalidRecipientShape(
        'Saved contact optional fields must be strings',
      );
    }
    if (hasInvalidMetadata(descriptor)) {
      return invalidRecipientShape('Saved contact metadata must be an object');
    }

    const publicKey = trimmedOptional(own(descriptor, 'publicKey'));
    if (!publicKey) {
      return {
        valid: false,
        status: 'missing',
        code: 'INVALID_PUBLIC_KEY',
        message: 'Saved contact recipient requires a public key',
      };
    }

    return {
      publicKey,
      source: 'saved_contact',
      contactId: trimmedOptional(own(descriptor, 'contactId')),
      label: trimmedOptional(own(descriptor, 'name')),
      memo: typeof own(descriptor, 'memo') === 'string' ? own(descriptor, 'memo') as string : undefined,
      metadata:
        own(descriptor, 'metadata') && typeof own(descriptor, 'metadata') === 'object'
          ? { ...(own(descriptor, 'metadata') as Record<string, unknown>) }
          : undefined,
    };
  }

  if (kind === 'destination') {
    if (
      own(descriptor, 'address') !== undefined &&
      typeof own(descriptor, 'address') !== 'string'
    ) {
      return invalidRecipientShape('Payment destination address must be a string');
    }
    if (
      ['label', 'memo'].some((field) =>
        hasInvalidOptionalString(descriptor, field),
      )
    ) {
      return invalidRecipientShape(
        'Payment destination optional fields must be strings',
      );
    }
    if (hasInvalidMetadata(descriptor)) {
      return invalidRecipientShape('Payment destination metadata must be an object');
    }

    const publicKey = trimmedOptional(own(descriptor, 'address'));
    if (!publicKey) {
      return {
        valid: false,
        status: 'missing',
        code: 'INVALID_PUBLIC_KEY',
        message: 'Payment destination recipient requires an address',
      };
    }

    return {
      publicKey,
      source: 'destination_metadata',
      label: trimmedOptional(own(descriptor, 'label')),
      memo: typeof own(descriptor, 'memo') === 'string' ? own(descriptor, 'memo') as string : undefined,
      metadata:
        own(descriptor, 'metadata') && typeof own(descriptor, 'metadata') === 'object'
          ? { ...(own(descriptor, 'metadata') as Record<string, unknown>) }
          : undefined,
    };
  }

  return {
    valid: false,
    status: 'invalid_shape',
    code: 'INVALID_RECIPIENT',
    message: 'Recipient descriptor kind must be "saved_contact" or "destination"',
  };
}

/**
 * Validate and normalize a direct address, saved contact, or payment destination.
 *
 * Address checks delegate to the shared destination validator so recipient
 * handling follows the same Stellar StrKey/checksum rules as payment flows.
 */
export function validateRecipient(input: unknown): RecipientValidationResult {
  // Public validation returns a typed result even if a JavaScript caller
  // supplies an object with throwing accessors or Proxy traps.
  let candidate: RecipientCandidate | RecipientValidationResult;
  try {
    candidate = candidateFromInput(input);
  } catch {
    return invalidRecipientShape('Recipient descriptor could not be read safely');
  }
  if ('valid' in candidate) return candidate;

  const destination = validateDestinationLocal(candidate.publicKey);
  if (!destination.valid) {
    return {
      valid: false,
      status: 'invalid_public_key',
      code: 'INVALID_PUBLIC_KEY',
      message: 'Recipient must contain a valid Stellar public key (G...)',
    };
  }

  return {
    valid: true,
    status: 'valid',
    recipient: candidate,
  };
}

/**
 * Throwing normalization helper for call sites that require a canonical
 * recipient before continuing.
 */
export function normalizeRecipient(input: RecipientInput): NormalizedRecipient {
  const result = validateRecipient(input);
  if (result.valid) return result.recipient;

  throw new PocketPayError(result.message, result.code, {
    validation: {
      field: 'recipient',
      reason: result.status,
    },
  });
}
