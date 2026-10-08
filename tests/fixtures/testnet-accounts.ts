import type { AccountBalance, BalanceResult } from '../../src';

const FUNDED_PUBLIC_KEY =
  'GBEAH7F3ZLH25C4W4TP5OXEQWUX6H2VKZPEHAXWQDL2PRKV3ALX4SKQC';
const UNFUNDED_PUBLIC_KEY =
  'GBD5FNAYLXT4PYRGWU2TI5KIKEB5RL3QF3JCT64LSDDGZ6IH7JFB4T5O';

const fundedBalance: AccountBalance = {
  publicKey: FUNDED_PUBLIC_KEY,
  nativeBalance: '25.0000000',
  balances: [
    {
      asset: 'XLM',
      balance: '25.0000000',
      issuer: '',
    },
  ],
};

/**
 * Synthetic Testnet fixtures. They contain public keys and fake Horizon-style
 * results only; no secret keys or funded credentials are included.
 */
export const testnetAccountFixtures = {
  funded: {
    publicKey: FUNDED_PUBLIC_KEY,
    result: {
      status: 'funded',
      publicKey: FUNDED_PUBLIC_KEY,
      balance: fundedBalance,
    } satisfies BalanceResult,
  },
  unfunded: {
    publicKey: UNFUNDED_PUBLIC_KEY,
    result: {
      status: 'unfunded',
      publicKey: UNFUNDED_PUBLIC_KEY,
    } satisfies BalanceResult,
  },
} as const;
