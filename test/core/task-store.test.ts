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
import { createHash } from 'node:crypto'
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
  heartbeatTask,
  escalateTask,
  reapTask,
  readLog,
  viewsOf,
  findScopeConflict,
  scopesOverlap,
  missingRequiredFiles,
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
  // Since v0.4.0 a running lease is judged by its heartbeat, so both the claim
  // and the heartbeat must look stale for this to be a dead worker.
  const raw = readRaw('t1')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  raw.heartbeat_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
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

// --------------------------------------------------------- required_files ---

test('createExclusive stamps created_at for FIFO ordering', async () => {
  await store.createExclusive(blankTask('t1'))
  const raw = readRaw('t1')
  assert.notEqual(raw.created_at, '')
  assert.ok(!Number.isNaN(Date.parse(raw.created_at)))
})

test('claimTask refuses a task whose required_files are missing', async () => {
  await store.createExclusive(blankTask('t1', { required_files: ['nonexistent.txt'] }))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'missing_dependencies')
  // The message must name the exact path, not just say "missing".
  assert.match(outcome.message, /nonexistent\.txt/)
  // A refusal must not move the task out of pending.
  assert.equal(readRaw('t1').status, 'pending')
  assert.equal(readRaw('t1').claimed_by, '')
})

test('claimTask admits a task whose required_files exist', async () => {
  writeFileSync(join(dir, 'package.json'), '{}\n', 'utf8')
  await store.createExclusive(blankTask('t1', { required_files: ['package.json'] }))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
  assert.equal(readRaw('t1').status, 'claimed')
})

test('missingRequiredFiles lists only the absent paths', async () => {
  writeFileSync(join(dir, 'present.txt'), 'x\n', 'utf8')
  const task = blankTask('t1', { required_files: ['present.txt', 'absent-a.txt', 'absent-b.txt'] })
  assert.deepEqual(missingRequiredFiles(store, task), ['absent-a.txt', 'absent-b.txt'])
})

test('a priority task with missing required_files is ready by DAG but unclaimable', async () => {
  await store.createExclusive(blankTask('t1', { priority: 7, required_files: ['ghost.txt'], created_at: '2026-01-01T00:00:00.000Z' }))
  const all = (await store.readAll()).tasks
  // DAG-wise it is ready: pending with no blockers.
  const views = viewsOf(all)
  assert.equal(views[0]?.ready, true)
  // Context-wise it is not: the claim is refused and the task stays pending.
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.code, 'missing_dependencies')
  assert.match(outcome.message, /ghost\.txt/)
  assert.equal(readRaw('t1').status, 'pending')
  assert.equal(readRaw('t1').priority, 7)
})

// -------------------------------------------------------------- heartbeat ---

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

test('heartbeat renewal keeps a stale-looking claim alive', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  // The claim alone looks 20 minutes old...
  const raw = readRaw('t1')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, 't1.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  // ...but the holder renews the lease.
  const beat = await heartbeatTask(store, 't1', 'worker-a')
  assert.equal(beat.ok, true)
  assert.equal(beat.code, 'heartbeat')
  const reaped = await reapTask(store, 600)
  assert.deepEqual(reaped.reaped, [])
  assert.equal(readRaw('t1').status, 'claimed')
})

test('heartbeat renewal keeps a running task from being marked failed', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  const raw = readRaw('t1')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  raw.heartbeat_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, 't1.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const beat = await heartbeatTask(store, 't1', 'worker-a')
  assert.equal(beat.ok, true)
  const reaped = await reapTask(store, 600)
  assert.deepEqual(reaped.reaped, [])
  assert.equal(readRaw('t1').status, 'running')
})

test('heartbeat on a non-claimed/running task returns invalid_state', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await heartbeatTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
})

test('heartbeat from a non-owner returns not_owner', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await heartbeatTask(store, 't1', 'worker-b')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_owner')
  assert.match(outcome.message, /worker-a/)
  assert.equal(readRaw('t1').claimed_by, 'worker-a')
})

// ---------------------------------------------------------- required_hashes ---

