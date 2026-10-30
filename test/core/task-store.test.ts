/**
 * Unit tests for the task store — the pool's core logic.
 *
 * These run on Node's built-in test runner with Node's native TypeScript type
 * stripping, so they add **no dependency**: `npm test` is `node --test test/`.
 *
 * Two deliberate design choices:
 *
 *   1. **No DSH runtime.** `src/core/` takes the filesystem slice as a
 *      constructor argument, not a Cordis context, so `new TaskStore(undefined,
 *      dir)` exercises the documented `node:fs` path directly. That is the same
 *      path the real deployment uses after the sandbox refuses `ctx.fs`, and it
 *      means this file imports nothing from `@deepseek-ai/*`.
 *
 *   2. **A fresh temp directory per test.** Every test gets its own pool, so
 *      ordering cannot leak state between them, and `afterEach` removes it. The
 *      tests never touch the real workspace pool.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TASKS_DIR,
  TaskStore,
  blankTask,
  claimTask,
  completeTask,
  releaseTask,
  setDependencies,
  startTask,
  reapTask,
  viewsOf,
  findScopeConflict,
  scopesOverlap,
  type TaskRecord,
} from '../../src/core/task-store.ts'

let dir: string
let store: TaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-store-test-'))
  mkdirSync(join(dir, TASKS_DIR), { recursive: true })
  store = new TaskStore(undefined, dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write one task file directly, bypassing the store, to set up a state. */
function seed(task: TaskRecord): void {
  writeFileSync(join(dir, TASKS_DIR, `${task.task_id}.json`), `${JSON.stringify(task, null, 2)}\n`, 'utf8')
}

/** Read one task file directly, bypassing the store, to assert on state. */
function readRaw(taskId: string): TaskRecord {
  return JSON.parse(readFileSync(join(dir, TASKS_DIR, `${taskId}.json`), 'utf8')) as TaskRecord
}

function lockPath(taskId: string): string {
  return join(dir, TASKS_DIR, `${taskId}.lock`)
}

// --------------------------------------------------------------- createTask ---

test('createExclusive writes a new task with pending status', async () => {
  const outcome = await store.createExclusive(blankTask('t1', { title: 'first' }))
  assert.equal(outcome.ok, true)
  const raw = readRaw('t1')
  assert.equal(raw.status, 'pending')
  assert.equal(raw.title, 'first')
  assert.equal(raw.claimed_by, '')
})

test('createExclusive refuses to overwrite an existing task', async () => {
  await store.createExclusive(blankTask('t1', { title: 'first' }))
  const second = await store.createExclusive(blankTask('t1', { title: 'second' }))
  assert.equal(second.ok, false)
  // The first write must survive: a repeated plan cannot reset finished work.
  assert.equal(readRaw('t1').title, 'first')
})

// ---------------------------------------------------------------- claimTask ---

test('claimTask claims a pending task and records the holder', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'claimed')
  assert.equal(raw.claimed_by, 'worker-a')
  assert.notEqual(raw.claimed_at, '')
})

test('claimTask on an already-claimed task returns already_claimed', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const second = await claimTask(store, 't1', 'worker-b')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'already_claimed')
  // The original holder is unchanged.
  assert.equal(readRaw('t1').claimed_by, 'worker-a')
})

test('claimTask on a missing task returns not_found', async () => {
  const outcome = await claimTask(store, 'nope', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_found')
})

test('claimTask clears a residual lock left by a dead holder', async () => {
  await store.createExclusive(blankTask('t1'))
  // Simulate a worker that died inside its lock window: the lock exists, but the
  // task still reads pending because the status write never happened.
  writeFileSync(lockPath('t1'), 'stale\n', 'utf8')
  const outcome = await claimTask(store, 't1', 'worker-b')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
  assert.equal(outcome.stale_lock_cleared, true)
  assert.equal(readRaw('t1').claimed_by, 'worker-b')
  // The claim releases its own lock on the way out.
  assert.equal(existsSync(lockPath('t1')), false)
})

// -------------------------------------------------------------- releaseTask ---

test('releaseTask returns a claimed task to pending and clears the holder', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await releaseTask(store, 't1', 'lead')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'released')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'pending')
  assert.equal(raw.claimed_by, '')
  assert.equal(raw.claimed_at, '')
})

test('releaseTask on a non-claimed task returns invalid_state', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await releaseTask(store, 't1', 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
})

test('releaseTask deletes a lingering lock file', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  writeFileSync(lockPath('t1'), 'left behind\n', 'utf8')
  const outcome = await releaseTask(store, 't1', 'lead')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.lock_removed, true)
  assert.equal(existsSync(lockPath('t1')), false, 'release must clear the other half of the claim')
})

test('releaseTask does not resurrect a completed task', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'done', 'worker-a')
  const outcome = await releaseTask(store, 't1', 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
  assert.equal(readRaw('t1').status, 'completed')
})

// ------------------------------------------------------------- completeTask ---

test('completeTask records the outcome', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await completeTask(store, 't1', 'all green', 'worker-a')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'completed')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'completed')
  assert.equal(raw.result, 'all green')
  assert.notEqual(raw.completed_at, '')
})

