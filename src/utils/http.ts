/**
 * HTTP helpers used by the e2e scheduling fixtures: a timeout-aware fetch and a
 * concurrency limiter.
 *
 * Depends on **Node built-ins only** — the global `fetch` and `AbortController`
 * that Node 18+ ships — so nothing here needs a package or a DSH runtime to be
 * exercised under `node --test`.
 *
 * Two rules the implementation sticks to:
 *   - a timeout must *abort* the request, not merely stop waiting for it. A
 *     caller that gives up while the socket stays open leaks the connection and
 *     keeps the server busy, which is exactly the failure mode a limit is meant
 *     to prevent;
 *   - the limiter must be a real queue: at the ceiling a caller waits, and a
 *     release hands its slot to the next waiter rather than letting it race.
 */

/** Default ceiling on in-flight requests, per the "at most two at a time" need. */
export const DEFAULT_MAX_CONCURRENT = 2

/**
 * Thrown when a request exceeds `timeout`.
 *
 * A dedicated class (not a generic `Error`) so a caller can distinguish "the
 * server said no" from "we stopped waiting", and so a test can assert on the
 * failure mode instead of matching a message string. `name` is set explicitly
 * because Node does not always preserve the class name across bundling.
 */
export class FetchTimeoutError extends Error {
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number
  /** The URL whose request was aborted. */
  readonly url: string

  constructor(url: string, timeoutMs: number) {
    super(`request to ${url} timed out after ${timeoutMs}ms`)
    this.name = 'FetchTimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

/** Options accepted by `fetchWithTimeout`. */
export interface FetchWithTimeoutOptions {
  /** Milliseconds before the request is aborted. `undefined` or `0` disables it. */
  timeout?: number
  /** Ceiling on concurrent requests; defaults to `DEFAULT_MAX_CONCURRENT`. */
  maxConcurrent?: number
  /** Passed through to `fetch` (method, headers, body, …). */
  init?: RequestInit
}

type Resolver = () => void

/**
 * A counting semaphore: permits in flight, FIFO waiters when exhausted.
 *
 * FIFO matters. A LIFO or random release would let a task that arrived late
 * jump ahead of one that has been waiting, and under sustained load the early
 * arrivals starve — a limit that produces starvation is not a limit.
 */
export class ConcurrencyLimiter {
  readonly #max: number
  #active = 0
  readonly #waiters: Resolver[] = []

  constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be a positive integer, got ${String(maxConcurrent)}`)
    }
    this.#max = maxConcurrent
  }

  /** Requests currently holding a permit. */
  get active(): number {
    return this.#active
  }

  /** Callers waiting for a permit. */
  get waiting(): number {
    return this.#waiters.length
  }

  /** The configured ceiling. */
  get maxConcurrent(): number {
    return this.#max
  }

  /**
   * Run `task` once a permit is available, releasing the permit afterwards.
   *
   * The `finally` is the only release path on purpose: a task that rejects must
   * not shrink the pool, or a few failures would leave the limiter permantently
   * full and every later caller waiting forever.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }

  /** Take a permit (waiting if needed); resolves with the release function. */
  acquire(): Promise<Resolver> {
    if (this.#active < this.#max) {
      this.#active += 1
      return Promise.resolve(this.#releaseOnce())
    }
    return new Promise<Resolver>(resolve => {
      // The waiter is resolved with its own release function, so the permit is
      // transferred directly instead of being released and re-granted.
      this.#waiters.push(() => resolve(this.#releaseOnce()))
    })
  }

  /**
   * A release that is idempotent.
   *
   * Double-releasing is the classic semaphore bug: it makes `active` drift below
   * the truth and silently admits an extra request, so the limit stops holding.
   */
  #releaseOnce(): Resolver {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
      const next = this.#waiters.shift()
      if (next !== undefined) {
        // Hand the freed slot straight to the next waiter; `active` is already
        // correct because the permit moved, not the count.
        this.#active += 1
        next()
      }
    }
  }
}

/** Run `task` under a fresh limiter of `maxConcurrent` permits. */
export function withConcurrencyLimit<T>(maxConcurrent: number, task: () => Promise<T>): Promise<T> {
  return new ConcurrencyLimiter(maxConcurrent).run(task)
}

/**
 * Limiters shared by every `fetchWithTimeout` call that asks for the same
 * ceiling, keyed by the ceiling value.
 *
 * The first version built a limiter *inside* each `fetchWithTimeout` call, which
 * made the option a per-request no-op: six calls each passing
 * `maxConcurrent: 2` held six independent permits and the server saw six
 * concurrent requests. A limit that only applies within one call cannot express
 * "at most two requests at a time", so the limiter has to outlive a call and be
 * keyed by the value that requests it.
 *
 * Keyed by value, not a single global: a caller that asks for 8 must get 8 and
 * not inherit whatever ceiling another part of the program chose. The map is
 * bounded by the distinct ceiling values actually used — in this plugin that is
 * one or two, never unbounded growth.
 */
const sharedLimiters = new Map<number, ConcurrencyLimiter>()

/**
 * The process-wide limiter for one ceiling value.
 *
 * Exported so a long-lived host can inspect it, and so tests can observe that
 * sharing really happened. Instances are never discarded: a limiter's state is
 * just a count, and dropping it would strand any caller already waiting on it.
 */
export function sharedLimiterFor(maxConcurrent: number): ConcurrencyLimiter {
  const existing = sharedLimiters.get(maxConcurrent)
  if (existing !== undefined) return existing
  const created = new ConcurrencyLimiter(maxConcurrent)
  sharedLimiters.set(maxConcurrent, created)
  return created
}

/**
 * Fetch `url`, aborting the request if it takes longer than `timeout`.
 *
 * `timeout` of `undefined` or `0` means "no deadline". When a deadline is set,
 * it is enforced on the *whole* request (headers and body): the timer is
 * cleared in a `finally`, so a fast response does not leave a live timer behind
 * that would keep the process alive or fire during the next test.
 *
 * The abort signal reaches `fetch` itself, so an in-flight request is actually
 * cancelled at the socket level — this is the difference between a timeout and
 * a "stop looking".
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeout, maxConcurrent = DEFAULT_MAX_CONCURRENT, init } = options
  // Shared across calls, not per call: see `sharedLimiterFor`. Building one here
  // would give every request its own ceiling and make the option do nothing.
  const limiter = sharedLimiterFor(maxConcurrent)

  return limiter.run(async () => {
    const hasDeadline = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    if (!hasDeadline) {
      return fetch(url, init)
    }

    const controller = new AbortController()
    // An existing caller signal must still work: aborting either one cancels.
    if (init?.signal !== undefined && init.signal !== null) {
      if (init.signal.aborted) controller.abort(init.signal.reason)
      else init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new FetchTimeoutError(url, timeout))
      }, timeout)
    })

    try {
      return await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline])
    } catch (caught) {
      // A rejected `fetch` because *we* aborted is a timeout, not a network
      // error — report the cause the caller set up, not whichever rejection
      // won the race.
      if (controller.signal.aborted) throw new FetchTimeoutError(url, timeout)
      throw caught
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  })
}