test('claimTask admits a task whose required_hashes match', async () => {
  writeFileSync(join(dir, 'schema.json'), '{"v":1}\n', 'utf8')
  await store.createExclusive(blankTask('t1', { required_hashes: { 'schema.json': sha256('{"v":1}\n') } }))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('claimTask refuses a task whose required_hashes mismatch', async () => {
  writeFileSync(join(dir, 'schema.json'), '{"v":2}\n', 'utf8')
  await store.createExclusive(blankTask('t1', { required_hashes: { 'schema.json': sha256('{"v":1}\n') } }))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'hash_mismatch')
  assert.match(outcome.message, /schema\.json/)
  // The message names both sides so the caller can see what changed.
  assert.match(outcome.message, /declared/)
  assert.match(outcome.message, /actual/)
  assert.equal(readRaw('t1').status, 'pending')
})

test('a required_hashes entry for a missing file is missing_dependencies', async () => {
  await store.createExclusive(blankTask('t1', { required_hashes: { 'ghost.txt': sha256('x') } }))
  const outcome = await claimTask(store, 't1', 'worker-a')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'missing_dependencies')
  assert.match(outcome.message, /ghost\.txt/)
})

// ---------------------------------------------------------- worker routing ---

test('a standard worker cannot claim a premium-required high-complexity task', async () => {
  await store.createExclusive(blankTask('t1', { complexity: 'high', required_worker_tier: 'premium' }))
  const tiers = { 'worker-strong': 'premium' }
  const weak = await claimTask(store, 't1', 'worker-cheap', undefined, tiers)
  assert.equal(weak.ok, false)
  assert.equal(weak.code, 'worker_too_weak')
  assert.match(weak.message, /premium/)
  assert.equal(readRaw('t1').status, 'pending')
  const strong = await claimTask(store, 't1', 'worker-strong', undefined, tiers)
  assert.equal(strong.ok, true)
  assert.equal(strong.code, 'claimed')
})

test('a high-complexity task with an explicit tier is refused to a standard worker', async () => {
  await store.createExclusive(blankTask('t1', { complexity: 'high', required_worker_tier: 'standard' }))
  const outcome = await claimTask(store, 't1', 'worker-cheap', undefined, {})
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_too_weak')
})

