# `src/utils/http.ts` — usage guide

A small, dependency-free HTTP toolkit used by the scheduling fixtures. Everything here runs on
**Node built-ins only** — the global `fetch` and `AbortController` that Node 18+ ships — so it needs
no package, no DSH host, and no network beyond whatever URL you point it at.

Two behaviours define the module, and the docs below are organised around them:

- **A timeout aborts the request.** It does not merely stop waiting. A caller that gives up while the
  socket stays open leaks the connection and keeps the server busy — exactly the failure a limit is
  meant to prevent.
- **The limiter is a real queue.** At the ceiling a caller waits, and a release hands its slot to the
  next waiter (FIFO) instead of letting it race.

---

## `fetchWithTimeout(url, options?)`

```ts
fetchWithTimeout(url: string, options?: FetchWithTimeoutOptions): Promise<Response>
```

Fetches `url` and resolves with the standard `Response`. If a deadline is set and reached, the
request is aborted at the socket level and the promise rejects with `FetchTimeoutError`.

### Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `timeout` | `number` | *(none)* | Milliseconds before the request is aborted. `undefined` or `0` means **no deadline**. |
| `maxConcurrent` | `number` | `DEFAULT_MAX_CONCURRENT` (`2`) | Ceiling for the limiter built for **this call** — see the warning below. |
| `init` | `RequestInit` | — | Passed through to `fetch`: `method`, `headers`, `body`, and so on. |

A `timeout` is only honoured when it is a finite number greater than zero. Negative values and `NaN`
also mean "no deadline", so a misconfigured timeout never aborts instantly by accident.

### Basic use

```ts
import { fetchWithTimeout } from '../src/utils/http.ts'

const response = await fetchWithTimeout('http://127.0.0.1:8080/health', { timeout: 2000 })
console.log(response.status)
```

### Passing your own request options

```ts
const response = await fetchWithTimeout(url, {
  timeout: 5000,
  init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
})
```

### Combined with your own cancellation

If `init.signal` is supplied, it is still honoured: aborting **either** your signal or the internal
deadline cancels the request. An already-aborted signal short-circuits before the request is made.

### Deadline coverage

The deadline applies to the **whole request** — headers and body. The internal timer is cleared in a
`finally`, so a fast response never leaves a live timer behind that would keep the process alive or
fire during a later test.

---

## Recognising a timeout: `FetchTimeoutError`

```ts
import { FetchTimeoutError } from '../src/utils/http.ts'

try {
  await fetchWithTimeout(url, { timeout: 100 })
} catch (error) {
  if (error instanceof FetchTimeoutError) {
    console.log(error.name)       // 'FetchTimeoutError'
    console.log(error.url)        // the URL that was aborted
    console.log(error.timeoutMs)  // the deadline that elapsed
  }
}
```

A dedicated class rather than a generic `Error` gives you three things:

- **Cause separation.** "The server said no" (a `Response` with a 4xx/5xx status) and "we stopped
  waiting" (a rejection) are different outcomes and should not be conflated.
- **Assertions on the failure mode**, not on message text.
- **A reliable `name`.** It is set explicitly because Node does not always preserve class names across
  bundling; prefer `instanceof FetchTimeoutError` and fall back to `error.name`.

A rejection caused by *our own* abort is always normalised to `FetchTimeoutError`, so the error you
catch names the cause you configured rather than whichever rejection happened to win the race.

> Network-level failures that are **not** timeouts (connection refused, DNS failure) propagate
> unchanged — they are not wrapped.

---

## Concurrency limiting: `ConcurrencyLimiter`

A counting semaphore with a FIFO waiter queue.

```ts
import { ConcurrencyLimiter } from '../src/utils/http.ts'

const limiter = new ConcurrencyLimiter(2)

const results = await Promise.all(
  urls.map(url => limiter.run(() => fetchWithTimeout(url, { timeout: 3000 }))),
)
```

### API

| Member | Meaning |
|---|---|
| `new ConcurrencyLimiter(maxConcurrent?)` | Defaults to `DEFAULT_MAX_CONCURRENT` (`2`). Throws `RangeError` for anything that is not a positive integer (`0`, `-1`, `1.5`). |
| `run<T>(task)` | Acquires a permit, runs `task`, always releases — including when `task` rejects. |
| `acquire()` | Raw permit control; resolves with an idempotent `release` function. |
| `active` | Permits currently held. |
| `waiting` | Callers queued for a permit. |
| `maxConcurrent` | The configured ceiling. |

