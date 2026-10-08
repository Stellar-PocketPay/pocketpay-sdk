import { describe, it, expect } from 'vitest';
import {
  mapTransactionToSummary,
  mapTransactionsToSummaries,
} from '../../src/transactions/mapper';
import {
  TransactionDirection,
  TransactionStatus,
  RawHorizonTransaction,
} from '../../src/types/transaction';

const mockUserAccount = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

const mockIncomingTransaction: RawHorizonTransaction = {
  id: '1234567890',
  paging_token: '1234567890',
  tx_hash: '0xabcdef1234567890',
  created_at: '2024-01-15T10:30:00.000Z',
  source_account: 'GXYZ1234567890',
  fee_account: 'GXYZ1234567890',
  fee_charged: '100',
  memo_type: 'text',
  memo: 'Payment for services',
  successful: true,
  operations: [
    {
      id: '1234567890',
      source_account: 'GXYZ1234567890',
      type: 'payment',
      type_i: 1,
      created_at: '2024-01-15T10:30:00.000Z',
      transaction_hash: '0xabcdef1234567890',
      amount: '10.5',
      asset_type: 'native',
      from: 'GXYZ1234567890',
      to: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    },
  ],
};

const mockOutgoingTransaction: RawHorizonTransaction = {
  id: '9876543210',
  paging_token: '9876543210',
  tx_hash: '0x1234567890abcdef',
  created_at: '2024-01-16T11:30:00.000Z',
  source_account: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  fee_account: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  fee_charged: '100',
  memo_type: 'text',
  memo: 'Rent payment',
  successful: true,
  operations: [
    {
      id: '9876543210',
      source_account: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      type: 'payment',
      type_i: 1,
      created_at: '2024-01-16T11:30:00.000Z',
      transaction_hash: '0x1234567890abcdef',
      amount: '25.75',
      asset_type: 'native',
      from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      to: 'GXYZ1234567890',
    },
  ],
};

