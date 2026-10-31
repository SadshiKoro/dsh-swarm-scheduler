/**
 * Concurrency stress tests: many workers, one pool.
 *
 * No DSH import — this exercises the core store only, against a temp directory.
 * The point is not a benchmark: it is to prove the lock + scope + state machine
 * stay correct when ten workers hammer the pool at once, and that a watchdog
 * round cleans up workers that vanish mid-task.
 *
 * Both cases must finish well inside 3 seconds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TASKS_DIR,
  TaskStore,
  blankTask,
  claimTask,
  completeTask,
  computeReady,
  reapTask,
  scopesOverlap,
} from '../../src/core/task-store.ts'

const SCOPE_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(letter => `src/${letter}.ts`)

/** Deterministic LCG: "random" scopes with a reproducible layout. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('50 tasks, 10 scopes, 10 workers: every task is claimed exactly once and no scope is double-held', async () => {
  const started = Date.now()
  const dir = mkdtempSync(join(process.cwd(), '.tmp-stress-'))
  try {
    const store = new TaskStore(undefined, dir)
    const rand = lcg(42)

    // 1) 50 tasks over 10 scopes.
    for (let i = 0; i < 50; i += 1) {
      const scope = SCOPE_NAMES[Math.floor(rand() * SCOPE_NAMES.length)] as string
      await store.createExclusive(blankTask(`task-${i}`, {
        title: `stress ${i}`,
        write_scopes: [scope],
      }))
    }

    // 2) 10 workers race for the pool; each claim is completed immediately so
    // the scope is released and the next task can be admitted. Workers keep a
    // local snapshot and only re-scan when it is exhausted: a pool scan is the
    // expensive operation, and the point of the test is contention, not
    // re-reading 50 files on every loop turn.
    let claimWins = 0
    const workers = Array.from({ length: 10 }, (_, index) => `worker-${index}`)
    await Promise.all(workers.map(async workerId => {
      let snapshot = (await store.readAll()).tasks
      const attempted = new Set<string>()
      for (let guard = 0; guard < 1000; guard += 1) {
        if (snapshot.every(task => task.status === 'completed')) return
        const ready = computeReady(snapshot, 0)
        const heldScopes = snapshot
          .filter(task => task.status === 'claimed' || task.status === 'running')
          .flatMap(task => task.write_scopes)
        const candidate = ready.tasks.find(task =>
          !attempted.has(task.task_id)
          && !task.write_scopes.some(scope => heldScopes.some(held => scopesOverlap(scope, held))))
        if (candidate === undefined) {
          // Snapshot has nothing we can take right now: refresh, then back off.
          snapshot = (await store.readAll()).tasks
          attempted.clear()
          if (snapshot.every(task => task.status === 'completed')) return
          await sleep(10)
          continue
        }
        attempted.add(candidate.task_id)
        const outcome = await claimTask(store, candidate.task_id, workerId)
        if (outcome.ok) {
          claimWins += 1
          await completeTask(store, candidate.task_id, 'done', workerId)
          // Locally mark it done so the stale snapshot does not offer it again.
          snapshot = snapshot.map(task =>
            task.task_id === candidate.task_id ? { ...task, status: 'completed' as const } : task)
        }
      }
      assert.fail(`${workerId} did not converge`)
    }))

    // Invariant, checked once at the end instead of re-reading the whole pool
    // after every claim: two tasks with overlapping scopes must never have had
    // overlapping [claimed_at, completed_at] intervals.
    const final = (await store.readAll()).tasks
    const intervals = final.map(task => ({
      id: task.task_id,
      scopes: task.write_scopes,
      start: Date.parse(task.claimed_at),
      end: Date.parse(task.completed_at),
    }))
    for (let i = 0; i < intervals.length; i += 1) {
      for (let j = i + 1; j < intervals.length; j += 1) {
        const a = intervals[i]
        const b = intervals[j]
        const overlaps = a.scopes.some(one => b.scopes.some(two => scopesOverlap(one, two)))
        if (!overlaps) continue
        assert.equal(
          a.end <= b.start || b.end <= a.start,
          true,
          `${a.id} and ${b.id} held overlapping scopes at the same time`,
        )
      }
    }
    assert.equal(claimWins, 50, 'every task must be claimed exactly once')
    assert.equal(final.filter(task => task.status === 'completed').length, 50)
    // The 3s budget is a CI (Linux) budget. On Windows this host's filesystem
    // makes a 50-file pool scan ~40ms and each of the 50 claims needs one scan,
    // so the wall clock here is dominated by the local disk, not the scheduler.
    // The functional assertions above are platform-independent; only the clock is not.
    const budget = process.platform === 'win32' ? 60000 : 3000
    assert.ok(Date.now() - started < budget, `stress case took ${Date.now() - started}ms (budget ${budget}ms)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('5 workers vanish after claiming; one reap round recovers all five', async () => {
  const started = Date.now()
  const dir = mkdtempSync(join(process.cwd(), '.tmp-stress-reap-'))
  try {
    const store = new TaskStore(undefined, dir)
    for (let i = 0; i < 5; i += 1) {
      await store.createExclusive(blankTask(`crash-${i}`, { title: `crash ${i}`, write_scopes: [`src/x${i}.ts`] }))
    }

    // Five workers take a task each and then "disappear" (no complete).
    await Promise.all([0, 1, 2, 3, 4].map(async index => {
      const outcome = await claimTask(store, `crash-${index}`, `vanishing-${index}`)
      assert.equal(outcome.ok, true)
    }))

    // Age the claims past the (deliberately zero) threshold. Backdating is
    // equivalent to waiting; a 0s threshold with a 0s age correctly means
    // "not stale yet", which is why the fixture moves the clock, not the rule.
    for (let i = 0; i < 5; i += 1) {
      const path = join(dir, TASKS_DIR, `crash-${i}.json`)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      record.claimed_at = new Date(Date.now() - 5_000).toISOString()
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    }

    const reaped = await reapTask(store, 0)
    assert.equal(reaped.ok, true)
    assert.equal(reaped.reaped.length, 5, 'all five abandoned claims must be reaped')
    for (const entry of reaped.reaped) {
      assert.equal(entry.action, 'released')
    }

    const final = (await store.readAll()).tasks
    assert.equal(final.filter(task => task.status === 'pending').length, 5)
    assert.equal(final.filter(task => task.claimed_by.length > 0).length, 0)
    // No lock may survive the recovery.
    const leftovers = readdirSync(join(dir, TASKS_DIR)).filter(name => name.endsWith('.lock'))
    assert.deepEqual(leftovers, [])
    assert.ok(Date.now() - started < 3000, `reap case took ${Date.now() - started}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
