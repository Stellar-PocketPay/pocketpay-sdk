import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  ContractClient,
  createContractClient,
  createVaultClient,
  PocketPayError,
  UnsupportedFeatureError,
} from '../src';

const mocks = vi.hoisted(() => {
  const server = {
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  };
  const contract = {
    call: vi.fn(),
  };
  const transactionBuilder = {
    addOperation: vi.fn(),
    setTimeout: vi.fn(),
    build: vi.fn(),
  };
  const preparedTransaction = {
    sign: vi.fn(),
  };

  return {
    server,
    contract,
    transactionBuilder,
    preparedTransaction,
    Server: vi.fn(),
    Contract: vi.fn(),
    TransactionBuilder: vi.fn(),
    fromSecret: vi.fn(),
    fromPublicKey: vi.fn(),
    isSimulationError: vi.fn(),
    assembleTransaction: vi.fn(),
    nativeToScVal: vi.fn(),
    scValToNative: vi.fn(),
  };
});

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: mocks.Server,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mocks.isSimulationError,
      },
      assembleTransaction: mocks.assembleTransaction,
    },
    Contract: mocks.Contract,
    TransactionBuilder: mocks.TransactionBuilder,
    Keypair: {
      ...actual.Keypair,
      fromSecret: mocks.fromSecret,
      fromPublicKey: mocks.fromPublicKey,
    },
    nativeToScVal: mocks.nativeToScVal,
    scValToNative: mocks.scValToNative,
  };
});