describe('Transaction Mapper', () => {
  describe('mapTransactionToSummary', () => {
    it('should map incoming transaction correctly', () => {
      const summary = mapTransactionToSummary(
        mockIncomingTransaction,
        { userAccount: mockUserAccount }
      );

      expect(summary.id).toBe(mockIncomingTransaction.id);
      expect(summary.txHash).toBe(mockIncomingTransaction.tx_hash);
      expect(summary.direction).toBe(TransactionDirection.INCOMING);
      expect(summary.amount).toBe('10.5');
      expect(summary.asset).toBe('XLM');
      expect(summary.counterparty).toBe('GXYZ1234567890');
      expect(summary.memo).toBe('Payment for services');
      expect(summary.status).toBe(TransactionStatus.COMPLETED);
      expect(summary.createdAt).toBe(mockIncomingTransaction.created_at);
      expect(summary.fee).toBe('100');
      expect(summary.rawType).toBe('payment');
    });

    it('should map outgoing transaction correctly', () => {
      const summary = mapTransactionToSummary(
        mockOutgoingTransaction,
        { userAccount: mockUserAccount }
      );

      expect(summary.id).toBe(mockOutgoingTransaction.id);
      expect(summary.txHash).toBe(mockOutgoingTransaction.tx_hash);
      expect(summary.direction).toBe(TransactionDirection.OUTGOING);
      expect(summary.amount).toBe('25.75');
      expect(summary.asset).toBe('XLM');
      expect(summary.counterparty).toBe('GXYZ1234567890');
      expect(summary.memo).toBe('Rent payment');
      expect(summary.status).toBe(TransactionStatus.COMPLETED);
    });

    it('should mark failed transactions correctly', () => {
      const failedTransaction = {
        ...mockIncomingTransaction,
        successful: false,
      };

      const summary = mapTransactionToSummary(
        failedTransaction,
        { userAccount: mockUserAccount }
      );

      expect(summary.status).toBe(TransactionStatus.FAILED);
    });

    it('should handle create_account operations', () => {
      const createAccountTx: RawHorizonTransaction = {
        ...mockIncomingTransaction,
        operations: [
          {
            id: '1234567890',
            source_account: 'GXYZ1234567890',
            type: 'create_account',
            type_i: 0,
            created_at: '2024-01-15T10:30:00.000Z',
            transaction_hash: '0xabcdef1234567890',
            starting_balance: '20.0',
            asset_type: 'native',
            from: 'GXYZ1234567890',
            to: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
          },
        ],
      };

      const summary = mapTransactionToSummary(
        createAccountTx,
        { userAccount: mockUserAccount }
      );

      expect(summary.amount).toBe('20.0');
      expect(summary.asset).toBe('XLM');
      expect(summary.direction).toBe(TransactionDirection.INCOMING);
    });

    it('should handle non-native assets', () => {
      const usdcTransaction = {
        ...mockIncomingTransaction,
        operations: [
          {
            ...mockIncomingTransaction.operations[0],
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GUSDC1234567890',
          },
        ],
      };

      const summary = mapTransactionToSummary(
        usdcTransaction,
        { userAccount: mockUserAccount }
      );

      expect(summary.asset).toBe('USDC');
    });

    it('should format amount display correctly', () => {
      const summary = mapTransactionToSummary(
        mockIncomingTransaction,
        {
          userAccount: mockUserAccount,
          formatAmounts: true,
        }
      );

      expect(summary.amountDisplay).toBeDefined();
      expect(typeof summary.amountDisplay).toBe('string');
    });

    it('formats large amounts exactly with the shared amount model (#307)', () => {
      const withAmount = (amount: string): RawHorizonTransaction => ({
        ...mockIncomingTransaction,
        operations: [{ ...mockIncomingTransaction.operations[0], amount }],
      });
      const display = (amount: string) =>
        mapTransactionToSummary(withAmount(amount), { userAccount: mockUserAccount }).amountDisplay;

      expect(display('10.5')).toBe('10.5000000');
      // parseFloat(...).toFixed(7) printed 922337203685.4775391 and 900719925.4740992.
      expect(display('922337203685.4775807')).toBe('922337203685.4775807');
      expect(display('900719925.4740993')).toBe('900719925.4740993');
      expect(display('not-a-number')).toBe('0.00');
    });

    it('should handle missing operations gracefully', () => {
      const emptyOpTransaction = {
        ...mockIncomingTransaction,
        operations: [],
      };

      const summary = mapTransactionToSummary(
        emptyOpTransaction,
        { userAccount: mockUserAccount }
      );

      expect(summary.direction).toBe(TransactionDirection.INCOMING);
      expect(summary.counterparty).toBe('Unknown');
      expect(summary.amount).toBe('0');
    });
  });

  describe('mapTransactionsToSummaries', () => {
    it('should map multiple transactions', () => {
      const summaries = mapTransactionsToSummaries(
        [mockIncomingTransaction, mockOutgoingTransaction],
        { userAccount: mockUserAccount }
      );

      expect(summaries).toHaveLength(2);
      expect(summaries[0].id).toBe(mockIncomingTransaction.id);
      expect(summaries[1].id).toBe(mockOutgoingTransaction.id);
    });

    it('should handle empty array', () => {
      const summaries = mapTransactionsToSummaries(
        [],
        { userAccount: mockUserAccount }
      );

      expect(summaries).toHaveLength(0);
    });
  });

  describe('timeAgo', () => {
    it('should return "Just now" for recent transactions', () => {
      const now = new Date().toISOString();
      const recentTx = {
        ...mockIncomingTransaction,
        created_at: now,
      };

      const summary = mapTransactionToSummary(
        recentTx,
        { userAccount: mockUserAccount }
      );

      expect(summary.timeAgo).toBe('Just now');
    });

    it('should return minutes ago for recent transactions', () => {
      const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const recentTx = {
        ...mockIncomingTransaction,
        created_at: past,
      };

      const summary = mapTransactionToSummary(
        recentTx,
        { userAccount: mockUserAccount }
      );

      expect(summary.timeAgo).toContain('minutes ago');
    });
  });
});