### `withConcurrencyLimit(maxConcurrent, task)`

Shortcut for a one-shot limiter:

```ts
import { withConcurrencyLimit } from '../src/utils/http.ts'

const body = await withConcurrencyLimit(2, async () => {
  const response = await fetchWithTimeout(url, { timeout: 1000 })
  return response.text()
})
```

### Guarantees worth relying on

- **FIFO ordering.** Waiters are served in arrival order; there is no starvation and no late-arrival
  jumping ahead.
- **A failing task never leaks a permit.** Release happens in a `finally`, so a handful of rejections
  cannot leave the limiter full and every later caller waiting forever.
- **Release is idempotent.** Calling it twice does not drive `active` below the truth — the classic
  semaphore bug that silently admits an extra request.

---

## `maxConcurrent` is shared across calls

Passing `maxConcurrent` bounds concurrency **across every call that asks for the same ceiling**, not
just within one call. `fetchWithTimeout` resolves its limiter through `sharedLimiterFor(maxConcurrent)`,
which caches one `ConcurrencyLimiter` per ceiling value, so six calls each passing `maxConcurrent: 2`
run **two at a time**, not six:

```ts
// Bounded to 2 in flight, process-wide. This is the intended usage.
await Promise.all(urls.map(url => fetchWithTimeout(url, { maxConcurrent: 2 })))
```

Because the cache is keyed by the ceiling *value*, different ceilings do not interfere: a call asking
for `maxConcurrent: 8` gets eight slots and does not inherit the queue of a `maxConcurrent: 2` caller.

> **History worth knowing.** This was not always true. The first implementation built a limiter
> *inside* each call, which made the option a per-request no-op — six calls passing `maxConcurrent: 2`
> produced a server-side peak of **six**. The shipped tests did not catch it because they constructed
> a `ConcurrencyLimiter(2)` explicitly and wrapped each call in `limiter.run(...)`, bypassing
> `fetchWithTimeout` entirely: the test proved *the class works*, not *the function honours the option*.
> The regression is now pinned by a test that calls `fetchWithTimeout` directly and asserts a peak of
> at most 2.

If you need a limiter you control yourself — for example to `await limiter.acquire()` before doing
other work, or to inspect `active` / `waiting` — construct one and reuse it:

```ts
const limiter = new ConcurrencyLimiter(2)
const responses = await Promise.all(
  urls.map(url => limiter.run(() => fetchWithTimeout(url, { timeout: 3000 }))),
)
```

---

## Exports at a glance

| Export | Kind | Purpose |
|---|---|---|
| `DEFAULT_MAX_CONCURRENT` | `const number` | Default ceiling, `2`. |
| `FetchTimeoutError` | `class extends Error` | Deadline elapsed; carries `url` and `timeoutMs`. |
| `FetchWithTimeoutOptions` | `interface` | `timeout?`, `maxConcurrent?`, `init?`. |
| `ConcurrencyLimiter` | `class` | FIFO counting semaphore. |
| `withConcurrencyLimit` | `function` | One-shot limiter around a task. |
| `sharedLimiterFor` | `function` | The process-wide limiter for one ceiling value; used by `fetchWithTimeout`. |
| `fetchWithTimeout` | `function` | Fetch with an aborting deadline, bounded by the shared limiter. |

---

## Testing notes

`test/http.test.ts` covers this module. It runs entirely against a **local `http.createServer` on an
ephemeral port** — no external network, no fixed port — and closes each server in a `finally`, calling
`closeAllConnections()` as well so an aborted request can never leave a listening socket behind.

Two details worth knowing if you extend the tests:

- **Observe the abort from the server side.** The "timeout actually aborts" case listens for
  `req.on('aborted')` / a `close` with `writableEnded === false`; asserting only that the client
  rejected would pass even if the socket were still open.
- **Measure the limit at the server, not the client.** Peak occupancy is counted inside the request
  handler, so the assertion reflects real concurrent work rather than the client's own bookkeeping.
- **Call the function, not just the class.** The cross-call ceiling is pinned by a case that calls
  `fetchWithTimeout(url, { maxConcurrent: 2 })` directly and asserts a server-side peak of at most 2.
  A test that constructs `ConcurrencyLimiter` by hand would still pass if `fetchWithTimeout` silently
  ignored its own option — which is precisely the bug this case exists to catch.

Run them with:

```
npm test
# or, for this file only:
node --test --test-isolation=none test/http.test.ts
```
