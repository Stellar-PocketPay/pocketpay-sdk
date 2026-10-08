import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  depositToVault,
  withdrawFromVault,
  getVaultBalance,
} from '../src/soroban/index';
import * as StellarSDK from '@stellar/stellar-sdk';
import { PocketPayError } from '../src/types';

// Documenting Mocked versus Real behavior:
// In a real environment, the SDK communicates with a live Horizon/Soroban RPC node.
// To ensure unit tests are fast and deterministic without relying on network state,
// we mock the StellarSDK classes (rpc.Server, Keypair, Contract, TransactionBuilder)
// to simulate the various network responses and error states the SDK must handle.
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  
  const mockServer = {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };

  const MockServerClass = vi.fn(() => mockServer);

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: MockServerClass,
      Api: {
        isSimulationError: vi.fn(),
      },
      assembleTransaction: vi.fn(),
    },
    Keypair: {
      fromSecret: vi.fn((secret) => {
        if (secret === 'invalid') throw new Error('Invalid secret');
        return { publicKey: () => 'GA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX', sign: vi.fn() };
      }),
      fromPublicKey: vi.fn((key) => {
        if (key === 'invalid') throw new Error('Invalid key');
        return {};
      }),
    },
    Contract: vi.fn(),
    TransactionBuilder: vi.fn(),
    nativeToScVal: vi.fn().mockReturnValue({ type: 'scVal' }),
    scValToNative: vi.fn(),
    BASE_FEE: '100',
  };
});

