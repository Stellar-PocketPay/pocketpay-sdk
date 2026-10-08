import { FixtureBuilder, cloneFixture } from '../builders/fixture-builder';

export interface NetworkFixture {
  status: number;
  data?: any;
  error?: string;
  headers?: Record<string, string>;
  timeout: boolean;
  latency: number;
}

export class NetworkBuilder extends FixtureBuilder<NetworkFixture> {
  constructor() {
    super();
    this.data = {
      status: 200,
      timeout: false,
      latency: 0,
    };
  }

  withStatus(status: number): this {
    this.data.status = status;
    return this;
  }

  withData(data: any): this {
    this.data.data = cloneFixture(data);
    return this;
  }

  withError(error: string): this {
    this.data.error = error;
    return this;
  }

  withHeaders(headers: Record<string, string>): this {
    this.data.headers = cloneFixture(headers);
    return this;
  }

  withTimeout(timeout: boolean): this {
    this.data.timeout = timeout;
    return this;
  }

  withLatency(latency: number): this {
    this.data.latency = latency;
    return this;
  }

  build(): NetworkFixture {
    return cloneFixture({
      status: this.data.status!,
      data: this.data.data,
      error: this.data.error,
      headers: this.data.headers,
      timeout: this.data.timeout!,
      latency: this.data.latency!,
    });
  }

  validate(): boolean {
    return this.data.status !== undefined;
  }

  getErrors(): string[] {
    const errors: string[] = [];
    if (this.data.status === undefined) {
      errors.push('Status is required');
    }
    return errors;
  }
}
