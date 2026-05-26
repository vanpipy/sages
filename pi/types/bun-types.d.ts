// Type declarations for bun:test when running with tsc
// This allows tsc to understand bun:test imports

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  
  export interface TestOptions {
    timeout?: number;
    retry?: number;
  }
  
  export function it(name: string, fn: () => void | Promise<void>, options?: TestOptions): void;
  export function test(name: string, fn: () => void | Promise<void>, options?: TestOptions): void;
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