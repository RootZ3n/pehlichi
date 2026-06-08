/**
 * ITERATION BUDGET — prevent runaway agent loops.
 *
 * Thread-safe counter that caps how many driver calls an agent session can make.
 * When the budget is exhausted, the agent MUST stop and report what it accomplished.
 *
 * Ported from Hermes' iteration_budget.py concept, adapted for async.
 *
 * Usage:
 *   const budget = new IterationBudget(50);
 *   if (!budget.consume()) throw new Error("Budget exhausted");
 *   // ... on successful tool execution, optionally refund:
 *   budget.refund();
 */

export interface BudgetStatus {
  max: number;
  consumed: number;
  remaining: number;
  percentUsed: string;
}

export class IterationBudget {
  private _consumed = 0;
  private readonly _max: number;

  constructor(maxIterations: number) {
    if (maxIterations < 1) throw new Error("maxIterations must be >= 1");
    this._max = maxIterations;
  }

  get max(): number { return this._max; }
  get consumed(): number { return this._consumed; }
  get remaining(): number { return Math.max(0, this._max - this._consumed); }

  /** Consume one iteration. Returns true if allowed, false if budget exhausted. */
  consume(): boolean {
    if (this._consumed >= this._max) return false;
    this._consumed++;
    return true;
  }

  /** Refund one iteration (e.g., after a successful tool execution that was cheap). */
  refund(): void {
    if (this._consumed > 0) this._consumed--;
  }

  /** Get current status. */
  status(): BudgetStatus {
    return {
      max: this._max,
      consumed: this._consumed,
      remaining: this.remaining,
      percentUsed: `${((this._consumed / this._max) * 100).toFixed(1)}%`,
    };
  }

  /** Force-exhaust the budget (e.g., on critical error). */
  exhaust(): void {
    this._consumed = this._max;
  }
}
