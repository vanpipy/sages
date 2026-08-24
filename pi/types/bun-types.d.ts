// Type declarations for bun:test when running with tsc
// This allows tsc to understand bun:test imports

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  
  export interface TestOptions {
    timeout?: number;
    retry?: number;
  }

  /**
   * Runtime-only stub augmented to also expose the chainable
   * helpers (`skipIf`, `if`, `skip`, etc.) that the real Bun runtime
   * ships on `it` / `test`. The local `bun-types.d.ts` shim is kept
   * narrow so `tsc` understands bun:test imports without dragging
   * in the full bun-types package; this interface narrows the gap
   * just enough for conditional skipping patterns like
   * `it.skipIf(!existsSync(...))(...)`.
   */
  export interface TestFn {
    (name: string, fn: () => void | Promise<void>, options?: TestOptions): void;
    skipIf(condition: boolean): TestFn;
    if(condition: boolean): TestFn;
    skip: TestFn;
    only: TestFn;
    todo: TestFn;
    failing: TestFn;
  }

  export const it: TestFn;
  export const test: TestFn;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  
  export interface ExpectResult {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toContain(item: unknown): void;
    toHaveLength(length: number): void;
    toThrow(error?: unknown): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toMatch(regex: RegExp): void;
    toMatchObject(obj: object): void;
    toStrictEqual(obj: unknown): void;
  }
  
  export interface ExpectNotResult extends ExpectResult {}
  
  export interface Expect {
    (value: unknown): ExpectResult & { not: ExpectNotResult };
  }
  
  export const expect: Expect;
  export function mock(fn: unknown): unknown;
  export function spy(fn?: unknown): unknown;
}