# Testnet account diagnostics

Use `diagnoseTestnetAccount(publicKey)` for a read-only Stellar Testnet account check.

It returns one of three states:

- `funded`: the account exists and includes its mapped account balance.
- `unfunded`: Horizon reports that the account is not activated.
- `unavailable`: the account state could not be determined.

The default lookup always uses Stellar's canonical Testnet Horizon endpoint and
`network: "testnet"`. Caller or environment Horizon URL overrides are ignored
for this helper so a testnet-only diagnostic cannot accidentally query Mainnet.
Other safe settings such as timeouts may still be provided through `config`.
The helper does not create accounts, call Friendbot, sign transactions, or submit
ledger changes.

For deterministic unit tests, inject a lookup:

```ts
const state = await diagnoseTestnetAccount(publicKey, {
  lookup: async (key) => ({ status: 'unfunded', publicKey: key }),
});
```

Repository fixtures use synthetic public keys and fake account-state responses.
No secret keys are included. Use `fundTestnetAccount` separately when a caller
intentionally wants Friendbot funding.
