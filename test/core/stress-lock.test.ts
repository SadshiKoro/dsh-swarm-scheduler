/**
 * Claim-lock race evidence (P6): ten workers, one pool, no serialisation.
 *
 * The v0.9.0 stress suite (stress.test.ts) proves the scheduler converges when
 * workers politely re-scan the pool. That case is useful, but it never forces
 * two workers to reach `claimTask` for the *same* task at the *same* instant,
 * which is exactly the window the `.lock` file exists to close.
 *
 * Here every worker issues its claim with `Promise.all`, so all ten resolve the
 * routing gates before any of them can observe the others. Two cases:
 *
 *   A) ten workers claim the SAME task  -> exactly one `claimed`.
 *   B) ten workers claim ten DIFFERENT tasks that share one identical write
 *      scope                              -> exactly one `claimed`, no double hold.
 *
 * Every case is repeated 20 times: a race that wins is a race that can lose
 * later, so one green round is not evidence. Any losing round is reported with
 * the raw outcome codes and is NEVER "fixed" by weakening the assertion.
 *
 * No DSH import — core store only, against a temp directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  TaskStore,
  blankTask,
  claimTask,
} from '../../src/core/task-store.ts'

/** Rounds per case: contention is probabilistic, so a single pass proves nothing. */
const ROUNDS = 20

/** Concurrent claimants per round. */
const WORKERS = 10

/** Codes a loser of a fair race is allowed to get. Anything else is a defect. */
const EXPECTED_LOSS_CODES = new Set(['already_claimed', 'scope_conflict'])

type ClaimOutcome = Awaited<ReturnType<typeof claimTask>>

/** Compact, greppable rendering of one round's raw outcomes. */
function describeRound(round: number, outcomes: ClaimOutcome[]): string {
  const lines = outcomes.map((outcome, index) =>
    `  worker-${index}: ok=${outcome.ok} code=${outcome.code} :: ${outcome.message}`)
  return `round ${round + 1}/${ROUNDS} raw outcomes:\n${lines.join('\n')}`
}

/**
 * Assert the fairness invariant for one round and return the winning codes.
 *
 * The three checks are deliberately separate so a failure names the defect:
 * double-win (two `ok`), a foreign error code (io_error & co), and a winner
 * whose code is not `claimed`.
 */
function checkRound(round: number, outcomes: ClaimOutcome[]): ClaimOutcome[] {
  const report = describeRound(round, outcomes)
  const winners = outcomes.filter(outcome => outcome.ok)
  assert.equal(winners.length, 1, `exactly one claim may succeed per round.\n${report}`)
  for (const outcome of outcomes) {
    if (outcome.ok) continue
    assert.ok(
      EXPECTED_LOSS_CODES.has(outcome.code),
      `loser returned an unexpected code "${outcome.code}"; only already_claimed / scope_conflict are fair losses.\n${report}`,
    )
  }
  assert.equal(winners[0]?.code, 'claimed', `the single winner must report code=claimed.\n${report}`)
  return winners
}

test('case A: 10 workers claim the SAME task concurrently — exactly one wins, 20 rounds', async () => {
  const started = Date.now()
  const roots: string[] = []
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      // A private directory per round keeps every round an honest cold start: a
      // file name re-used in a shared directory would let round N's lock and
      // record leak into round N+1 and mask the very race being measured.
      const dir = mkdtempSync(join(process.cwd(), '.tmp-stress-lock-a-'))
      roots.push(dir)
      const taskId = `race-same-${round}`
      const store = new TaskStore(undefined, dir)
      await store.createExclusive(blankTask(taskId, {
        title: `same-task race ${round}`,
        write_scopes: [`src/contended-${round}.ts`],
      }))

      const outcomes = await Promise.all(
        Array.from({ length: WORKERS }, (_, index) => claimTask(store, taskId, `worker-${index}`)),
      )
      const winners = checkRound(round, outcomes)
      const winner = winners[0]
      assert.ok(winner !== undefined, `round ${round + 1}: a winner must exist`)

      // On-disk truth, not just the returned codes: the record names one holder,
      // and it is the worker whose claim actually won — not merely worker-0.
      const persisted = await store.readOne(taskId)
      assert.equal(persisted.task?.status, 'claimed', `round ${round + 1}: task must be persisted as claimed`)
      assert.ok(
        persisted.task?.claimed_by !== undefined && persisted.task.claimed_by.length > 0,
        `round ${round + 1}: persisted record must name its holder`,
      )
      assert.ok(
        winner.message.includes(`claimed by ${persisted.task?.claimed_by}`),
        `round ${round + 1}: persisted holder ${persisted.task?.claimed_by} must be the worker that returned ok. `
          + `winner message: ${winner.message}`,
      )
    }
  } finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  }
  const elapsed = Date.now() - started
  // Windows pays for real fsync per lock write; the CI budget is Linux-only.
  const budget = process.platform === 'win32' ? 60000 : 10000
  assert.ok(elapsed < budget, `case A took ${elapsed}ms (budget ${budget}ms)`)
})

test('case B: 10 workers claim 10 DIFFERENT tasks sharing one identical scope — exactly one wins, 20 rounds', async () => {
  const started = Date.now()
  const roots: string[] = []
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = mkdtempSync(join(process.cwd(), '.tmp-stress-lock-b-'))
      roots.push(dir)
      const store = new TaskStore(undefined, dir)
      // The same scope string on every task: overlap is judged per task pair and
      // is not limited to the same task_id, which is what case B isolates.
      const sharedScope = `src/shared-${round}.ts`
      for (let index = 0; index < WORKERS; index += 1) {
        await store.createExclusive(blankTask(`race-scope-${round}-${index}`, {
          title: `scope race ${round}/${index}`,
          write_scopes: [sharedScope],
        }))
      }

      const outcomes = await Promise.all(
        Array.from({ length: WORKERS }, (_, index) => claimTask(store, `race-scope-${round}-${index}`, `worker-${index}`)),
      )
      const winners = checkRound(round, outcomes)
      const winner = winners[0]
      assert.ok(winner !== undefined, `round ${round + 1}: a winner must exist`)

      // Exactly one task may end up holding the shared scope on disk, and the
      // holder must be the worker whose claim won (worker id and task id are
      // deliberately not assumed to be `worker-0` / index 0).
      const all = (await store.readAll()).tasks
        .filter(task => task.task_id.startsWith(`race-scope-${round}-`))
      const holders = all.filter(task => task.status === 'claimed')
      assert.equal(holders.length, 1, `round ${round + 1}: exactly one task may hold the shared scope, got ${holders.length}`)
      const holder = holders[0]
      assert.ok(holder !== undefined, `round ${round + 1}: a holder must exist`)
      assert.ok(
        winner.message.includes(`claimed by ${holder.claimed_by}`),
        `round ${round + 1}: shared-scope holder ${holder.claimed_by} must be the worker that returned ok. `
          + `winner message: ${winner.message}`,
      )
    }
  } finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  }
  const elapsed = Date.now() - started
  // case B scans the whole pool under the lock (findScopeConflict over every
  // task), so its per-round cost is ~10x case A's. On Windows that is ~2.8s a
  // round (measured: 56.6s for 20 rounds) because each claim does real fsync;
  // the tight CI number below is a Linux budget only.
  const budget = process.platform === 'win32' ? 180000 : 10000
  assert.ok(elapsed < budget, `case B took ${elapsed}ms (budget ${budget}ms)`)
})