test('a default any/medium task is claimable by any worker', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await claimTask(store, 't1', 'worker-cheap', undefined, {})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

// ------------------------------------------------- multidimensional routing ---

test('a worker whose capabilities cover the requirement can claim', async () => {
  await store.createExclusive(blankTask('t1', { required_capabilities: ['code'] }))
  const profiles = { 'worker-code': { capabilities: ['code', 'test'] } }
  const outcome = await claimTask(store, 't1', 'worker-code', undefined, undefined, profiles)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('a worker missing a required capability is refused with the missing tags named', async () => {
  await store.createExclusive(blankTask('t1', { required_capabilities: ['code', 'test'] }))
  const profiles = { 'worker-docs': { capabilities: ['docs'] } }
  const outcome = await claimTask(store, 't1', 'worker-docs', undefined, undefined, profiles)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_lacks_capability')
  assert.match(outcome.message, /code/)
  assert.match(outcome.message, /test/)
  assert.equal(readRaw('t1').status, 'pending')
})

test('a worker with too small a context window is refused', async () => {
  await store.createExclusive(blankTask('t1', { estimated_tokens: 50000 }))
  const profiles = { 'worker-small': { max_context_tokens: 32000 } }
  const outcome = await claimTask(store, 't1', 'worker-small', undefined, undefined, profiles)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_context_too_small')
  assert.match(outcome.message, /50000/)
  assert.match(outcome.message, /32000/)
})

test('a worker with a large enough context window can claim', async () => {
  await store.createExclusive(blankTask('t1', { estimated_tokens: 50000 }))
  const profiles = { 'worker-big': { max_context_tokens: 128000 } }
  const outcome = await claimTask(store, 't1', 'worker-big', undefined, undefined, profiles)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('with no requirements and no estimate, any worker can claim', async () => {
  await store.createExclusive(blankTask('t1'))
  const outcome = await claimTask(store, 't1', 'worker-unknown', undefined, undefined, {})
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('a profile overrides a legacy tier entry for the same agent', async () => {
  await store.createExclusive(blankTask('t1', { required_worker_tier: 'premium' }))
  // Legacy map says premium, profile says standard: the profile wins.
  const outcome = await claimTask(store, 't1', 'worker-both', undefined, { 'worker-both': 'premium' }, { 'worker-both': { tier: 'standard' } })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_too_weak')
})

// ------------------------------------------------------- cost and history ---

test('a worker above the task cost budget is refused', async () => {
  await store.createExclusive(blankTask('t1', { estimated_tokens: 50000, max_cost_tokens: 0.1 }))
  const profiles = { 'worker-pricey': { cost_per_1k_tokens: 0.01, max_context_tokens: 128000 } }
  const outcome = await claimTask(store, 't1', 'worker-pricey', undefined, undefined, profiles)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_too_expensive')
  // 0.01/1k × 50k = 0.5, above the 0.1 ceiling; both numbers must be visible.
  assert.match(outcome.message, /0\.5/)
  assert.match(outcome.message, /0\.1/)
  assert.equal(readRaw('t1').status, 'pending')
})

test('a worker within the task cost budget can claim', async () => {
  await store.createExclusive(blankTask('t1', { estimated_tokens: 50000, max_cost_tokens: 1 }))
  const profiles = { 'worker-cheap': { cost_per_1k_tokens: 0.01, max_context_tokens: 128000 } }
  const outcome = await claimTask(store, 't1', 'worker-cheap', undefined, undefined, profiles)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('a cost ceiling without an estimate does not block (cost is 0)', async () => {
  await store.createExclusive(blankTask('t1', { max_cost_tokens: 0.1 }))
  const profiles = { 'worker-pricey': { cost_per_1k_tokens: 1 } }
  const outcome = await claimTask(store, 't1', 'worker-pricey', undefined, undefined, profiles)
  assert.equal(outcome.ok, true)
})

test('worker_stats records success and failure counts', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'ok', 'worker-a', undefined, true)

  await store.createExclusive(blankTask('t2'))
  await claimTask(store, 't2', 'worker-b')
  await completeTask(store, 't2', 'boom', 'worker-b', undefined, false)

  const stats = await store.readWorkerStats()
  assert.equal(stats['worker-a']?.success_count, 1)
  assert.equal(stats['worker-a']?.failed_count, 0)
  assert.equal(stats['worker-b']?.success_count, 0)
  assert.equal(stats['worker-b']?.failed_count, 1)
  // Persisted, not in-memory only.
  assert.equal(existsSync(join(dir, TASKS_DIR, 'worker_stats.json')), true)
})

// ------------------------------------- dynamic reliability and escalation ---

function seedWorkerStats(stats: Record<string, { success_count: number; failed_count: number }>): void {
  mkdirSync(join(dir, TASKS_DIR), { recursive: true })
  writeFileSync(join(dir, TASKS_DIR, 'worker_stats.json'), JSON.stringify(stats), 'utf8')
}

test('an unreliable worker is refused a high-complexity task', async () => {
  seedWorkerStats({ 'worker-bad': { success_count: 1, failed_count: 4 } })
  await store.createExclusive(blankTask('t-high', { complexity: 'high' }))
  const outcome = await claimTask(store, 't-high', 'worker-bad')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'worker_unreliable')
  assert.match(outcome.message, /high complexity/)
  assert.match(outcome.message, /failure rate/)
  // Refusal must not touch state.
  assert.equal(readRaw('t-high').status, 'pending')
})

test('the same unreliable worker can still claim a medium task', async () => {
  seedWorkerStats({ 'worker-bad': { success_count: 1, failed_count: 4 } })
  await store.createExclusive(blankTask('t-medium', { complexity: 'medium' }))
  const outcome = await claimTask(store, 't-medium', 'worker-bad')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'claimed')
})

test('the same unreliable worker can still claim a low task', async () => {
  seedWorkerStats({ 'worker-bad': { success_count: 1, failed_count: 4 } })
  await store.createExclusive(blankTask('t-low', { complexity: 'low' }))
  const outcome = await claimTask(store, 't-low', 'worker-bad')
  assert.equal(outcome.ok, true)
})

test('completion metrics accumulate total tokens and time', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await completeTask(store, 't1', 'ok', 'worker-a', undefined, true, {
    actual_tokens: 1200,
    duration_ms: 45000,
  })
  assert.equal(outcome.ok, true)
  const stats = await store.readWorkerStats()
  assert.equal(stats['worker-a']?.total_tokens_consumed, 1200)
  assert.equal(stats['worker-a']?.total_task_time_ms, 45000)
  assert.equal(stats['worker-a']?.success_count, 1)
})

test('escalation blocks the task with the reason and a log line', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await startTask(store, 't1', 'worker-a')
  const outcome = await escalateTask(store, 't1', 'worker-a', 'missing schema.json')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'escalated')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'blocked')
  assert.equal(raw.claimed_by, '')
  assert.equal(raw.failure_reason, 'missing schema.json')
  const log = await readLog(store, 't1')
  assert.equal(log.some(line => line.includes('escalated by worker-a: missing schema.json')), true)
})

test("a non-owner cannot escalate someone else's task", async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await escalateTask(store, 't1', 'worker-b', 'not mine')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_owner')
  assert.equal(readRaw('t1').status, 'claimed')
  assert.equal(readRaw('t1').claimed_by, 'worker-a')
})

