# SDK Soroban Contract Invocation Client

The existing `createContractClient` and `createVaultClient` helpers validate a contract ID, encode declared Soroban parameter types, simulate a method call, and return typed SDK results. `readOnly` only simulates: it does not sign or submit. `invoke` builds and signs a transaction after simulation and sends it **once**, then queries the transaction hash for a final ledger result.

## Confirmation, timeouts, and safe retries

After a transaction is submitted, lack of an RPC confirmation is **not** proof of failure. `invoke` uses the configured `timeout` as an overall confirmation budget; repeated `NOT_FOUND` replies and confirmation endpoint exceptions return `{ success: false, status: 'pending', hash, errorCode: 'TX_STATUS_UNKNOWN' }`. The hash is preserved so the application can reconcile it against the Soroban RPC or explorer **before trying any new submission**. Do not automatically replay a previously signed invocation merely because status is unknown.

A ledger-confirmed `FAILED` response returns `status: 'failed'`, `errorCode: 'TX_STATUS_FAILED'`, and the submitted hash. A ledger-confirmed `SUCCESS` response returns the parsed return value. A failed simulation stops before signing and submitting. The initial network `sendTransaction` request has separate submission uncertainty semantics; this bounded confirmation change does not claim to resolve a transport failure before a hash was returned.

## Consumer example

```ts
const result = await client.invoke({
  method: 'deposit',
  params: { user: publicKey, amount: 100_00000n },
  signWith: signerSecret,
});

if (result.status === 'pending' && result.hash) {
  // Store the hash, show "confirmation pending", and query ledger state.
  // Never invoke deposit a second time just because polling timed out.
}
```

See `src/soroban/client-factory.ts` and `tests/contract-client-factory.test.ts` for the implementation and bounded confirmation examples.
