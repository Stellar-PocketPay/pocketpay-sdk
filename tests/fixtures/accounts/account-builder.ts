import { FixtureBuilder } from '../builders/fixture-builder';

export interface AccountFixture {
  id: string;
  balance: string;
  sequence: number;
  exists: boolean;
  frozen: boolean;
  pendingTransaction: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AccountBuilder extends FixtureBuilder<AccountFixture> {
  constructor() {
    super();
    this.data = {
      id: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      balance: '0.00',
      sequence: 0,
      exists: true,
      frozen: false,
      pendingTransaction: false,
      createdAt: new Date('2024-01-15T10:30:00.000Z'),
      updatedAt: new Date('2024-01-15T10:30:00.000Z'),
    };
  }

  withId(id: string): this {
    this.data.id = id;
    return this;
  }

  withBalance(balance: string): this {
    this.data.balance = balance;
    return this;
  }

  withSequence(sequence: number): this {
    this.data.sequence = sequence;
    return this;
  }

  withExists(exists: boolean): this {
    this.data.exists = exists;
    return this;
  }

  withFrozen(frozen: boolean): this {
    this.data.frozen = frozen;
    return this;
  }

  withPendingTransaction(pending: boolean): this {
    this.data.pendingTransaction = pending;
    return this;
  }

  build(): AccountFixture {
    return {
      id: this.data.id!,
      balance: this.data.balance!,
      sequence: this.data.sequence!,
      exists: this.data.exists!,
      frozen: this.data.frozen!,
      pendingTransaction: this.data.pendingTransaction!,
      createdAt: this.data.createdAt!,
      updatedAt: this.data.updatedAt!,
    };
  }

  validate(): boolean {
    return !!this.data.id && this.data.id.startsWith('G');
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (!this.data.id) {
      errors.push('Account ID is required');
    }
    if (!this.data.id?.startsWith('G')) {
      errors.push('Account ID must start with G');
    }
    return errors;
  }
}