test('the Lead can force-escalate a task held by a worker', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await escalateTask(store, 't1', 'lead', 'pull it back', true)
  assert.equal(outcome.ok, true)
  assert.equal(readRaw('t1').status, 'blocked')
})

test('escalating a completed task is invalid_state', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'done', 'worker-a')
  const outcome = await escalateTask(store, 't1', 'worker-a', 'too late')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'invalid_state')
})

// ------------------------------------------- P5: absent metrics are not 0 ---

/**
 * The bug these cover: an average taken as `total / success_count` counts a
 * completion that reported nothing as a 0-token, 0-second completion. The
 * divisor has to be the number of *samples*, so totals and sample counters are
 * updated together and only when a valid number arrived.
 */

test('a completion without metrics adds no samples and no totals', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  const outcome = await completeTask(store, 't1', 'ok', 'worker-a', undefined, true)
  assert.equal(outcome.ok, true)

  const stats = await store.readWorkerStats()
  assert.equal(stats['worker-a']?.success_count, 1, 'the attempt still counts as a success')
  assert.equal(stats['worker-a']?.total_tokens_consumed, 0)
  assert.equal(stats['worker-a']?.total_task_time_ms, 0)
  // The counters are the point: 0 samples, not "1 sample of 0".
  assert.equal(stats['worker-a']?.tokens_sample_count, 0)
  assert.equal(stats['worker-a']?.time_sample_count, 0)
})

test('a metric-free success followed by a measured one averages only the measured one', async () => {
  // Silence first: this must not be folded in as a 0.
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'ok', 'worker-a', undefined, true)

  // Then a real measurement.
  await store.createExclusive(blankTask('t2'))
  await claimTask(store, 't2', 'worker-a')
  const outcome = await completeTask(store, 't2', 'ok', 'worker-a', undefined, true, {
    actual_tokens: 1200,
    duration_ms: 45000,
  })
  assert.equal(outcome.ok, true)

  const entry = (await store.readWorkerStats())['worker-a']
  assert.ok(entry)
  assert.equal(entry.success_count, 2)
  // Dividing by success_count would give 600 tokens / 22.5s — exactly the
  // "fake zero" the fix removes.
  assert.equal(entry.tokens_sample_count, 1)
  assert.equal(entry.time_sample_count, 1)
  assert.equal(Math.round(entry.total_tokens_consumed / (entry.tokens_sample_count ?? 1)), 1200)
  assert.equal(entry.total_task_time_ms / (entry.time_sample_count ?? 1), 45000)
})

