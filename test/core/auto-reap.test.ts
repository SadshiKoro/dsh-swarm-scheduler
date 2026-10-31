/**
 * Pure-logic tests for the event-driven watchdog.
 *
 * `autoReap` is deliberately host-free: it takes the store and a threshold, so
 * these tests cover the whole decision — which tasks are stale, what they become,
 * what is logged — without any Cordis event, timer or debounce involved. The host
 * wiring (agent/status → debounce → autoReap) is exercised in the live session.
 *
 * The lease has two phases (v1.0.0 P3): warning (`ageSec > staleAfterSec`) and
 * hard reap (`ageSec > 1.5 × staleAfterSec`). `FIXTURE_CLOCK` freezes the
 * reaper's clock so each phase can be pinned by writing an exact heartbeat age
 * instead of sleeping.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  STALE_WARNING_REASON,
  TASKS_DIR,
  TaskStore,
  blankTask,
  claimTask,
  heartbeatTask,
  startTask,
  type TaskRecord,
} from '../../src/core/task-store.ts'
import { autoReap } from '../../src/core/auto-reap.ts'

let dir: string
let store: TaskStore

const OLD = () => new Date('2020-01-01T00:00:00Z')

/** The reaper's "now" for the phase tests; heartbeat ages are set relative to it. */
const NOW_MS = Date.parse('2026-01-01T12:00:00Z')
const FIXTURE_CLOCK = () => new Date(NOW_MS)

function readRaw(taskId: string): TaskRecord {
  return JSON.parse(readFileSync(join(dir, TASKS_DIR, `${taskId}.json`), 'utf8')) as TaskRecord
}

/**
 * Force one running task's lease to be `ageSec` old.
 *
 * Written through the file rather than a clock-shifted `startTask` so the phase
 * boundary is exact: `Math.floor(age)` is what `reapTask` compares, and a
 * millisecond of drift on either side would land the test on the wrong phase.
 */
