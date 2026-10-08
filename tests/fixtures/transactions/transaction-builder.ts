import { FixtureBuilder } from '../builders/fixture-builder';

export interface TransactionFixture {
  hash: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  assetIssuer?: string;
  memo?: string;
  status: 'pending' | 'completed' | 'failed';
  fee?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class TransactionBuilder extends FixtureBuilder<TransactionFixture> {
  constructor() {
    super();
    this.data = {
      hash: '0x' + '0'.repeat(64),
      from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      to: 'GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW',
      amount: '0.00',
      asset: 'XLM',
      status: 'pending',
      createdAt: new Date('2024-01-15T10:30:00.000Z'),
      updatedAt: new Date('2024-01-15T10:30:00.000Z'),
    };
  }

  withHash(hash: string): this {
    this.data.hash = hash;
    return this;
  }

  withFrom(from: string): this {
    this.data.from = from;
    return this;
  }

  withTo(to: string): this {
    this.data.to = to;
    return this;
  }

  withAmount(amount: string): this {
    this.data.amount = amount;
    return this;
  }

  withAsset(asset: string): this {
    this.data.asset = asset;
    return this;
  }

  withAssetIssuer(issuer: string): this {
    this.data.assetIssuer = issuer;
    return this;
  }

  withMemo(memo: string): this {
    this.data.memo = memo;
    return this;
  }

  withStatus(status: 'pending' | 'completed' | 'failed'): this {
    this.data.status = status;
    return this;
  }

  withFee(fee: string): this {
    this.data.fee = fee;
    return this;
  }

  withError(error: string): this {
    this.data.error = error;
    return this;
  }

  build(): TransactionFixture {
    return {
      hash: this.data.hash!,
      from: this.data.from!,
      to: this.data.to!,
      amount: this.data.amount!,
      asset: this.data.asset!,
      assetIssuer: this.data.assetIssuer,
      memo: this.data.memo,
      status: this.data.status!,
      fee: this.data.fee,
      error: this.data.error,
      createdAt: this.data.createdAt!,
      updatedAt: this.data.updatedAt!,
    };
  }

  validate(): boolean {
    return !!this.data.hash && !!this.data.from && !!this.data.to;
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (!this.data.hash) {
      errors.push('Transaction hash is required');
    }
    if (!this.data.from) {
      errors.push('From address is required');
    }
    if (!this.data.to) {
      errors.push('To address is required');
    }
    return errors;
  }
}
