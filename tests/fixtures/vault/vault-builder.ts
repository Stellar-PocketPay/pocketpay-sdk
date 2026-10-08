import { FixtureBuilder } from '../builders/fixture-builder';

export interface VaultFixture {
  userId: string;
  amount: string;
  action: 'deposit' | 'withdraw' | 'lock' | 'unlock';
  status: 'pending' | 'completed' | 'failed';
  lockDuration?: number;
  lockId?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class VaultBuilder extends FixtureBuilder<VaultFixture> {
  constructor() {
    super();
    this.data = {
      userId: 'user_123',
      amount: '0.00',
      action: 'deposit',
      status: 'pending',
      createdAt: new Date('2024-01-15T10:30:00.000Z'),
      updatedAt: new Date('2024-01-15T10:30:00.000Z'),
    };
  }

  withUserId(userId: string): this {
    this.data.userId = userId;
    return this;
  }

  withAmount(amount: string): this {
    this.data.amount = amount;
    return this;
  }

  withAction(action: 'deposit' | 'withdraw' | 'lock' | 'unlock'): this {
    this.data.action = action;
    return this;
  }

  withStatus(status: 'pending' | 'completed' | 'failed'): this {
    this.data.status = status;
    return this;
  }

  withLockDuration(duration: number): this {
    this.data.lockDuration = duration;
    return this;
  }

  withLockId(lockId: string): this {
    this.data.lockId = lockId;
    return this;
  }

  withError(error: string): this {
    this.data.error = error;
    return this;
  }

  build(): VaultFixture {
    return {
      userId: this.data.userId!,
      amount: this.data.amount!,
      action: this.data.action!,
      status: this.data.status!,
      lockDuration: this.data.lockDuration,
      lockId: this.data.lockId,
      error: this.data.error,
      createdAt: this.data.createdAt!,
      updatedAt: this.data.updatedAt!,
    };
  }

  validate(): boolean {
    return !!this.data.userId && Number(this.data.amount) >= 0;
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (!this.data.userId) {
      errors.push('User ID is required');
    }
    if (!this.data.amount || Number(this.data.amount) < 0) {
      errors.push('Amount must be non-negative');
    }
    return errors;
  }
}
