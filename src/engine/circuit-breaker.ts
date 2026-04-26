/**
 * CircuitBreaker - Circuit breaker pattern for workflow failure management
 *
 * Provides a safety mechanism that stops the workflow when too many failures occur.
 * This prevents cascade failures and provides a hard stop for runaway error conditions.
 *
 * States:
 * - CLOSED: Normal operation, failure count < maxFailure
 * - OPEN: Circuit tripped, failure count >= maxFailure, requires explicit reset
 *
 * State Transitions:
 * - CLOSED → OPEN: When failureCount >= maxFailure
 * - OPEN → CLOSED: When recordSuccess() is called (after human review)
 * - Any → CLOSED: When reset() is called
 */

import type { WorkflowCircuitBreakerState } from "./types.js";

/**
 * CircuitBreaker implements the circuit breaker pattern for workflow failure management.
 * It tracks consecutive failures and opens the circuit when the threshold is reached.
 */
export class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailure?: string;
  private _isOpen: boolean = false;
  private openedAt?: string;
  private readonly maxFailure: number;

  /**
   * Creates a new CircuitBreaker instance.
   * @param maxFailure - The number of failures before the circuit opens (default: 12 from WorkflowSettings)
   */
  constructor(maxFailure: number = 12) {
    this.maxFailure = maxFailure;
  }

  /**
   * Records a failure and potentially opens the circuit.
   * If failure count reaches maxFailure, the circuit opens.
   * @param error - Optional error message to record
   */
  recordFailure(error?: string): void {
    this.failureCount++;
    this.lastFailure = new Date().toISOString();

    if (this.failureCount >= this.maxFailure) {
      this._isOpen = true;
      if (!this.openedAt) {
        this.openedAt = new Date().toISOString();
      }
      console.warn(`[CircuitBreaker] Circuit opened after ${this.failureCount} failures`);
    }
  }

  /**
   * Records a success and closes the circuit if it was open.
   * Only resets when coming from OPEN state, not on every success.
   */
  recordSuccess(): void {
    if (this._isOpen) {
      this.failureCount = 0;
      this._isOpen = false;
      this.openedAt = undefined;
      console.log(`[CircuitBreaker] Circuit closed after successful operation`);
    }
  }

  /**
   * Explicitly resets the circuit breaker to CLOSED state.
   * Resets failure count and clears all state.
   */
  reset(): void {
    this.failureCount = 0;
    this.lastFailure = undefined;
    this._isOpen = false;
    this.openedAt = undefined;
    console.log(`[CircuitBreaker] Circuit manually reset`);
  }

  /**
   * Returns whether the circuit is currently open.
   * @returns true if the circuit is open (failure count >= maxFailure)
   */
  isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Returns the current circuit breaker state.
   * @returns The current state including failure count and timestamps
   */
  getState(): WorkflowCircuitBreakerState {
    return {
      failureCount: this.failureCount,
      lastFailure: this.lastFailure,
      isOpen: this._isOpen,
      openedAt: this.openedAt,
    };
  }

  /**
   * Returns the current failure count.
   * @returns The number of consecutive failures recorded
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Loads a previously saved state into the circuit breaker.
   * Used for checkpoint/restore functionality.
   * Note: The saved state is restored exactly to support checkpoint/restore semantics.
   * If the saved state has isOpen=true, it remains open regardless of current maxFailure.
   * @param state - The saved circuit breaker state
   * @throws Error if state is null or undefined
   */
  loadState(state: WorkflowCircuitBreakerState): void {
    if (state === null || state === undefined) {
      throw new Error("[CircuitBreaker] loadState: state cannot be null or undefined");
    }
    this.failureCount = state.failureCount;
    this.lastFailure = state.lastFailure;
    this._isOpen = state.isOpen;
    this.openedAt = state.openedAt;
  }

  /**
   * Returns the current state formatted for persistence.
   * This is an alias for getState() for semantic clarity in persistence contexts.
   * @returns The current state suitable for saving
   */
  getStateForPersistence(): WorkflowCircuitBreakerState {
    return this.getState();
  }
}
