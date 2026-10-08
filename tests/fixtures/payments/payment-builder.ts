import { FixtureBuilder } from '../builders/fixture-builder';

export interface PaymentFixture {
  from: string;
  to: string;
  amount: string;
  asset: string;
  assetIssuer?: string;
  memo?: string;
  status: 'pending' | 'completed' | 'failed';
  txHash?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class PaymentBuilder extends FixtureBuilder<PaymentFixture> {
  constructor() {
    super();
    this.data = {
      from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      to: 'GXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVW',
      amount: '0.00',
      asset: 'XLM',
      status: 'pending',
      createdAt: new Date('2024-01-15T10:30:00.000Z'),
      updatedAt: new Date('2024-01-15T10:30:00.000Z'),
    };
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

  withTxHash(txHash: string): this {
    this.data.txHash = txHash;
    return this;
  }

  withError(error: string): this {
    this.data.error = error;
    return this;
  }

  build(): PaymentFixture {
    return {
      from: this.data.from!,
      to: this.data.to!,
      amount: this.data.amount!,
      asset: this.data.asset!,
      assetIssuer: this.data.assetIssuer,
      memo: this.data.memo,
      status: this.data.status!,
      txHash: this.data.txHash,
      error: this.data.error,
      createdAt: this.data.createdAt!,
      updatedAt: this.data.updatedAt!,
    };
  }

  validate(): boolean {
    return !!this.data.from && !!this.data.to && Number(this.data.amount) > 0;
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (!this.data.from) {
      errors.push('From address is required');
    }
    if (!this.data.to) {
      errors.push('To address is required');
    }
    if (!this.data.amount || Number(this.data.amount) <= 0) {
      errors.push('Amount must be greater than 0');
    }
    return errors;
  }
}