test('the two metrics are sampled independently', async () => {
  // Tokens only: the time average must stay unpopulated rather than read 0.
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'ok', 'worker-a', undefined, true, { actual_tokens: 800 })

  const entry = (await store.readWorkerStats())['worker-a']
  assert.ok(entry)
  assert.equal(entry.tokens_sample_count, 1)
  assert.equal(entry.total_tokens_consumed, 800)
  assert.equal(entry.time_sample_count, 0)
  assert.equal(entry.total_task_time_ms, 0)
})

test('invalid metrics are ignored instead of being clamped to 0', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-a')
  await completeTask(store, 't1', 'ok', 'worker-a', undefined, true, {
    actual_tokens: -5,
    duration_ms: Number.NaN,
  })

  const entry = (await store.readWorkerStats())['worker-a']
  assert.ok(entry)
  assert.equal(entry.success_count, 1)
  assert.equal(entry.total_tokens_consumed, 0)
  assert.equal(entry.total_task_time_ms, 0)
  assert.equal(entry.tokens_sample_count, 0)
  assert.equal(entry.time_sample_count, 0)
})

test('a legacy worker_stats.json without the sample counters reads as zero samples', async () => {
  // Written before P5: totals exist but no counts. The reader must not treat
  // the missing field as a crash, and must not infer samples from success_count.
  seedWorkerStats({ 'worker-legacy': { success_count: 3, failed_count: 1 } })
  const entry = (await store.readWorkerStats())['worker-legacy']
  assert.ok(entry)
  assert.equal(entry.success_count, 3)
  assert.equal(entry.tokens_sample_count, 0)
  assert.equal(entry.time_sample_count, 0)
})

// ------------------------------------- v1.1.0 quality gate (fake runner) ---

/**
 * The quality gate is exercised through its **injected runner**, never by
 * spawning a shell: the core takes `{ command, runner }`, so every case below
 * pins the decision without touching `execSync`. A test that really ran
 * `npm test` would be slow, platform-dependent and recursive.
 *
 * A counting fake makes "the runner was not called" a first-class assertion —
 * for `success=false` the gate must not run at all, and for the default
 * no-command path it must not run either.
 */
interface GateProbe {
  calls: Array<{ command: string; cwd: string }>
  runner: (command: string, cwd: string) => { ok: boolean; output: string }
}

function gateProbe(outcome: { ok: boolean; output: string }): GateProbe {
  const calls: Array<{ command: string; cwd: string }> = []
  return {
    calls,
    runner: (command: string, cwd: string) => {
      calls.push({ command, cwd })
      return outcome
    },
  }
}

test('quality gate: no command configured leaves the runner untouched', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: false, output: 'should never run' })

  const outcome = await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: '', runner: probe.runner },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'completed')
  assert.equal(probe.calls.length, 0, 'an unconfigured gate must not spawn anything')
  assert.equal(readRaw('t1').status, 'completed')
  assert.equal(readRaw('t1').failure_reason, '')
})

test('quality gate: whitespace-only command is also "not configured"', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: false, output: 'nope' })

  const outcome = await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: '   \t ', runner: probe.runner },
  })
  assert.equal(outcome.code, 'completed')
  assert.equal(probe.calls.length, 0)
})

test('quality gate: a passing gate completes and says so', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: true, output: '42 tests passed' })

  const outcome = await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: 'npm test', runner: probe.runner },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.code, 'completed')
  assert.match(outcome.message, /quality gate passed/)
  assert.equal(probe.calls.length, 1)
  assert.equal(probe.calls[0]?.command, 'npm test')
  // The gate runs in the *workspace* (the pool's parent), never in the pool's
  // own `.dsh-tasks` bookkeeping directory and never in process.cwd().
  assert.equal(probe.calls[0]?.cwd, dir)
  assert.equal(readRaw('t1').status, 'completed')
})

