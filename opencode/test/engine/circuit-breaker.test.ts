/**
 * Unit Tests for CircuitBreaker
 * Tests circuit breaker pattern for workflow failure management
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { CircuitBreaker } from "../../src/engine/circuit-breaker";
import type { WorkflowCircuitBreakerState } from "../../src/engine/types";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(3);
  });

  describe("constructor", () => {
    it("should create CircuitBreaker with specified maxFailure", () => {
      const cb = new CircuitBreaker(5);
      expect(cb).toBeDefined();
      expect(cb.getFailureCount()).toBe(0);
      expect(cb.isOpen()).toBe(false);
    });

    it("should create CircuitBreaker with default maxFailure of 12", () => {
      const cb = new CircuitBreaker();
      expect(cb).toBeDefined();
      expect(cb.getFailureCount()).toBe(0);
      expect(cb.isOpen()).toBe(false);
    });
  });

  describe("recordFailure", () => {
    it("should increment failure count", () => {
      breaker.recordFailure("error 1");
      expect(breaker.getFailureCount()).toBe(1);
    });

    it("should trip circuit when failure count reaches maxFailure", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      expect(breaker.isOpen()).toBe(false);

      breaker.recordFailure("error 3");
      expect(breaker.isOpen()).toBe(true);
    });

    it("should update lastFailure timestamp", () => {
      breaker.recordFailure("test error");
      const state = breaker.getState();
      expect(state.lastFailure).toBeDefined();
    });

    it("should update openedAt when circuit opens", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");

      const state = breaker.getState();
      expect(state.isOpen).toBe(true);
      expect(state.openedAt).toBeDefined();
    });
  });

  describe("recordSuccess", () => {
    it("should reset failure count when coming from OPEN state", () => {
      // Trip the circuit
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");
      expect(breaker.isOpen()).toBe(true);

      // Record success to close circuit
      breaker.recordSuccess();
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it("should not reset failure count when circuit is CLOSED", () => {
      breaker.recordFailure("error 1");
      expect(breaker.getFailureCount()).toBe(1);

      breaker.recordSuccess();
      // Success while closed should NOT reset failure count
      expect(breaker.getFailureCount()).toBe(1);
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset circuit to CLOSED state", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");
      expect(breaker.isOpen()).toBe(true);

      breaker.reset();
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it("should reset from any state", () => {
      // Reset without opening
      breaker.reset();
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe("getState / loadState", () => {
    it("should return current state for persistence", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");

      const state = breaker.getState();
      expect(state.failureCount).toBe(2);
      expect(state.lastFailure).toBeDefined();
      expect(state.isOpen).toBe(false);
    });

    it("should return state with isOpen=true when tripped", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");

      const state = breaker.getState();
      expect(state.isOpen).toBe(true);
      expect(state.openedAt).toBeDefined();
    });

    it("should load state and restore circuit breaker", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");
      const savedState = breaker.getState();

      // Create new breaker and load state
      const newBreaker = new CircuitBreaker(3);
      newBreaker.loadState(savedState);

      expect(newBreaker.isOpen()).toBe(true);
      expect(newBreaker.getFailureCount()).toBe(3);
    });

    it("should load state with custom maxFailure", () => {
      const savedState: WorkflowCircuitBreakerState = {
        failureCount: 5,
        isOpen: true,
        lastFailure: new Date().toISOString(),
        openedAt: new Date().toISOString(),
      };

      const newBreaker = new CircuitBreaker(10);
      newBreaker.loadState(savedState);

      expect(newBreaker.getFailureCount()).toBe(5);
      expect(newBreaker.isOpen()).toBe(true);
    });

    it("should throw error when loading null state", () => {
      const newBreaker = new CircuitBreaker(3);
      expect(() => {
        newBreaker.loadState(null as any);
      }).toThrow("[CircuitBreaker] loadState: state cannot be null or undefined");
    });

    it("should throw error when loading undefined state", () => {
      const newBreaker = new CircuitBreaker(3);
      expect(() => {
        newBreaker.loadState(undefined as any);
      }).toThrow("[CircuitBreaker] loadState: state cannot be null or undefined");
    });
  });

  describe("getStateForPersistence", () => {
    it("should return same data as getState", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");

      const state = breaker.getState();
      const persistState = breaker.getStateForPersistence();

      expect(state.failureCount).toBe(persistState.failureCount);
      expect(state.lastFailure).toBe(persistState.lastFailure);
      expect(state.isOpen).toBe(persistState.isOpen);
      expect(state.openedAt).toBe(persistState.openedAt);
    });
  });

  describe("isOpen", () => {
    it("should return false when failure count is below maxFailure", () => {
      breaker.recordFailure("error 1");
      expect(breaker.isOpen()).toBe(false);
    });

    it("should return true when failure count equals maxFailure", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");
      expect(breaker.isOpen()).toBe(true);
    });

    it("should return true when failure count exceeds maxFailure", () => {
      breaker.recordFailure("error 1");
      breaker.recordFailure("error 2");
      breaker.recordFailure("error 3");
      breaker.recordFailure("error 4");
      expect(breaker.isOpen()).toBe(true);
    });
  });
});
