# Transaction Memo Validation

The SDK validates memos consistently across every payment and transaction
helper. This page documents the rules for each Stellar memo type, the error you
get when a memo is rejected, and how to migrate from plain-string memos.

## Memo types

Stellar defines five memo types. All five are validated; four carry a payload.

| Type | Payload | Rule |
| --- | --- | --- |
| `none` | — | No memo is attached. |
| `text` | UTF-8 string | Up to **28 bytes**. Multi-byte characters count for more than one byte each. |
| `id` | unsigned 64-bit integer | Decimal digits only, `0` to `18446744073709551615` (2⁶⁴−1). Strings and bigint support the full range; number inputs must satisfy `Number.isSafeInteger`. |
| `hash` | 32 bytes | Exactly **64 hexadecimal characters**. Case-insensitive. |
| `return` | 32 bytes | Exactly **64 hexadecimal characters**. Case-insensitive. |

`undefined` and the empty string both mean "no memo" and are always valid —
memos are optional on every SDK operation that accepts one.

## Passing a memo

Anywhere a memo is accepted you may pass either a plain string or a typed
`MemoInput`. A plain string is treated as a `text` memo, which is what it has
always meant, so existing code needs no changes.

```ts
import { sendXLM } from 'stellar-pocketpay-sdk';

// text — the plain-string form, unchanged
await sendXLM({ sourceSecret, destination, amount: '10', memo: 'invoice #42' });

// text — the explicit form, identical result
await sendXLM({ ...params, memo: { type: 'text', value: 'invoice #42' } });

// id — an unsigned 64-bit integer, commonly used by exchanges
await sendXLM({ ...params, memo: { type: 'id', value: '1234567890' } });

// hash / return — 32 bytes as 64 hex characters
await sendXLM({ ...params, memo: { type: 'hash', value: 'a1b2...' } });

// none — explicitly no memo
await sendXLM({ ...params, memo: { type: 'none' } });
```

Memos are validated by `sendXLM`, `sendAsset`, `previewPayment`,
`validateSendXLMParams`, and the offline transaction preparation helpers.

## Validation helpers

| Helper | Behaviour |
| --- | --- |
| `validateMemoInput(memo)` | Returns `true`, or throws `PocketPayError` with code `TX_INVALID_MEMO`. |
| `safeValidateMemo(memo)` | Non-throwing: returns `{ valid: true }` or `{ valid: false, error }`. |
| `normalizeMemo(memo)` | Converts a string or `MemoInput` into a `MemoInput`, or `undefined` for no memo. |
| `buildMemo(memo)` | Validates, then returns the Stellar `Memo` to attach — or `undefined` for no memo. |
| `validateMemo(text)` | **Legacy.** Text-only 28-byte check. Kept for backwards compatibility. |

```ts
import { safeValidateMemo } from 'stellar-pocketpay-sdk';

const result = safeValidateMemo({ type: 'id', value: 'not-a-number' });
if (!result.valid) {
  console.error(result.error.code);               // 'TX_INVALID_MEMO'
  console.error(result.error.validation?.reason); // 'not_unsigned_integer'
}
```

## Errors

Every rejection is a `PocketPayError` with code `TX_INVALID_MEMO`, part of the
[published error standard](./error-standard.md), so `isKnownErrorCode()`
recognises it and `describeError()` returns real guidance rather than the
generic unknown-code fallback.

The `validation.reason` field says which rule was broken:

| `reason` | Meaning |
| --- | --- |
| `unexpected_payload` | A `none` memo included a value even though this memo type carries no payload. The invalid payload is not echoed into the validation error metadata. |
| `unsupported_type` | The `type` is not one of the five Stellar memo types. |
| `too_long` | A `text` memo exceeds 28 bytes. |
| `not_unsigned_integer` | An `id` memo is negative, fractional, or not numeric. |
| `unsafe_number` | An `id` memo was passed as a JavaScript number outside the safe-integer range; use a decimal string or bigint instead. |
| `out_of_range` | An `id` memo exceeds 2⁶⁴−1. |
| `invalid_length` | A `hash` or `return` memo is not 64 hex characters. |
| `not_hexadecimal` | A `hash` or `return` memo contains non-hex characters. |
| `invalid_type` | The payload type does not match the memo type. |
| `invalid_shape` | The memo is neither a string nor a `{ type, value }` object. |

Reasons are distinct so callers can tell an unsupported *format* from a payload
that is merely too long — previously both surfaced as "Memo text exceeds
28-byte limit".

## Previews

`previewPayment` reports the memo alongside its type, mirroring how
`TransactionSummary` exposes `memo` and `memoType` for transactions read back
from Horizon:

```ts
const preview = await previewPayment({ ...params, memo: { type: 'id', value: '12345' } });
preview.memo;     // '12345'
preview.memoType; // 'id'
```

### Safe display formatting

Use `formatMemoForDisplay(memo)` when rendering a memo in a single-line UI,
log, or confirmation surface. It normalizes and validates the memo first.
Text memos JSON-escape control characters, quotes, and backslashes without
adding surrounding quotes; Unicode NEXT LINE (U+0085), LINE SEPARATOR (U+2028)
and PARAGRAPH SEPARATOR (U+2029) are also escaped for single-line display.
Bidirectional controls (U+061C, U+200E–U+200F, U+202A–U+202E,
U+2066–U+2069) are rendered as literal `\uNNNN` escapes so
memo text cannot visually reorder adjacent display labels. This does not
sanitize memo text for HTML injection.
`id`, `hash`, and `return` payloads are returned
as their validated string values. Missing or `none` memos return `undefined`.

`previewPayment` uses this helper for its display-only `memo` field. This does
not change the memo attached to a transaction: transaction construction still
uses `buildMemo` and the original validated payload.

## Migration

Nothing is required. Plain-string memos keep working and keep meaning `text`.

- `memo?: string` widened to `memo?: string | MemoInput` on `SendXLMParams`,
  `SendAssetParams`, `PaymentPreviewParams`, and the offline preparation params.
  This is additive.
- `PaymentPreview` gained an optional `memoType`. Its `memo` field is still a
  string.
- Memo failures now report `TX_INVALID_MEMO` instead of the unregistered
  `INVALID_MEMO` string. Consumers branching on the old value should switch to
  the published code; the thrown value is still a `PocketPayError` and the
  text-memo message is unchanged.

## See also

- [Error Standard](./error-standard.md) — the published error code registry.
- [Getting Started](./getting-started.md) — sending your first payment.