test('quality gate: a failing gate fails the task, even though the worker said success', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: false, output: 'FAIL src/core/task-store.ts: expected 1 got 2' })

  const outcome = await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: 'npm test', runner: probe.runner },
  })
  // The whole point: a reported success does not survive a red check.
  assert.equal(outcome.code, 'failed')
  assert.equal(outcome.ok, true, 'the transition happened, it was just a failure')
  assert.match(outcome.message, /quality gate failed/i)

  const raw = readRaw('t1')
  assert.equal(raw.status, 'failed')
  assert.notEqual(raw.status, 'completed')
  assert.match(raw.failure_reason, /^Quality gate failed: /)
  assert.match(raw.failure_reason, /expected 1 got 2/)
  // Same retry semantics as success=false.
  assert.equal(raw.retry_count, 1)
  assert.notEqual(raw.completed_at, '')
})

test('quality gate: a failing gate on the last retry blocks the task', async () => {
  await store.createExclusive(blankTask('t1', { max_retries: 1 }))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: false, output: 'type error' })

  const outcome = await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: 'npx tsc --noEmit', runner: probe.runner },
  })
  assert.equal(outcome.code, 'blocked')
  const raw = readRaw('t1')
  assert.equal(raw.status, 'blocked')
  assert.equal(raw.retry_count, 1)
  assert.match(raw.failure_reason, /^Quality gate failed: /)
})

test('quality gate: success=false never runs the gate', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: true, output: 'would have passed' })

  const outcome = await completeTask(store, 't1', 'broke the build', 'worker-gate', undefined, false, undefined, {
    qualityGate: { command: 'npm test', runner: probe.runner },
  })
  assert.equal(outcome.code, 'failed')
  // Asserted by count, not by inspection: "never called" is the contract.
  assert.equal(probe.calls.length, 0, 'an already-failed completion must not spend time on the gate')
  // The worker's own reason survives; it is not overwritten by a gate message.
  assert.equal(readRaw('t1').failure_reason, 'broke the build')
  assert.equal(readRaw('t1').retry_count, 1)
})

test('quality gate: long gate output is truncated in failure_reason', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const huge = 'x'.repeat(2000)
  const probe = gateProbe({ ok: false, output: huge })

  await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, undefined, {
    qualityGate: { command: 'npm test', runner: probe.runner },
  })

  const reason = readRaw('t1').failure_reason
  assert.match(reason, /^Quality gate failed: /)
  const body = reason.slice('Quality gate failed: '.length)
  // 500 characters kept plus the ellipsis marker; the limit is "about 500".
  assert.ok(body.length <= 501, `gate output should be truncated, got ${body.length} chars`)
  assert.ok(body.length >= 490, `truncation should keep ~500 chars, got ${body.length}`)
  assert.equal(body.startsWith('x'.repeat(400)), true)
})

test('quality gate: a gate failure feeds the failure counters, not the success ones', async () => {
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const probe = gateProbe({ ok: false, output: 'red' })

  await completeTask(store, 't1', 'done', 'worker-gate', undefined, true, { actual_tokens: 900 }, {
    qualityGate: { command: 'npm test', runner: probe.runner },
  })

  const stats = (await store.readWorkerStats())['worker-gate']
  assert.ok(stats)
  // Shipping work that fails the check must not look reliable.
  assert.equal(stats.success_count, 0)
  assert.equal(stats.failed_count, 1)
  assert.equal(stats.total_tokens_consumed, 0, 'a failed attempt accumulates no performance credit')
  assert.equal(stats.tokens_sample_count, 0)
})

test('quality gate: an omitted gate keeps the pre-v1.1.0 signature working', async () => {
  // The six optional parameters must stay exactly as they were: this is the
  // call every existing caller still makes.
  await store.createExclusive(blankTask('t1'))
  await claimTask(store, 't1', 'worker-gate')
  const outcome = await completeTask(store, 't1', 'ok', 'worker-gate', undefined, true, { actual_tokens: 1200 })
  assert.equal(outcome.code, 'completed')
  assert.equal(outcome.message, 't1 completed')
  assert.equal(readRaw('t1').status, 'completed')
})