describe('Soroban contract client factory', () => {
  const contractId =
    'CA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX';
  const sourceSecret =
    'SA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX';
  const sourcePublicKey =
    'GA3XW4YQ3F53G4J7G2KJZ4XJY6K32Z5M3Q5H65EHQ6S7L3M3J2KJZ4XX';
  const methods = {
    get_balance: {
      kind: 'readOnly',
      paramTypes: { user: 'address' },
    },
    deposit: {
      kind: 'invoke',
      paramTypes: { user: 'address', amount: 'i128' },
    },
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.Server.mockReturnValue(mocks.server);
    mocks.Contract.mockReturnValue(mocks.contract);
    mocks.contract.call.mockReturnValue({ type: 'contractCall' });

    mocks.TransactionBuilder.mockReturnValue(mocks.transactionBuilder);
    mocks.transactionBuilder.addOperation.mockReturnThis();
    mocks.transactionBuilder.setTimeout.mockReturnThis();
    mocks.transactionBuilder.build.mockReturnValue({ type: 'transaction' });

    mocks.server.getAccount.mockResolvedValue({ sequence: '1' });
    mocks.isSimulationError.mockImplementation(
      (response: unknown) =>
        typeof response === 'object' &&
        response !== null &&
        'error' in response,
    );
    mocks.assembleTransaction.mockReturnValue({
      build: () => mocks.preparedTransaction,
    });
    mocks.server.sendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'transaction-hash',
    });
    mocks.server.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      returnValue: { value: 'confirmed' },
    });
    mocks.fromSecret.mockReturnValue({
      publicKey: () => sourcePublicKey,
    });
    mocks.fromPublicKey.mockReturnValue({});
    mocks.nativeToScVal.mockImplementation((value, options) => ({
      value,
      type: options?.type,
    }));
    mocks.scValToNative.mockImplementation((value) => value.value);
  });

  it('validates the contract ID before constructing an RPC client', () => {
    expect(() =>
      createContractClient({ contractId: 'not-a-contract-id' }),
    ).toThrow(PocketPayError);
    expect(mocks.Server).not.toHaveBeenCalled();
  });

  it('maps a successful read-only simulation without signing or submitting', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      result: { retval: { value: 150000000n } },
    });
    const client = createContractClient({ contractId, methods });

    const result = await client.readOnly<bigint>({
      method: 'get_balance',
      params: { user: sourcePublicKey },
      sourcePublicKey,
    });

    expect(result).toBe(150000000n);
    expect(mocks.server.simulateTransaction).toHaveBeenCalledOnce();
    expect(mocks.assembleTransaction).not.toHaveBeenCalled();
    expect(mocks.server.sendTransaction).not.toHaveBeenCalled();
    expect(mocks.fromSecret).not.toHaveBeenCalled();
  });

  it('maps a successful state-changing invocation to an SDK result', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      result: { retval: { value: undefined } },
    });
    const client = createContractClient({ contractId, methods });

    const result = await client.invoke<string>({
      method: 'deposit',
      params: { user: sourcePublicKey, amount: 10n },
      signWith: sourceSecret,
    });

    expect(result).toEqual({
      success: true,
      status: 'success',
      hash: 'transaction-hash',
      value: 'confirmed',
      simulationStatus: 'success',
      warnings: undefined,
    });
    expect(mocks.preparedTransaction.sign).toHaveBeenCalledOnce();
    expect(mocks.server.sendTransaction).toHaveBeenCalledOnce();
  });

  it('returns the submitted hash when confirmation RPC fails', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      result: { retval: { value: undefined } },
    });
    mocks.server.getTransaction.mockRejectedValue(new Error('temporary RPC outage'));
    const client = createContractClient({ contractId, methods });

    const result = await client.invoke({
      method: 'deposit',
      params: { user: sourcePublicKey, amount: 10n },
      signWith: sourceSecret,
    });

    expect(result).toMatchObject({
      success: false,
      status: 'pending',
      hash: 'transaction-hash',
      errorCode: 'TX_STATUS_UNKNOWN',
    });
    expect(mocks.server.sendTransaction).toHaveBeenCalledOnce();
    expect(mocks.server.getTransaction).toHaveBeenCalledOnce();
  });

  it('bounds perpetually missing confirmation without claiming failure', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      result: { retval: { value: undefined } },
    });
    mocks.server.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
    // Advance the apparent wall clock beyond the overall poll budget after
    // the first RPC reply, avoiding a real delay or a broad timing suite.
    const times = [0, 0, 60_000];
    const clock = vi.spyOn(Date, 'now').mockImplementation(
      () => times.shift() ?? 60_000,
    );
    try {
      const client = createContractClient({ contractId, methods });
      const result = await client.invoke({
        method: 'deposit',
        params: { user: sourcePublicKey, amount: 10n },
        signWith: sourceSecret,
      });

      expect(result).toMatchObject({
        success: false,
        status: 'pending',
        hash: 'transaction-hash',
        errorCode: 'TX_STATUS_UNKNOWN',
      });
      expect(mocks.server.sendTransaction).toHaveBeenCalledOnce();
      expect(mocks.server.getTransaction).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('maps contract-specific simulation failures consistently', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      error: 'insufficient balance',
    });
    const client = createContractClient(
      { contractId, methods },
      { 'insufficient balance': 'VAULT_INSUFFICIENT_BALANCE' },
    );

    const result = await client.invoke({
      method: 'deposit',
      params: { user: sourcePublicKey, amount: 10n },
      paramTypes: methods.deposit.paramTypes,
      signWith: sourceSecret,
    });

    expect(result).toEqual({
      success: false,
      status: 'simulation_error',
      error: 'Simulation failed: insufficient balance',
      errorCode: 'VAULT_INSUFFICIENT_BALANCE',
      simulationStatus: 'failed',
    });
    expect(mocks.assembleTransaction).not.toHaveBeenCalled();
    expect(mocks.server.sendTransaction).not.toHaveBeenCalled();
  });

  it('maps restore-required simulations as unsupported without signing', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      restorePreamble: { minResourceFee: '1', transactionData: {} },
    });
    const client = createContractClient({ contractId, methods });

    const result = await client.invoke({
      method: 'deposit',
      params: { user: sourcePublicKey, amount: '1' },
      signWith: sourceSecret,
    });

    expect(result).toMatchObject({
      success: false,
      status: 'simulation_error',
      simulationStatus: 'unsupported',
      errorCode: 'SOROBAN_SIMULATION_UNSUPPORTED',
    });
    expect(mocks.assembleTransaction).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods before account lookup or simulation', async () => {
    const client = createContractClient({ contractId, methods });
    const dynamicClient = client as unknown as ContractClient;

    await expect(
      dynamicClient.readOnly({
        method: 'missing_method',
        params: {},
        paramTypes: {},
        sourcePublicKey,
      }),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(mocks.server.getAccount).not.toHaveBeenCalled();
    expect(mocks.server.simulateTransaction).not.toHaveBeenCalled();
  });

  it('does not allow a read-only method through the signing path', async () => {
    const client = createContractClient({ contractId, methods });
    const dynamicClient = client as unknown as ContractClient;

    await expect(
      dynamicClient.invoke({
        method: 'get_balance',
        params: { user: sourcePublicKey },
        paramTypes: methods.get_balance.paramTypes,
        signWith: sourceSecret,
      }),
    ).rejects.toMatchObject({
      code: 'SDK_NOT_IMPLEMENTED',
      operation: 'get_balance',
    });
    expect(mocks.fromSecret).not.toHaveBeenCalled();
  });

  it('uses the signer public key as the vault contract address parameter', async () => {
    mocks.server.simulateTransaction.mockResolvedValue({
      result: { retval: { value: undefined } },
    });
    const vault = createVaultClient({ contractId });

    await vault.deposit(sourceSecret, '1');

    expect(StellarSDK.nativeToScVal).toHaveBeenCalledWith(sourcePublicKey, {
      type: 'address',
    });
    expect(StellarSDK.nativeToScVal).not.toHaveBeenCalledWith(sourceSecret, {
      type: 'address',
    });
  });
});
