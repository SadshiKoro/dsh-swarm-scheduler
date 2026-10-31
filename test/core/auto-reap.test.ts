/**
 * Pure-logic tests for the event-driven watchdog.
 *
 * `autoReap` is deliberately host-free: it takes the store and a threshold, so
 * these tests cover the whole decision — which tasks are stale, what they become,
 * what is logged — without any Cordis event, timer or debounce involved. The host
 * wiring (agent/status → debounce → autoReap) is exercised in the live session.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TASKS_DIR,
  TaskStore,
  blankTask,
  claimTask,
  startTask,
  type TaskRecord,
} from '../../src/core/task-store.ts'
import { autoReap } from '../../src/core/auto-reap.ts'

let dir: string
let store: TaskStore

const OLD = () => new Date('2020-01-01T00:00:00Z')

function readRaw(taskId: string): TaskRecord {
  return JSON.parse(readFileSync(join(dir, TASKS_DIR, `${taskId}.json`), 'utf8')) as TaskRecord
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
