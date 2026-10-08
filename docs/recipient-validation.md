# Recipient validation and normalisation

PocketPay recipient helpers accept a direct Stellar address or a typed recipient
descriptor, validate it through the existing destination validator, and return a
canonical public key plus caller-supplied display metadata.

## Direct address

```ts
const result = validateRecipient('GBQ3...CADH');
```

## Saved contact

```ts
const result = validateRecipient({
  kind: 'saved_contact',
  publicKey: contact.publicKey,
  contactId: contact.id,
  name: contact.name,
});
```

## Destination metadata

```ts
const result = validateRecipient({
  kind: 'destination',
  address: destination.address,
  label: destination.label,
  metadata: { invoiceId: 'inv-42' },
});
```

Successful validation returns a `NormalizedRecipient` with a trimmed
`publicKey` and source discriminator. Invalid Stellar addresses return
`INVALID_PUBLIC_KEY`; malformed descriptor shapes return
`INVALID_RECIPIENT`.

Recipient `metadata` must be a plain key/value record (a normal object or
null-prototype dictionary). Runtime `Date`, `Map`, `Set`, arrays and custom
class instances are rejected as `INVALID_RECIPIENT` instead of being silently
flattened into empty or incomplete metadata.

Use `normalizeRecipient` when a call site requires the canonical value or
`validateRecipient` when it wants a non-throwing result.

## Payment intents

Existing `createPaymentIntent` calls continue to accept destination strings.
Recipient-aware callers can use `createPaymentIntentForRecipient`:

```ts
const intent = createPaymentIntentForRecipient({
  source,
  recipient: {
    kind: 'saved_contact',
    publicKey: contact.publicKey,
    contactId: contact.id,
    name: contact.name,
  },
  amount: '25.0000000',
  asset: { type: 'native', code: 'XLM' },
});
```

The helper stores the canonical address in `intent.destination`. Recipient
context is preserved under `intent.metadata.recipient`, and recipient memo
metadata is used only when the call does not provide an explicit memo.

Network account-state and trustline checks remain in the existing destination
validation APIs. Dynamic contact lookup remains application-owned; the SDK
normalises data after the application has resolved it.
