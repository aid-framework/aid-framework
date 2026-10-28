/**
 * A single shared concurrency limiter for a generated application.
 *
 * `deployments.concurrency` produces exactly one {@link ConcurrencyLimiter}. The model
 * gateway, the tool executor and the agent engine's delegation all acquire it, so there
 * is one limiter -- not one per component -- and a single cap bounds every unit of work
 * the app performs concurrently.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { ConfigurationError } from './errors.js';

/**
 * Whether the current async context is already inside {@link ConcurrencyLimiter.run}.
 *
 * A fan-out worker holds a slot for its whole body, and that body's model and tool
 * calls acquire the same limiter. Acquiring twice would deadlock at a cap of one, so an
 * acquisition made while a slot is already held is a no-op: the work is already counted
 * against the cap above it. `AsyncLocalStorage` is the counterpart of the reference
 * runtime's `ContextVar` -- each worker has its own store, and a worker's store must not
 * leak to a sibling.
 */
const HELD = new AsyncLocalStorage<true>();

/** Whether this async context already holds a slot of the limiter it would acquire. */
export function holdsSlot(): boolean {
  return HELD.getStore() === true;
}

export class ConcurrencyLimiter {
  /** The cap this limiter was constructed with. */
  readonly limit: number;

  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConfigurationError(`concurrency must be at least 1, got ${limit}`);
    }
    this.limit = limit;
  }

  /** How many slots are held right now. Exposed so a caller can report the cap. */
  get inFlight(): number {
    return this.active;
  }

  /**
   * Hold one slot for the duration of a single unit of work.
   *
   * Errors and rejections release the slot: the `finally` below runs on both paths, so
   * a failed call cannot leak capacity. A waiter woken by a release is handed the slot
   * directly rather than rejoining the back of the queue, which keeps the counter from
   * briefly exceeding the cap.
   *
   * Nested acquisition inside an already-held slot yields at once rather than waiting:
   * the enclosing unit of work is already counted, and waiting would deadlock at a cap
   * of one, where the fan-out worker holding the only slot is the caller of the gateway
   * that wants it.
   */
  async run<T>(body: () => Promise<T> | T): Promise<T> {
    if (holdsSlot()) return body();
    await this.acquire();
    try {
      return await HELD.run(true, body);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot over without touching the count: the releaser's slot becomes the
      // waiter's, so no third party can slip in between release and wake and the counter
      // never rises above the cap. The waiter's own `finally` releases it in turn.
      next();
      return;
    }
    this.active -= 1;
  }
}
