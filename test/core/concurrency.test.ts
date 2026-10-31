/**
 * Concurrent integration tests for the swarm scheduler.
 *
 * These tests exercise real concurrent behaviour using Promise.all to simulate
 * multiple workers racing against the same pool. They use the same temp-directory
 * and node:fs fallback pattern as the existing unit tests, and import nothing
 * from `@deepseek-ai/*` — the core takes the filesystem slice directly.
 *
 * Test must complete within 1 second (wall-clock).
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  TASKS_DIR,
  TaskStore,
  blankTask,
  claimTask,
  completeTask,
  releaseTask,
  setDependencies,
  viewsOf,
  type TaskRecord,
} from '../../src/core/task-store.ts'

let dir: string
let store: TaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-concurrency-test-'))
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

// ================================================================
// 1. Same task, two workers claim simultaneously → only one succeeds
// ================================================================
test('concurrent claim: same task, two workers → exactly one succeeds', async () => {
  await store.createExclusive(blankTask('task-1'))

  // Fire two claim attempts at the exact same time
  const [r1, r2] = await Promise.all([
    claimTask(store, 'task-1', 'worker-a'),
    claimTask(store, 'task-1', 'worker-b'),
  ])

  const successes = [r1, r2].filter(r => r.ok)
  const failures = [r1, r2].filter(r => !r.ok)

  assert.equal(successes.length, 1, 'exactly one claim must succeed')
  assert.equal(failures.length, 1, 'exactly one claim must fail')
  assert.equal(failures[0].code, 'already_claimed', 'loser receives already_claimed')

  const raw = readRaw('task-1')
  assert.equal(raw.status, 'claimed')
  assert.ok(['worker-a', 'worker-b'].includes(raw.claimed_by))
})

// ================================================================
// 2. Two tasks with overlapping write_scopes claim simultaneously
//    → one succeeds, one gets scope_conflict
// ================================================================
test('concurrent claim: overlapping scopes → one succeeds, one scope_conflict', async () => {
  await store.createExclusive(blankTask('task-a', { write_scopes: ['src/a.ts'] }))
  await store.createExclusive(blankTask('task-b', { write_scopes: ['src/a.ts'] }))

  const [r1, r2] = await Promise.all([
    claimTask(store, 'task-a', 'worker-a'),
    claimTask(store, 'task-b', 'worker-b'),
  ])

  const successes = [r1, r2].filter(r => r.ok)
  const conflicts = [r1, r2].filter(r => r.code === 'scope_conflict')

  // One should succeed, one should get scope_conflict (order non-deterministic)
  assert.equal(successes.length, 1)
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0].message, /scope_conflict/)
  assert.match(conflicts[0].message, /src\/a\.ts/)
})

// ================================================================
// 3. Claim a task, don't complete, set claimed_at to 20 min ago
//    → swarm_status marks it STALE
// ================================================================
test('stale detection: claimed task older than threshold → marked STALE', async () => {
  await store.createExclusive(blankTask('task-stale'))
  await claimTask(store, 'task-stale', 'worker-a')

  // Manually backdate the claimed_at to 20 minutes ago
  const raw = readRaw('task-stale')
  raw.claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  writeFileSync(join(dir, TASKS_DIR, 'task-stale.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

  const views = viewsOf((await store.readAll()).tasks, Date.now(), 600) // 10 min threshold
  const staleView = views.find(v => v.task_id === 'task-stale')
  assert.notEqual(staleView, undefined)
  assert.equal(staleView!.stale, true, 'task should be marked stale at 20 min with 10 min threshold')
})

// ================================================================
// 4. Complete the same task twice → second time returns invalid_state
// ================================================================
test('double complete: completing a completed task → invalid_state', async () => {
  await store.createExclusive(blankTask('task-done'))
  await claimTask(store, 'task-done', 'worker-a')
  await completeTask(store, 'task-done', 'first result', 'worker-a')

  const second = await completeTask(store, 'task-done', 'second result', 'worker-a')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'invalid_state')
  assert.equal(readRaw('task-done').result, 'first result', 'first result must not be overwritten')
})

// ================================================================
// 5. Dependency cycle A→B→C→A → set_deps returns cycle_detected
// ================================================================
test('dependency cycle: A→B→C→A → cycle_detected', async () => {
  await store.createExclusive(blankTask('A'))
  await store.createExclusive(blankTask('B'))
  await store.createExclusive(blankTask('C'))

  // A <- B <- C
  await setDependencies(store, 'B', ['A'], 'lead')
  await setDependencies(store, 'C', ['B'], 'lead')

  // Now try to make A depend on C → cycle A→B→C→A
  const outcome = await setDependencies(store, 'A', ['C'], 'lead')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'cycle_detected')
  assert.match(outcome.message, /cycle/)
  // Original dependencies must be unchanged
  assert.deepEqual(readRaw('A').blocked_by, [])
  assert.deepEqual(readRaw('B').blocked_by, ['A'])
  assert.deepEqual(readRaw('C').blocked_by, ['B'])
})

// ================================================================
// 6. Residual lock on a pending task, concurrent claims
//    → one clears the lock and succeeds, the other fails
// ================================================================
test('concurrent claim with residual lock: one clears lock, one fails', async () => {
  await store.createExclusive(blankTask('task-lock'))

  // Plant a stale lock file (simulates dead holder that never wrote status)
  writeFileSync(lockPath('task-lock'), 'stale\n', 'utf8')

  const [r1, r2] = await Promise.all([
    claimTask(store, 'task-lock', 'worker-a'),
    claimTask(store, 'task-lock', 'worker-b'),
  ])

  const successes = [r1, r2].filter(r => r.ok)
  const failures = [r1, r2].filter(r => !r.ok)

  assert.equal(successes.length, 1)
  assert.equal(successes[0].stale_lock_cleared, true)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].code, 'already_claimed')
  assert.equal(readRaw('task-lock').status, 'claimed')
  // Lock should be cleared by the successful claim
  assert.equal(existsSync(lockPath('task-lock')), false)
})

// ================================================================
// 7. Cross-process: two real OS processes race for one `wx` lock
// ================================================================
/**
 * The lock's whole job is to be atomic **between processes**, but every test
 * above races two promises inside one Node process. That can still pass if the
 * lock were only an in-memory guard: the `await` boundaries alone would
 * serialise the callers.
 *
 * This case removes that possibility. Two genuine child processes race to
 * `openSync(path, 'wx')` the same lock file, so the winner is decided by the
 * operating system's O_EXCL, not by JavaScript scheduling.
 *
 * ## Why the fixture is a separate file and why stdio is ignored
 *
 * The DSH sandbox refuses a child process whose stdio is piped
 * (`spawn EPERM`, errno -4048) — measured with both `fork()` and a piped
 * `spawn()` on this host. So this case does not read stdout: each child writes
 * its outcome to its own result file and the parent reads that file afterwards.
 * `stdio: 'ignore'` is the only mode that works under the sandbox.
 *
 * The fixture is written to the OS temp directory rather than committed next to
 * this test, so it cannot be picked up as a test file by the runner's glob.
 */
