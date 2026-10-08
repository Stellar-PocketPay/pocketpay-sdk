import { FixtureBuilder, cloneFixture } from '../builders/fixture-builder';

export interface SorobanFixture {
  contractId: string;
  method: string;
  params?: any[];
  result?: any;
  error?: string;
  timeout: boolean;
  gasUsed: number;
}

export class SorobanBuilder extends FixtureBuilder<SorobanFixture> {
  constructor() {
    super();
    this.data = {
      contractId: 'CA1234567890ABCDEF',
      method: 'call',
      timeout: false,
      gasUsed: 1000,
    };
  }

  withContractId(contractId: string): this {
    this.data.contractId = contractId;
    return this;
  }

  withMethod(method: string): this {
    this.data.method = method;
    return this;
  }

  withParams(params: any[]): this {
    this.data.params = cloneFixture(params);
    return this;
  }

  withResult(result: any): this {
    this.data.result = cloneFixture(result);
    return this;
  }

  withError(error: string): this {
    this.data.error = error;
    return this;
  }

  withTimeout(timeout: boolean): this {
    this.data.timeout = timeout;
    return this;
  }

  withGasUsed(gasUsed: number): this {
    this.data.gasUsed = gasUsed;
    return this;
  }

  build(): SorobanFixture {
    return cloneFixture({
      contractId: this.data.contractId!,
      method: this.data.method!,
      params: this.data.params,
      result: this.data.result,
      error: this.data.error,
      timeout: this.data.timeout!,
      gasUsed: this.data.gasUsed!,
    });
  }

  validate(): boolean {
    return !!this.data.contractId && !!this.data.method;
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (!this.data.contractId) {
      errors.push('Contract ID is required');
    }
    if (!this.data.method) {
      errors.push('Method name is required');
    }
    return errors;
  }
}
