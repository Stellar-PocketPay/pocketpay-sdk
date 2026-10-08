/**
 * Plain-value fixture copy. Builders own their data; neither a clone nor a
 * built fixture may share nested response objects, arrays or Date instances.
 * Intentionally only copies the plain JSON-style values used by test fixtures.
 */
export function cloneFixture<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(item => cloneFixture(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneFixture(item)]),
    ) as T;
  }
  return value;
}

export abstract class FixtureBuilder<T> {
  protected data: Partial<T> = {};

  abstract build(): T;
  abstract validate(): boolean;
  abstract getErrors(): string[];

  /** Reset to constructor defaults, not an incomplete empty payload. */
  reset(): this {
    const fresh = new (this.constructor as new () => FixtureBuilder<T>)();
    this.data = cloneFixture(fresh.data);
    return this;
  }

  set<K extends keyof T>(key: K, value: T[K]): this {
    this.data[key] = cloneFixture(value);
    return this;
  }

  merge(other: Partial<T>): this {
    this.data = { ...this.data, ...cloneFixture(other) };
    return this;
  }

  clone(): this {
    const copy = new (this.constructor as new () => FixtureBuilder<T>)() as this;
    copy.data = cloneFixture(this.data);
    return copy;
  }
}