const RACER_SOURCE = `import { openSync, closeSync, writeFileSync } from 'node:fs'
const [lockFile, resultFile] = process.argv.slice(2)
let outcome
try {
  const fd = openSync(lockFile, 'wx')
  closeSync(fd)
  outcome = { won: true, code: null }
} catch (error) {
  outcome = { won: false, code: error.code ?? String(error) }
}
writeFileSync(resultFile, JSON.stringify({ ...outcome, pid: process.pid }), 'utf8')
`

type RaceOutcome = { won: boolean; code: string | null; pid: number }

/** Launch both racers and wait for both to exit; returns their parsed results. */
async function raceOnce(racerPath: string, lock: string, resultFiles: string[]): Promise<RaceOutcome[]> {
  const children = resultFiles.map(resultFile =>
    spawn(process.execPath, [racerPath, lock, resultFile], { stdio: 'ignore' }))
  await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', () => resolve())
  })))
  return resultFiles.map(file => JSON.parse(readFileSync(file, 'utf8')) as RaceOutcome)
}

test('cross-process lock: two OS processes race one wx file → exactly one wins, one EEXIST', async () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'swarm-lock-racer-'))
  try {
    const racer = join(fixtures, 'lock-racer.mjs')
    writeFileSync(racer, RACER_SOURCE, 'utf8')

    const ROUNDS = 5
    for (let round = 0; round < ROUNDS; round += 1) {
      const lock = join(fixtures, `race-${round}.lock`)
      const results = await raceOnce(racer, lock, [
        join(fixtures, `race-${round}-a.json`),
        join(fixtures, `race-${round}-b.json`),
      ])

      const winners = results.filter(result => result.won)
      const losers = results.filter(result => !result.won)

      const detail = `round ${round + 1}/${ROUNDS}: ${JSON.stringify(results)}`
      // Exactly one winner: two winners would mean O_EXCL was not honoured, and
      // two losers would mean the lock file was already there (a broken fixture,
      // not a real race).
      assert.equal(winners.length, 1, `exactly one process must win the wx race. ${detail}`)
      assert.equal(losers.length, 1, `exactly one process must lose the wx race. ${detail}`)
      assert.equal(losers[0]?.code, 'EEXIST', `the loser must fail with EEXIST, not another code. ${detail}`)
      // The two racers are genuinely distinct OS processes.
      assert.notEqual(results[0]?.pid, results[1]?.pid, `the racers must be separate processes. ${detail}`)
    }

    // A sixth round proves the lock is really on disk: a third process that
    // races an already-held lock must lose, and cannot be a coincidence of the
    // first two finishing before it started.
    const heldLock = join(fixtures, 'held.lock')
    const held = await raceOnce(racer, heldLock, [
      join(fixtures, 'held-a.json'),
      join(fixtures, 'held-b.json'),
    ])
    const holder = held.find(result => result.won)
    assert.notEqual(holder, undefined, 'one process must create the lock')
    assert.equal(existsSync(heldLock), true, 'the winning process must have created the lock file on disk')
    const lateComer = await raceOnce(racer, heldLock, [join(fixtures, 'held-c.json')])
    assert.equal(lateComer[0]?.won, false, 'a later process must not be able to take an existing lock')
    assert.equal(lateComer[0]?.code, 'EEXIST', 'the later process must receive EEXIST')
  } finally {
    rmSync(fixtures, { recursive: true, force: true })
  }
})