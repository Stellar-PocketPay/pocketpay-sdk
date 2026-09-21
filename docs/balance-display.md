# Balance display normalisation

PocketPay exposes one shared balance-display contract for wallet, payment, and vault UI consumers:

```ts
import {
  formatBalanceDisplay,
  normalizeBalanceDisplay,
  NATIVE_ASSET,
} from 'stellar-pocketpay-sdk';

formatBalanceDisplay('1250.5000000', NATIVE_ASSET);
// "1,250.50 XLM"

normalizeBalanceDisplay({
  balance: '42.1250000',
  asset: {
    type: 'issued',
    code: 'USDC',
    issuer: 'G...',
  },
});
```

## Precision rules

Balance input is a **decimal string**. The normaliser deliberately rejects JavaScript numbers so a caller cannot silently lose Stellar's 7-decimal / 64-bit stroop precision before formatting.

Valid input is parsed by the SDK's exact `SafeAmount` model. Grouping, trimming, padding, and rounding operate on decimal-string digits / bigint only; the normaliser never uses `parseFloat`, `Number`, or `toFixed`.

Defaults:

- minimum fraction digits: 2
- maximum fraction digits: 7
- thousands grouping: enabled
- issued-asset label: asset code only

Set `minimumFractionDigits` and `maximumFractionDigits` to the same value for fixed precision. Both must be integers from 0 through 7.

## Native and issued assets

Native balances use `XLM`. Issued balances use the asset code and retain the validated issuer in the normalized result. Set `includeIssuer: true` when the display must disambiguate two assets that share a code.

## Missing and invalid values

`normalizeBalanceDisplay` is non-throwing for user balance data and returns one of:

- `ready`: valid exact amount and asset
- `missing`: balance is null, undefined, or blank
- `invalid`: malformed/unsafe balance input or invalid asset metadata

The default missing display is `— <ASSET>`; the default invalid display is `Invalid balance <ASSET>`. Use `missingLabel` / `invalidLabel` to localize those labels.

Programmer configuration errors (for example, 8 fraction digits or minimum greater than maximum) throw `RangeError` instead of silently changing requested precision.

## Existing wallet helper

`formatAssetBalanceDisplay` now delegates valid native and issued values to this shared normaliser. Its historical fixed-decimal shape is preserved by setting the normaliser's minimum and maximum display precision to the helper's `decimals` argument.
