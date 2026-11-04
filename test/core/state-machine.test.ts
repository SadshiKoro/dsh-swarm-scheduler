/**
 * Core state-machine tests: the six-state derivations and the ready-pool cap.
 *
 * No DSH import: this file exercises `src/core/state-machine.ts` alone, which is
 * the point of the core split.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blankTask,
  coerceTask,
  computeReady,
  compareReadyOrder,
  viewOf,
  viewsOf,
  type TaskRecord,
} from '../../src/core/state-machine.ts'

function byId(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map(task => [task.task_id, task]))
}

test('viewOf marks only pending-with-completed-blockers as ready', () => {
  const blocker = blankTask('a', { status: 'pending' })
  const task = blankTask('b', { blocked_by: ['a'] })
  const map = byId([blocker, task])
  assert.equal(viewOf(task, map).ready, false)

  blocker.status = 'completed'
  assert.equal(viewOf(task, byId([blocker, task])).ready, true)
})

test('viewOf derives running and heartbeat ages for a running task', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 30_000).toISOString(),
    started_at: new Date(now - 20_000).toISOString(),
    heartbeat_at: new Date(now - 5_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.status, 'running')
  assert.equal(view.claimed_age_sec, 30)
  assert.equal(view.running_age_sec, 20)
  assert.equal(view.heartbeat_age_sec, 5)
  assert.equal(view.stale, false)
})

test('viewOf marks a running task stale past the threshold', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 20 * 60_000).toISOString(),
    started_at: new Date(now - 20 * 60_000).toISOString(),
    heartbeat_at: new Date(now - 20 * 60_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.stale, true)
})

test('viewOf keeps failed/blocked task retry metadata', () => {
  const task = blankTask('f', { status: 'failed', retry_count: 2, max_retries: 3, failure_reason: 'boom' })
  const view = viewsOf([task])[0] as ReturnType<typeof viewOf>
  assert.equal(view.status, 'failed')
  assert.equal(view.retry_count, 2)
  assert.equal(view.failure_reason, 'boom')
  assert.equal(view.ready, false)
})

test('computeReady returns ready tasks below the worker ceiling', () => {
  const tasks = [blankTask('a'), blankTask('b'), blankTask('c', { status: 'claimed', claimed_by: 'w1' })]
  const result = computeReady(tasks, 3)
  assert.equal(result.limited, false)
  assert.deepEqual(result.tasks.map(task => task.task_id).sort(), ['a', 'b'])
})

test('computeReady returns zero and limited when claimed+running reaches max_workers', () => {
  const tasks = [
    blankTask('a', { status: 'claimed', claimed_by: 'w1' }),
    blankTask('b', { status: 'running', claimed_by: 'w2' }),
    blankTask('c'),
  ]
  const result = computeReady(tasks, 2)
  assert.equal(result.limited, true)
  assert.equal(result.total, 0)
  assert.equal(result.tasks.length, 0)
  // The reason must be produced by the core, not improvised by the adapter:
  // v0.3.0 shipped a second source that shadowed it.
  assert.equal(result.notice, 'max_workers limit (2) reached')
})

test('computeReady carries no notice below the ceiling', () => {
  const result = computeReady([blankTask('a')], 3)
  assert.equal(result.limited, false)
  assert.equal(result.notice, undefined)
})

test('computeReady still returns ready tasks when ceiling is disabled (0)', () => {
  const tasks = [blankTask('a'), blankTask('b', { status: 'running' })]
  const result = computeReady(tasks, 0)
  assert.equal(result.limited, false)
  assert.equal(result.total, 1)
})

test('computeReady honours the big_task_id filter', () => {
  const tasks = [blankTask('a', { big_task_id: 'T1' }), blankTask('b', { big_task_id: 'T2' })]
  const result = computeReady(tasks, 3, 'T2')
  assert.deepEqual(result.tasks.map(task => task.task_id), ['b'])
})

// ------------------------------------------------------- priority ordering ---

test('computeReady orders by priority descending', () => {
  const tasks = [
    blankTask('low', { priority: 0, created_at: '2026-01-01T00:00:00.000Z' }),
    blankTask('high', { priority: 10, created_at: '2026-01-03T00:00:00.000Z' }),
    blankTask('mid', { priority: 5, created_at: '2026-01-02T00:00:00.000Z' }),
  ]
  const result = computeReady(tasks, 3)
  assert.deepEqual(result.tasks.map(task => task.task_id), ['high', 'mid', 'low'])
})

test('computeReady orders equal priorities by created_at ascending (FIFO)', () => {
  const tasks = [
    blankTask('later', { priority: 3, created_at: '2026-02-01T12:00:00.000Z' }),
    blankTask('earlier', { priority: 3, created_at: '2026-02-01T08:00:00.000Z' }),
  ]
  const result = computeReady(tasks, 3)
  assert.deepEqual(result.tasks.map(task => task.task_id), ['earlier', 'later'])
})

test('computeReady falls back to task_id when created_at is missing', () => {
  const tasks = [
    blankTask('zeta', { priority: 1, created_at: '' }),
    blankTask('alpha', { priority: 1, created_at: '' }),
  ]
  const result = computeReady(tasks, 3)
  assert.deepEqual(result.tasks.map(task => task.task_id), ['alpha', 'zeta'])
})

test('compareReadyOrder keeps priority above FIFO', () => {
  const older = blankTask('older', { priority: 0, created_at: '2026-01-01T00:00:00.000Z' })
  const newer = blankTask('newer', { priority: 5, created_at: '2026-03-01T00:00:00.000Z' })
  assert.ok(compareReadyOrder(newer, older) < 0)
})

// ------------------------------------------------- lease-based staleness ---

test('a running task with a fresh heartbeat is not stale despite an old claim', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 20 * 60_000).toISOString(),
    started_at: new Date(now - 20 * 60_000).toISOString(),
    heartbeat_at: new Date(now - 1_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.stale, false)
  assert.equal(view.claimed_age_sec, 1200)
  assert.equal(view.heartbeat_age_sec, 1)
})

test('a running task with an old heartbeat is stale', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 20 * 60_000).toISOString(),
    started_at: new Date(now - 20 * 60_000).toISOString(),
    heartbeat_at: new Date(now - 20 * 60_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.stale, true)
})

test('a claimed task with a fresh heartbeat is not stale despite an old claim', () => {
  const now = Date.now()
  const task = blankTask('c', {
    status: 'claimed',
    claimed_by: 'worker-a',
    claimed_at: new Date(now - 20 * 60_000).toISOString(),
    heartbeat_at: new Date(now - 2_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.stale, false)
})

// ---------------------------------------------------------------- overdue ---

/** A running task whose start is `elapsedMs` in the past. */
function runningTask(elapsedMs: number, maxDurationMs: number): TaskRecord {
  return blankTask('r', {
    status: 'running',
    claimed_by: 'worker-a',
    claimed_at: new Date(Date.now() - elapsedMs).toISOString(),
    started_at: new Date(Date.now() - elapsedMs).toISOString(),
    heartbeat_at: new Date().toISOString(),
    max_duration_ms: maxDurationMs,
  })
}