test('completeTask on a pending (never claimed) task returns invalid_state', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await completeTask(store, 't1', 'done', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
})

test('completeTask refuses a second completion of the same task', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'first', 'worker-a')
  const second = await completeTask(store, 't1', 'second', 'worker-a')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'invalid_state')
  // The first result is not overwritten.
  assert.equal(readRaw('t1').result, 'first')
})

// ----------------------------------------------------------- setDependencies ---

test('setDependencies replaces the dependency list', async () => {
  await store.createExclusive(blankTask('a'))
  await store.createExclusive(blankTask('b'))
  const outcome = await setDependencies(store, 'b', ['a'], 'lead')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'updated')
  assert.deepEqual(outcome.blocked_by, ['a'])
  assert.deepEqual(readRaw('b').blocked_by, ['a'])
})

test('setDependencies on a missing task returns not_found', async () => {
  const outcome = await setDependencies(store, 'ghost', ['a'], 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_found')
})

test('setDependencies with an unknown id returns invalid_dependency and writes nothing', async () => {
  await store.createExclusive(blankTask('a'))
  const outcome = await setDependencies(store, 'a', ['does-not-exist'], 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_dependency')
  assert.deepEqual(readRaw('a').blocked_by, [], 'a refusal must not write')
})

test('setDependencies that would close a cycle returns cycle_detected and writes nothing', async () => {
  await store.createExclusive(blankTask('a'))
  await store.createExclusive(blankTask('b'))
  await setDependencies(store, 'b', ['a'], 'lead')
  const outcome = await setDependencies(store, 'a', ['b'], 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'cycle_detected')
  // Both tasks keep their pre-existing, acyclic shape.
  assert.deepEqual(readRaw('a').blocked_by, [])
  assert.deepEqual(readRaw('b').blocked_by, ['a'])
})

test('setDependencies rejects a self-reference as the shortest cycle', async () => {
  await store.createExclusive(blankTask('a'))
  const outcome = await setDependencies(store, 'a', ['a'], 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'cycle_detected')
})

// ------------------------------------------------------ write_scopes overlap ---

test('scopesOverlap treats equal, nested and slash-variant paths as overlapping', () => {
  assert.equal(scopesOverlap('src', 'src'), true)
  assert.equal(scopesOverlap('src', 'src/api'), true)
  assert.equal(scopesOverlap('src/api', 'src'), true)
  assert.equal(scopesOverlap('./src/', 'src'), true)
  assert.equal(scopesOverlap('src\\api', 'src/api'), true)
  assert.equal(scopesOverlap('src', 'test'), false)
  // A shared prefix that is not a path segment must not count.
  assert.equal(scopesOverlap('src', 'src2'), false)
  assert.equal(scopesOverlap('', 'src'), false)
})

test('findScopeConflict reports the conflicting task and scope pair', async () => {
  await store.createExclusive(blankTask('a', { write_scopes: ['src'] }))
  await store.createExclusive(blankTask('b', { write_scopes: ['src/api'] }))
  await claimTask(store, 'a', 'worker-a')
  const all = (await store.readAll()).tasks
  const conflict = findScopeConflict(all.find(t => t.task_id === 'b') as TaskRecord, all)
  assert.notEqual(conflict, undefined)
  assert.equal(conflict?.task_id, 'a')
  assert.equal(conflict?.scope, 'src/api')
  assert.equal(conflict?.other_scope, 'src')
})

test('claimTask refuses a task whose write_scopes overlap a claimed task', async () => {
  await store.createExclusive(blankTask('a', { write_scopes: ['src'] }))
  await store.createExclusive(blankTask('b', { write_scopes: ['src/api'] }))
  assert.equal((await claimTask(store, 'a', 'worker-a')).ok, true)
  const second = await claimTask(store, 'b', 'worker-b')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'scope_conflict')
  // The refusal names both parties, so the caller does not have to guess.
  assert.match(second.message, /src\/api/)
  assert.match(second.message, /a/)
  assert.equal(readRaw('b').status, 'pending')
  assert.equal(readRaw('b').claimed_by, '')
})

test('claimTask admits two tasks whose write_scopes do not overlap', async () => {
  await store.createExclusive(blankTask('a', { write_scopes: ['src'] }))
  await store.createExclusive(blankTask('b', { write_scopes: ['test'] }))
  assert.equal((await claimTask(store, 'a', 'worker-a')).ok, true)
  assert.equal((await claimTask(store, 'b', 'worker-b')).ok, true)
  assert.equal(readRaw('a').claimed_by, 'worker-a')
  assert.equal(readRaw('b').claimed_by, 'worker-b')
})

test('claimTask ignores a completed task when judging scope conflicts', async () => {
  await store.createExclusive(blankTask('a', { write_scopes: ['src'] }))
  await store.createExclusive(blankTask('b', { write_scopes: ['src'] }))
  // `a` finishes, so its scope is free again.
  await claimTask(store, 'a', 'worker-a')
  await completeTask(store, 'a', 'done', 'worker-a')
  const second = await claimTask(store, 'b', 'worker-b')
  assert.equal(second.ok, true)
})

// ---------------------------------------------------------------- readiness ---

test('readiness follows blocked_by', async () => {
  await store.createExclusive(blankTask('a'))
  await store.createExclusive(blankTask('b', { blocked_by: ['a'] }))
  let views = viewsOf((await store.readAll()).tasks)
  assert.equal(views.find(v => v.task_id === 'a')?.ready, true)
  assert.equal(views.find(v => v.task_id === 'b')?.ready, false)
  assert.deepEqual(views.find(v => v.task_id === 'b')?.blocked_by_open, ['a'])

  await claimTask(store, 'a', 'worker-a')
  await completeTask(store, 'a', 'done', 'worker-a')
  views = viewsOf((await store.readAll()).tasks)
  assert.equal(views.find(v => v.task_id === 'b')?.ready, true)
})

test('a claim is marked stale only past the threshold', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const tasks = (await store.readAll()).tasks

  // Fresh claim: not stale at a 600s threshold.
  const fresh = viewsOf(tasks, Date.now(), 600)[0] as { stale: boolean }
  assert.equal(fresh.stale, false)

  // Same task judged 901 seconds later: stale.
  const later = viewsOf(tasks, Date.now() + 901_000, 600)[0] as { stale: boolean }
  assert.equal(later.stale, true)

  // Threshold 0 means "do not judge", even for an ancient claim.
  const unjudged = viewsOf(tasks, Date.now() + 10_000_000, 0)[0] as { stale: boolean }
  assert.equal(unjudged.stale, false)
})