describe('Soroban Vault Methods Boundary Tests', () => {
  const mockSecret = 'SA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX'; // valid format secret length = 56
  const mockPublicKey = 'GA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX'; // valid format public key = 56
  const contractId = 'CA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX';
  const signedHash = 'cd'.repeat(32);
  
  let mockServer: any;
  let mockKeypair: any;
  let mockContract: any;
  let mockTxBuilder: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set up environment
    originalEnv = process.env;
    process.env = { ...originalEnv, VAULT_CONTRACT_ID: contractId };

    // Setup Server mock instance
    mockServer = new StellarSDK.rpc.Server('http://localhost');
    
    // Setup Keypair mock
    mockKeypair = {
      publicKey: vi.fn().mockReturnValue(mockPublicKey),
      sign: vi.fn(),
    };
    (StellarSDK.Keypair.fromSecret as any).mockImplementation((secret: string) => {
      if (secret === 'invalid') throw new Error('Invalid secret');
      return mockKeypair;
    });

    // Setup Contract mock
    mockContract = {
      call: vi.fn().mockReturnValue({ type: 'operation' }),
    };
    (StellarSDK.Contract as any).mockImplementation(() => mockContract);

    // Setup TransactionBuilder mock
    mockTxBuilder = {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({}),
    };
    (StellarSDK.TransactionBuilder as any).mockImplementation(() => mockTxBuilder);

    // Default successful path mocks
    mockServer.getAccount.mockResolvedValue({});
    (StellarSDK.rpc.Api.isSimulationError as any).mockReturnValue(false);
    mockServer.simulateTransaction.mockResolvedValue({
      result: { retval: { type: 'scVal' } } // For getBalance
    });
    
    // A signed Transaction exposes its envelope hash before submission.
    const mockPrepared = { sign: vi.fn(), hash: () => Buffer.from(signedHash, 'hex') };
    (StellarSDK.rpc.assembleTransaction as any).mockReturnValue({
      build: vi.fn().mockReturnValue(mockPrepared)
    });

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: signedHash });
    mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('depositToVault', () => {
    it('calls the "deposit" method on the contract', async () => {
      await depositToVault({ sourceSecret: mockSecret, amount: '10' });
      expect(mockContract.call).toHaveBeenCalledWith(
        'deposit',
        expect.anything(),
        expect.anything()
      );
    });

    it('validates input shapes (invalid secret)', async () => {
      await expect(depositToVault({ sourceSecret: 'invalid', amount: '10' })).rejects.toThrow(PocketPayError);
    });

    it('returns expected output shape on success', async () => {
      const result = await depositToVault({ sourceSecret: mockSecret, amount: '10' });
      expect(result).toMatchObject({ success: true, hash: signedHash, operation: 'deposit' });
    });

    it('maps simulation errors to PocketPayError / VaultResult', async () => {
      (StellarSDK.rpc.Api.isSimulationError as any).mockReturnValue(true);
      mockServer.simulateTransaction.mockResolvedValue({ error: 'sim-fail' });
      
      const result = await depositToVault({ sourceSecret: mockSecret, amount: '10' });
      expect(result).toMatchObject({ success: false, error: 'Simulation failed: sim-fail', status: 'simulation_error' });
    });

    it('wraps unhandled RPC errors in PocketPayError', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Network offline'));
      await expect(depositToVault({ sourceSecret: mockSecret, amount: '10' })).rejects.toThrowError(/Vault deposit failed/);
    });

    it('keeps the signed hash pending when submission times out before an RPC response', async () => {
      mockServer.sendTransaction.mockRejectedValue(new Error('socket timeout'));
      const result = await depositToVault({ sourceSecret: mockSecret, amount: '10' });
      expect(result).toMatchObject({
        success: false,
        status: 'pending',
        operation: 'deposit',
        hash: signedHash,
        errorCode: 'TX_STATUS_UNKNOWN',
      });
      expect(mockServer.sendTransaction).toHaveBeenCalledOnce();
      expect(mockServer.getTransaction).not.toHaveBeenCalled();
    });
  });

  describe('withdrawFromVault', () => {
    it('calls the "withdraw" method on the contract', async () => {
      await withdrawFromVault({ sourceSecret: mockSecret, amount: '5' });
      expect(mockContract.call).toHaveBeenCalledWith(
        'withdraw',
        expect.anything(),
        expect.anything()
      );
    });

    it('validates input shapes (invalid amount)', async () => {
      await expect(withdrawFromVault({ sourceSecret: mockSecret, amount: '-5' })).rejects.toThrow(PocketPayError);
    });

    it('returns expected output shape on success', async () => {
      const result = await withdrawFromVault({ sourceSecret: mockSecret, amount: '5' });
      expect(result).toMatchObject({ success: true, hash: signedHash, operation: 'withdraw' });
    });

    it('maps RPC send errors correctly', async () => {
      mockServer.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: 'tx_failed' });
      const result = await withdrawFromVault({ sourceSecret: mockSecret, amount: '5' });
      expect(result).toMatchObject({ success: false, error: 'Send error: tx_failed', status: 'failed' });
    });

    it('keeps the signed hash pending when submission times out before an RPC response', async () => {
      mockServer.sendTransaction.mockRejectedValue(new Error('socket timeout'));
      const result = await withdrawFromVault({ sourceSecret: mockSecret, amount: '5' });
      expect(result).toMatchObject({
        success: false,
        status: 'pending',
        operation: 'withdraw',
        hash: signedHash,
        errorCode: 'TX_STATUS_UNKNOWN',
      });
      expect(mockServer.sendTransaction).toHaveBeenCalledOnce();
      expect(mockServer.getTransaction).not.toHaveBeenCalled();
    });
  });

  describe('getVaultBalance', () => {
    it('calls the "get_balance" method on the contract', async () => {
      (StellarSDK as any).scValToNative.mockReturnValue(150000000n); // 15 XLM

      await getVaultBalance({ publicKey: mockPublicKey, contractId });
      expect(mockContract.call).toHaveBeenCalledWith(
        'get_balance',
        expect.anything()
      );
    });

    it('returns parsed XLM balance on success', async () => {
      (StellarSDK as any).scValToNative.mockReturnValue(150000000n);
      const result = await getVaultBalance({ publicKey: mockPublicKey, contractId });
      expect(result).toMatchObject({ success: true, balance: '15.0000000', operation: 'get_balance' });
    });

    it('validates missing public key', async () => {
      await expect(getVaultBalance({ publicKey: 'invalid', contractId })).rejects.toThrow(PocketPayError);
    });
    
    it('wraps timeout errors in PocketPayError', async () => {
      mockServer.getAccount.mockRejectedValue(new Error('Timeout'));
      await expect(getVaultBalance({ publicKey: mockPublicKey, contractId })).rejects.toThrowError(/Failed to query vault balance/);
    });
  });
});