test('overdue is false when max_duration_ms is 0 (no budget declared)', () => {
  const task = runningTask(10 * 60_000, 0)
  assert.equal(viewOf(task, byId([task]), Date.now(), 600).overdue, false)
})

test('overdue is false while the run is inside its budget', () => {
  const task = runningTask(60_000, 5 * 60_000)
  assert.equal(viewOf(task, byId([task]), Date.now(), 600).overdue, false)
})

test('overdue is true once the run exceeds its budget', () => {
  const task = runningTask(10 * 60_000, 5 * 60_000)
  assert.equal(viewOf(task, byId([task]), Date.now(), 600).overdue, true)
})

test('overdue and stale are independent: a heartbeating overdue task is stale-free', () => {
  // The whole point of the marker: a worker can be perfectly alive and still
  // be stuck on the wrong problem. A watchdog cannot tell you that; this can.
  const task = runningTask(10 * 60_000, 5 * 60_000)
  const view = viewOf(task, byId([task]), Date.now(), 600)
  assert.equal(view.overdue, true)
  assert.equal(view.stale, false)
})

test('overdue never fires for a task that is not running', () => {
  // A pending task has no start time, so nothing can be measured against it.
  // Flagging it would be a guess, and a guess here means a false interruption.
  const pending = blankTask('p', { status: 'pending', max_duration_ms: 1 })
  assert.equal(viewOf(pending, byId([pending]), Date.now(), 600).overdue, false)

  const completed = blankTask('done', {
    status: 'completed',
    started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    max_duration_ms: 1,
  })
  assert.equal(viewOf(completed, byId([completed]), Date.now(), 600).overdue, false)
})

test('max_duration_ms survives a JSON round-trip through coerceTask', () => {
  // The field lives in a hand-written JSON file, so the loader must keep it —
  // a field that vanishes on read is a silent no-op budget.
  const task = blankTask('rt', { max_duration_ms: 90_000 })
  const revived = coerceTask(JSON.parse(JSON.stringify(task)), 'rt')
  assert.equal(revived?.max_duration_ms, 90_000)
})

test('coerceTask rejects a negative max_duration_ms rather than trusting it', () => {
  const task = blankTask('neg', { max_duration_ms: -5 })
  const revived = coerceTask(JSON.parse(JSON.stringify(task)), 'neg')
  assert.equal(revived?.max_duration_ms, 0)
})
