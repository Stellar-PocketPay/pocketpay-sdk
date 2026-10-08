# Safe Amount Model

Stellar amounts are signed 64-bit integers of **stroops**, where one unit of any
asset is 10,000,000 stroops. This page documents how the SDK parses, validates,
formats and transports amounts without floating-point arithmetic.

## Why `number` is the wrong type

| | Maximum |
| --- | --- |
| Stellar amount (int64) | `9,223,372,036,854,775,807` stroops = `922,337,203,685.4775807` units |
| `Number.MAX_SAFE_INTEGER` | `9,007,199,254,740,991` stroops = `900,719,925.4740992` units |

A JavaScript `number` covers roughly a thousandth of the protocol's range.
Everyday XLM amounts stay well inside the safe zone, but issued assets routinely
use the full int64 range, and this is fund-safety code — the type has to cover
the domain, not the common case.

## SafeAmount

`SafeAmount` holds the value as a `bigint` of stroops and keeps the caller's
original string, so exact user intent is preserved by construction rather than
by round-tripping through `toFixed()`.

```ts
import { parseAmount } from 'stellar-pocketpay-sdk';

const amount = parseAmount('10.5000000');

amount.stroops;         // 105000000n — exact
amount.input;           // '10.5000000' — what the caller wrote
amount.toString();      // '10.5000000' — canonical, always 7 decimals
amount.toStroopString();// '105000000'
amount.isZero;          // false
```

Instances are frozen. `JSON.stringify` produces the canonical decimal string.

### Parsing

| Helper | Behaviour |
| --- | --- |
| `parseAmount(str)` | Exact parse. Accepts zero. Throws `PAYMENT_INVALID_AMOUNT` on bad input. |
| `parsePositiveAmount(str)` | As above, and rejects zero. |
| `safeParseAmount(str)` | Non-throwing: `{ valid: true, amount }` or `{ valid: false, error }`. |
| `fromStroops(bigint \| str)` | Builds from a stroop count. |
| `toStroops(str)` | Returns the exact `bigint` stroop count. |
| `formatStroops(bigint)` | Canonical decimal string, built from the digits. |

Parsing splits the string and concatenates the padded fraction, so the value is
read as an integer. `parseFloat` is never used.

### Accepted and rejected input

Accepted: `'0'`, `'0.0000001'`, `'1'`, `'10.5'`, `'10.5000000'`,
`'922337203685.4775807'`.

Rejected, each with a `validation.reason`:

| Input | Reason |
| --- | --- |
| `''`, `' '`, `'10abc'`, `'1e3'`, `'NaN'`, `'Infinity'`, `'-1'`, `'.5'`, `'1.'` | `invalid_format` |
| `'1.00000001'` (8 decimals) | `too_precise` |
| above `922337203685.4775807` | `exceeds_maximum` |
| `'0'` via `parsePositiveAmount` | `not_positive` |

### Arithmetic

`plus` and `minus` operate on stroops, so results are exact:

```ts
parseAmount('0.1').plus(parseAmount('0.2')).toString(); // '0.3000000'
```

`plus` rejects a sum above the protocol maximum (`overflow`); `minus` rejects a
negative result (`negative_result`). `equals` and `compare` work on value, so
`'1'` and `'1.0000000'` are equal.

## Formatting rules

- Output is always **exactly 7 decimal places**, rebuilt from the integer.
- `'1'` formats as `'1.0000000'`; `'10.5'` as `'10.5000000'`.
- Trailing zeros in input are preserved on `.input` and normalised on output —
  the two spellings are the same value.

## Legacy helpers

`validateAmount`, `stroopsToXLM` and `xlmToStroops` remain exported with their
existing signatures. They no longer lose precision silently:

- **`validateAmount`** — delegates precision and range to the shared parser; retains
  `INVALID_AMOUNT_PRECISION` for more than 7 decimal places, and `INVALID_AMOUNT`
  for invalid format, zero or values above signed int64 stroops. An overflow
  cannot silently pass legacy payment or vault validation.
- **`stroopsToXLM`** — exact across the whole range; rejects a `number` that is
  not a safe integer instead of rounding it. Pass large values as strings.
- **`xlmToStroops`** — **deprecated.** Still returns a `number`, but now throws
  (`exceeds_safe_integer`) when the exact value would not fit, instead of
  returning a wrong one. Use `toStroops()` for a `bigint`.

```ts
// Before: silently wrong above the safe range.
// Now: throws, so the caller learns rather than pays the wrong amount.
xlmToStroops('900719925.4740993'); // PocketPayError

toStroops('900719925.4740993');    // 9007199254740993n — exact
```

## Where it is used

Both vault paths — `depositToVault` and `withdrawFromVault` in
`src/soroban/index.ts` — convert with `toStroops()` and encode the `bigint`
directly as `i128`. They previously used
`Math.round(parseFloat(amount) * 10_000_000)`.

The destination trustline capacity checks — `checkDestinationTrustline` in
`src/payments/trustline.ts` and `validateDestinationNetwork` in
`src/payments/destination-validation.ts` — read Horizon's `balance` and `limit`
with the shared parser and compare `limit - balance` against the payment amount
in stroops. `availableCapacity` is formatted with `formatStroops`, so the default
trustline limit reports `922337203685.4775807` rather than a float-rounded value,
and a payment that exactly fills the remaining capacity is accepted. Both helpers
run `validateAmount` on the amount before the Horizon lookup.

Results are formatted with the same model. The vault `get_balance` mapping
(`mapVaultInvocationResult` in `src/soroban/mapper.ts`) builds `balance` with
`formatStroops` and `rawStroops` with the exact parser, and transaction history
(`amountDisplay` in `src/transactions/mapper.ts`) prints Horizon amounts through
`parseAmount`. Balances and amounts above 2^53 stroops (about 900 million XLM)
keep every digit instead of being rounded through `Number`.

## See also

- [Error Standard](./error-standard.md) — the published error code registry.
- [Issued Asset Payments](./issued-asset-payments.md) — where the full int64
  range is actually used.
