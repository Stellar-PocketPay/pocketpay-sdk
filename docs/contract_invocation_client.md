# SDK Soroban Contract Invocation Client

PocketPay's `createContractClient` is a reusable, typed entry point for
contract reads and signed state-changing calls. It validates the contract ID,
optionally checks the supported method schema, simulates every call, and maps
simulation/confirmation outcomes into stable SDK results.

## Read-only versus signed calls

Use `client.readOnly({ method, params, sourcePublicKey })` to simulate a
view method. Reads do **not** sign, submit or consume a sequence number.

Use `client.invoke({ method, params, signWith })` only for a method declared
as `kind: 'invoke'`. It simulates, assembles, signs and submits the transaction,
then queries Soroban RPC for finality. Neither API discovers arbitrary contract
methods: provide a supported method schema to reject missing/wrong-kind calls
before any network or signing step.

```ts
import { createContractClient } from 'stellar-pocketpay-sdk';

const client = createContractClient({
  contractId, // deployed, trusted C... contract ID
  methods: {
    get_balance: { kind: 'readOnly', paramTypes: { user: 'address' } },
    deposit: {
      kind: 'invoke',
      paramTypes: { user: 'address', amount: 'i128' },
    },
  },
});

const balance = await client.readOnly({
  method: 'get_balance',
  params: { user: publicKey },
  sourcePublicKey: publicKey,
});

const receipt = await client.invoke({
  method: 'deposit',
  params: { user: publicKey, amount: amountInStroops },
  signWith: sourceSecretKey,
});
```

Supply the private key only to the signing call, never to `params` or an
RPC diagnostic. Select a contract ID deployed on the same trusted network
configured for the SDK.

## Confirmation and unknown outcomes

A submitted Soroban transaction is **not** necessarily failed when its first
RPC `getTransaction(hash)` lookup returns `NOT_FOUND`. Both the reusable
client and the legacy `depositToVault` / `withdrawFromVault` helpers apply
one overall confirmation budget (the resolved `SDKConfig.timeout`, normally
30 seconds), waiting up to one second between lookups. Each lookup uses
only the budget remaining; an additional attempt bound guards unusual clocks.

| Observed result | Client outcome | Next action |
| --- | --- | --- |
| RPC `SUCCESS` | `success: true`, `status: 'success'` | Safe to treat as confirmed |
| RPC `FAILED` | `success: false`, `status: 'failed'` | Inspect error and the submitted hash |
| Repeated `NOT_FOUND`, exhausted budget, lookup failure or unexpected status | `success: false`, `status: 'pending'`, `errorCode: 'TX_STATUS_UNKNOWN'` | Query the original hash again later |
| Simulation failed before submission | `success: false` with a simulation error | No submission was made |

A pending/unknown result includes the original submitted `hash` whenever the
RPC accepted the transaction and returned one. A generic submission timeout
is also an unknown outcome, but may happen before the SDK receives a hash.

```ts
if (!receipt.success && receipt.status === 'pending') {
  // Do not build, sign or submit a second transfer here.
  // Persist receipt.hash (if present), display an unconfirmed state, and
  // query the same network's transaction status again before any retry.
}
```

Runtime RPC adapters may also return a malformed or `null` confirmation response, or a status accessor that throws. These are **unknown**, not proof of failure: the helper returns the pending receipt with the original submitted hash instead of throwing away the transaction identity.

There is no automatic submission retry in either Soroban confirmation path.
Do not convert an unknown confirmation into a failed payment or a zero balance.
A response `status: 'failed'` requires actual RPC `FAILED` finality, not a
poll timeout.

The unit cases in `tests/contract-client-factory.test.ts` cover method
validation, read-only signing separation, success and simulation errors;
`tests/soroban-finality-polling.test.ts` covers terminal responses and
bounded/unknown confirmation behavior. Those tests are independent of live RPC.
