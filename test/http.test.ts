/**
 * Tests for the HTTP helpers in `src/utils/http.ts`.
 *
 * Everything runs against a **local `http.createServer`** on an ephemeral port:
 * no real network, no fixed port, no external dependency. Each test starts its
 * own server and closes it in a `finally` (plus `closeAllConnections`) so a
 * failed assertion cannot leave a listening socket behind and hang the runner.
 *
 * Timing is the whole subject here, so the assertions are chosen to be robust
 * rather than precise: the timeout case uses a server that sleeps far longer
 * than the deadline, and the concurrency case measures the peak *server-side*
 * occupancy instead of trusting the client's own bookkeeping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConcurrencyLimiter, FetchTimeoutError, fetchWithTimeout } from '../src/utils/http.ts'

/**
 * Start a local server, hand its base URL to `run`, then tear it down.
 *
 * The teardown runs on every path, including a rejected assertion, and drops
 * keep-alive sockets too: `server.close()` alone waits for idle connections,
 * which is how a test that aborted a request can hang forever.
 */
async function withLocalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string, server: Server) => Promise<void>,
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Port 0 = let the OS pick a free port, so parallel runs never collide.
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, server)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('fetchWithTimeout returns the response body from a local server', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from local')
    },
    async baseUrl => {
      const response = await fetchWithTimeout(`${baseUrl}/`, { timeout: 1000 })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'hello from local')
    },
  )
})

test('without a timeout option the request still succeeds', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200)
      res.end('no deadline')
    },
    async baseUrl => {
      // No `timeout` at all: the helper must not invent a deadline.
      const response = await fetchWithTimeout(`${baseUrl}/`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'no deadline')
    },
  )
})

test('a timeout of 0 disables the deadline rather than aborting immediately', async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200)
      res.end('zero means off')
    },
    async baseUrl => {
      const response = await fetchWithTimeout(`${baseUrl}/`, { timeout: 0 })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'zero means off')
    },
  )
})

test('a slow server rejects with FetchTimeoutError', async () => {
  await withLocalServer(
    (_req, res) => {
      // Far longer than the deadline below: the point is that we stop waiting.
      setTimeout(() => {
        if (!res.writableEnded) res.end('too late')
      }, 5000).unref()
    },
    async baseUrl => {
      await assert.rejects(
        () => fetchWithTimeout(`${baseUrl}/slow`, { timeout: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof FetchTimeoutError, `expected FetchTimeoutError, got ${String(error)}`)
          assert.equal(error.name, 'FetchTimeoutError')
          assert.equal(error.timeoutMs, 100)
          assert.match(error.message, /timed out after 100ms/)
          return true
        },
      )
    },
  )
})

test('the timeout actually aborts the in-flight request', async () => {
  // Observed from the server side: the client hung up before we answered.
  let abortedResolve: (() => void) | undefined
  const aborted = new Promise<void>(resolve => {
    abortedResolve = resolve
  })

  await withLocalServer(
    (req, res) => {
      req.on('aborted', () => abortedResolve?.())
      res.on('close', () => {
        // `writableEnded === false` means the socket died mid-response.
        if (!res.writableEnded) abortedResolve?.()
      })
      // Never respond: only an abort can end this request.
    },
    async baseUrl => {
      await assert.rejects(() => fetchWithTimeout(`${baseUrl}/hang`, { timeout: 100 }), FetchTimeoutError)
      // If the abort had not reached the socket, this would time out forever.
      await Promise.race([
        aborted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('server never observed the aborted request')), 3000).unref()
        }),
      ])
    },
  )
})

test('maxConcurrent=2 keeps at most two requests in flight at the server', async () => {
  let active = 0
  let peak = 0

  await withLocalServer(
    (_req, res) => {
      active += 1
      peak = Math.max(peak, active)
      setTimeout(() => {
        active -= 1
        if (!res.writableEnded) res.end('done')
      }, 40).unref()
    },
    async baseUrl => {
      // One fetchWithTimeout call owns one limiter, so the ceiling applies to
      // these five requests sharing that call's limiter: they are issued
      // through independent calls here, so the limiter is shared explicitly.
      const limiter = new ConcurrencyLimiter(2)
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) => limiter.run(() => fetchWithTimeout(`${baseUrl}/item/${index}`))),
      )
      assert.equal(responses.length, 5)
      assert.ok(peak <= 2, `server-side peak concurrency should be <= 2, got ${peak}`)
      assert.ok(peak >= 1, 'the requests did reach the server')
    },
  )
})