// ---------------------------------------------------------------- startTask ---

test('startTask transitions claimed -> running and records heartbeat', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await startTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'started')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'running')
  assert.notEqual(raw.started_at, '')
  assert.notEqual(raw.heartbeat_at, '')
})

test('startTask on non-claimed task returns invalid_state', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await startTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
})

test('startTask on missing task returns not_found', async () => {
  const outcome = await startTask(store, 'missing', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_found')
})

// ----------------------------------------------------------- completeTask (failed/blocked) ---

test('completeTask with success=false marks failed and increments retry_count', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 3 }))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  const outcome = await completeTask(store, 't1', 'error occurred', 'worker-a', undefined, false)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'failed')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'failed')
  assert.equal(raw.retry_count, 1)
  assert.equal(raw.failure_reason, 'error occurred')
})

test('completeTask with success=false and max retries reached marks blocked', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 2 }))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  // First failure
  await completeTask(store, 't1', 'first error', 'worker-a', undefined, false)
  // Second failure (retry_count = 2 >= max_retries = 2) -> blocked
  await startTask(store, 't1', 'worker-a') // re-start for retry
  const outcome = await completeTask(store, 't1', 'second error', 'worker-a', undefined, false)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'blocked')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'blocked')
  assert.equal(raw.retry_count, 2)
})

test('completeTask with success=true marks completed', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  const outcome = await completeTask(store, 't1', 'all done', 'worker-a', undefined, true)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'completed')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'completed')
})

// ---------------------------------------------------------------- reapTask ---

test('reapTask reverts stale claimed task to pending', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  // Backdate claimed_at
  const raw = readRaw('t1')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, 't1.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const outcome = await reapTask(store, 600) // 10 min threshold
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reaped.length, 1)
  assert.equal(outcome.reaped[0].action, 'released')
  assert.equal(readRaw('t1').status, 'pending')
  assert.equal(readRaw('t1').claimed_by, '')
})

test('reapTask marks stale running task as failed/blocked', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 3 }))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  // Backdate claimed_at
  const raw = readRaw('t1')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, 't1.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const outcome = await reapTask(store, 600)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reaped.length, 1)
  assert.equal(outcome.reaped[0].action, 'failed')
  assert.equal(readRaw('t1').status, 'failed')
  assert.equal(readRaw('t1').retry_count, 1)
})

test('reapTask does not reap tasks within threshold', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await reapTask(store, 600)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reaped.length, 0)
  assert.equal(readRaw('t1').status, 'claimed')
})

// -------------------------------------------------------------- TaskView new fields ---

test('viewsOf includes running_age_sec and heartbeat_age_sec for running tasks', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  const views = viewsOf((await store.readAll()).tasks, Date.now(), 600)
  const view = views.find(v => v.task_id === 't1')
  assert.notEqual(view, undefined)
  assert.equal(view!.status, 'running')
  assert.ok(typeof view!.running_age_sec === 'number')
  assert.ok(typeof view!.heartbeat_age_sec === 'number')
  assert.ok(view!.running_age_sec >= 0)
  assert.ok(view!.heartbeat_age_sec >= 0)
})

test('viewsOf includes retry_count and failure_reason for failed/blocked tasks', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 3 }))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'failed', 'worker-a', undefined, false)
  const views = viewsOf((await store.readAll()).tasks)
  const view = views.find(v => v.task_id === 't1')
  assert.notEqual(view, undefined)
  assert.equal(view!.status, 'failed')
  assert.equal(view!.retry_count, 1)
  assert.equal(view!.failure_reason, 'failed')
})