function seedRunning(taskId: string, ageSec: number): void {
  const task = readRaw(taskId)
  task.heartbeat_at = new Date(NOW_MS - ageSec * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, `${taskId}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-auto-reap-'))
  store = new TaskStore(undefined, dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('autoReap releases an overdue claimed task and logs it', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a', OLD)

  const result = await autoReap(store, 10)
  assert.equal(result.reaped.length, 1)
  assert.equal(result.reaped[0]?.task_id, 't1')
  assert.equal(result.reaped[0]?.action, 'released')
  assert.equal(readRaw('t1').status, 'pending')
  assert.deepEqual(result.logs, ['Auto-reaped task t1 due to lease timeout.'])

  const log = readFileSync(join(dir, TASKS_DIR, 'auto-reap.log'), 'utf8')
  assert.match(log, /Auto-reaped task t1 due to lease timeout\./)
})

test('autoReap fails an overdue running task', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a', OLD)
  await startTask(store, 't1', 'worker-a', OLD)

  // OLD is far past the grace deadline, so this is the second phase.
  const result = await autoReap(store, 10)
  assert.equal(result.reaped.length, 1)
  assert.equal(result.reaped[0]?.action, 'failed')
  assert.equal(readRaw('t1').status, 'failed')
})

test('autoReap leaves a fresh claim alone', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')

  const result = await autoReap(store, 600)
  assert.equal(result.reaped.length, 0)
  assert.equal(readRaw('t1').status, 'claimed')
  assert.equal(existsSync(join(dir, TASKS_DIR, 'auto-reap.log')), false)
})

test('autoReap with a non-positive threshold judges nothing', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a', OLD)

  const result = await autoReap(store, 0)
  assert.equal(result.reaped.length, 0)
  assert.equal(readRaw('t1').status, 'claimed')
})

// ---------------------------------------- P3: two-phase STALE grace period ---

const STALE_AFTER = 100

/** A running task with a heartbeat `ageSec` old, judged by `FIXTURE_CLOCK`. */
async function runningAt(ageSec: number, taskId = 't1'): Promise<void> {
  await store.createExclusive(blankTask(taskId))
  await claimTask(store, taskId, 'worker-a', FIXTURE_CLOCK)
  await startTask(store, taskId, 'worker-a', FIXTURE_CLOCK)
  seedRunning(taskId, ageSec)
}

test('phase 0: a fresh running task is untouched and no warning is invented', async () => {
  await runningAt(50)
  const before = readRaw('t1')
  assert.equal(before.status, 'running')

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.deepEqual(result.reaped, [], 'nothing stale at half the threshold')
  assert.deepEqual(result.logs, [])

  const after = readRaw('t1')
  assert.equal(after.status, 'running')
  assert.equal(after.failure_reason, '')
  assert.equal(after.retry_count, before.retry_count)
  assert.equal(after.completed_at, before.completed_at)
  assert.equal(existsSync(join(dir, TASKS_DIR, 'auto-reap.log')), false)
})

test('phase 1: past the threshold but inside the grace window only flags STALE', async () => {
  // 120s > 100s threshold, below the 150s hard-reap line.
  await runningAt(120)
  const before = readRaw('t1')

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.equal(result.reaped.length, 1)
  assert.equal(result.reaped[0]?.action, 'stale')
  assert.match(result.logs[0] ?? '', /warned/)
  // A warning is not a reaping, and must never be audited as one.
  assert.doesNotMatch(result.logs[0] ?? '', /Auto-reaped/)

  const after = readRaw('t1')
  // The six-state enum is untouched: still running, not a seventh 'stale' state.
  assert.equal(after.status, 'running')
  assert.equal(after.failure_reason, STALE_WARNING_REASON)
  // Nothing that would end the attempt may move.
  assert.equal(after.retry_count, before.retry_count)
  assert.equal(after.completed_at, before.completed_at)
  assert.equal(after.claimed_by, 'worker-a')

  const log = readFileSync(join(dir, TASKS_DIR, 'auto-reap.log'), 'utf8')
  assert.match(log, /warned: task t1 is STALE/)
})

test('phase 1: repeated sweeps do not re-log the same warning', async () => {
  await runningAt(120)
  await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  const second = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.deepEqual(second.reaped, [], 'an already-flagged task is not re-flagged')
  assert.equal(readRaw('t1').failure_reason, STALE_WARNING_REASON)
})

test('phase 1: a heartbeat inside the grace window clears the worker from suspicion', async () => {
  await runningAt(120)
  await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.equal(readRaw('t1').failure_reason, STALE_WARNING_REASON)

  // The worker is alive again. The heartbeat itself retires the warning — a
  // warning that outlives the condition would follow the task forever, because
  // nothing else clears `failure_reason` while the task keeps running.
  const beat = await heartbeatTask(store, 't1', 'worker-a', () => new Date(NOW_MS + 100_000))
  assert.equal(beat.ok, true)
  const afterBeat = readRaw('t1')
  assert.equal(afterBeat.status, 'running')
  assert.equal(afterBeat.failure_reason, '', 'a fresh heartbeat clears the stale flag')
  assert.equal(afterBeat.retry_count, 0)

  // And the next sweep spares the task: the lease is healthy again.
  const result = await autoReap(store, STALE_AFTER, () => new Date(NOW_MS + 101_000))
  assert.deepEqual(result.reaped, [])
  assert.equal(readRaw('t1').status, 'running')
})

test('phase 2: past 1.5x the threshold the task is failed and retry_count rises', async () => {
  // 160s > 100 + 50 grace deadline.
  await runningAt(160)
  const before = readRaw('t1')

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.equal(result.reaped.length, 1)
  assert.equal(result.reaped[0]?.action, 'failed')
  assert.match(result.logs[0] ?? '', /Auto-reaped task t1/)

  const after = readRaw('t1')
  assert.equal(after.status, 'failed')
  assert.notEqual(after.status, 'stale', "'stale' is not a TaskStatus")
  assert.equal(after.retry_count, before.retry_count + 1)
  assert.equal(after.failure_reason, 'heartbeat timeout')
  assert.notEqual(after.completed_at, before.completed_at)
})

test('phase 2: the grace window itself (exactly 1.5x) is still only a warning', async () => {
  await runningAt(150)

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)

  // The warning phase is inclusive at exactly 1.5x: 150s is not yet "> 1.5x".
  assert.equal(result.reaped[0]?.action, 'stale')
  const atDeadline = readRaw('t1')
  assert.equal(atDeadline.status, 'running', 'at 1.5x the task is still warned, not failed')
  assert.equal(atDeadline.retry_count, 0)
  assert.equal(atDeadline.failure_reason, STALE_WARNING_REASON)

  // One second later the boundary is crossed and the same task is reaped —
  // which is what makes the assertion above about the boundary, not luck.
  const next = await autoReap(store, STALE_AFTER, () => new Date(NOW_MS + 1_000))
  assert.equal(next.reaped[0]?.action, 'failed')
  assert.equal(readRaw('t1').status, 'failed')
})

test('phase 2: exhausted retries turn the timeout into blocked, not failed', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 1 }))
  await claimTask(store, 't1', 'worker-a', FIXTURE_CLOCK)
  await startTask(store, 't1', 'worker-a', FIXTURE_CLOCK)
  seedRunning('t1', 200)

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.equal(result.reaped[0]?.action, 'blocked')
  assert.equal(readRaw('t1').status, 'blocked')
})

test('claimed tasks keep the old single-phase behaviour (no grace window)', async () => {
  // A claim that never started has no half-work to lose: 120s is past the
  // threshold, and the task goes straight back to pending without a warning.
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a', FIXTURE_CLOCK)
  const claimed = readRaw('t1')
  claimed.claimed_at = new Date(NOW_MS - 120_000).toISOString()
  claimed.heartbeat_at = claimed.claimed_at
  writeFileSync(join(dir, TASKS_DIR, 't1.json'), `${JSON.stringify(claimed, null, 2)}\n`, 'utf8')

  const result = await autoReap(store, STALE_AFTER, FIXTURE_CLOCK)
  assert.equal(result.reaped[0]?.action, 'released')
  assert.equal(readRaw('t1').status, 'pending')
})