test('the limit does not change results: all five requests succeed in order', async () => {
  await withLocalServer(
    (req, res) => {
      // Answer with the path so the body can be matched to the request.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(req.url ?? '')
    },
    async baseUrl => {
      const limiter = new ConcurrencyLimiter(2)
      const bodies = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const response = await limiter.run(() => fetchWithTimeout(`${baseUrl}/item/${index}`))
          return response.text()
        }),
      )
      // `Promise.all` preserves input order regardless of completion order, so
      // a queued request that resolved late still lands in its own slot.
      assert.deepEqual(bodies, ['/item/0', '/item/1', '/item/2', '/item/3', '/item/4'])
      assert.equal(limiter.active, 0)
      assert.equal(limiter.waiting, 0)
    },
  )
})

test('the limiter is FIFO and releases a permit to the next waiter', async () => {
  const limiter = new ConcurrencyLimiter(1)
  const order: number[] = []
  const jobs = Array.from({ length: 4 }, async (_, index) => {
    await limiter.run(async () => {
      order.push(index)
      await new Promise(resolve => setTimeout(resolve, 5))
    })
  })
  await Promise.all(jobs)
  assert.deepEqual(order, [0, 1, 2, 3], 'waiters must be served in arrival order')
  assert.equal(limiter.active, 0)
})

test('a rejected task still releases its permit', async () => {
  const limiter = new ConcurrencyLimiter(1)
  await assert.rejects(() => limiter.run(async () => {
    throw new Error('boom')
  }))
  assert.equal(limiter.active, 0, 'a failure must not leak a permit')
  // And the slot is usable again.
  assert.equal(await limiter.run(async () => 'ok'), 'ok')
})

test('a non-positive concurrency ceiling is rejected', () => {
  assert.throws(() => new ConcurrencyLimiter(0), RangeError)
  assert.throws(() => new ConcurrencyLimiter(-1), RangeError)
})

test('maxConcurrent applies across separate fetchWithTimeout calls, not per call', async () => {
  // The bug this pins: `fetchWithTimeout` used to build a fresh limiter per
  // call, so six calls each passing `maxConcurrent: 2` had six independent
  // ceilings and the server saw all six at once. The limit must be a property
  // of the *option value*, shared by every call that asks for it — otherwise
  // the intuitive usage silently does nothing.
  //
  // Deliberately calls `fetchWithTimeout` directly (no shared ConcurrencyLimiter
  // in the test): the earlier concurrency test exercised the class, which is why
  // this defect slipped through it.
  let active = 0
  let peak = 0

  await withLocalServer(
    (_req, res) => {
      active += 1
      peak = Math.max(peak, active)
      setTimeout(() => {
        active -= 1
        if (!res.writableEnded) res.end('done')
      }, 40).unref()
    },
    async baseUrl => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          fetchWithTimeout(`${baseUrl}/item/${index}`, { maxConcurrent: 2 })),
      )
      assert.equal(responses.length, 6)
      assert.ok(peak <= 2, `server-side peak should be <= 2 across separate calls, got ${peak}`)
      assert.ok(peak >= 1, 'the requests did reach the server')
    },
  )
})

test('separate calls with different maxConcurrent get separate ceilings', async () => {
  // Sharing is per value, not global: a call that asks for a wider ceiling must
  // not be throttled by the ones asking for a narrow one.
  let active = 0
  const peaks = new Map<number, number>()

  await withLocalServer(
    (_req, res) => {
      active += 1
      peaks.set(8, Math.max(peaks.get(8) ?? 0, active))
      setTimeout(() => {
        active -= 1
        if (!res.writableEnded) res.end('done')
      }, 30).unref()
    },
    async baseUrl => {
      // The width-8 group goes last so it cannot be throttled by the width-2
      // group's own queue: each group measures its own ceiling independently.
      const narrow = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          fetchWithTimeout(`${baseUrl}/a/${index}`, { maxConcurrent: 2 })),
      )
      const narrowPeak = peaks.get(8) ?? 0
      peaks.set(8, 0)
      const wide = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          fetchWithTimeout(`${baseUrl}/b/${index}`, { maxConcurrent: 8 })),
      )
      const widePeak = peaks.get(8) ?? 0
      assert.equal(narrow.length, 4)
      assert.equal(wide.length, 4)
      assert.ok(narrowPeak <= 2, `width-2 group peak should be <= 2, got ${narrowPeak}`)
      // A wider ceiling is honoured, so the caches are keyed by value.
      assert.ok(widePeak >= 2, `width-8 group should be allowed above 2, got ${widePeak}`)
    },
  )
})
