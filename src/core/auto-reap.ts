/**
 * Event-driven watchdog: the same reclamation `swarm_reap` performs, run in the
 * background instead of when a human remembers to call the tool.
 *
 * The function is pure logic over the store — no Cordis, no timers, no event
 * names. The host adapter decides *when* to call it (see `src/index.ts`: an
 * `agent/status` = idle event, debounced two seconds); this module only decides
 * *what* is stale, by reusing `reapTask` so the automatic and manual paths can
 * never disagree about the lease rule.
 */
import { computeReady, reapTask, type ReapedTask, type TaskStore } from './task-store.ts'

export interface AutoReapResult {
  ok: boolean
  /** Same shape as `swarm_reap`'s report, so one renderer could serve both. */
  reaped: ReapedTask[]
  /** Audit lines written this round (empty when nothing was stale). */
  logs: string[]
  /** Ready tasks after the round — "the pool has work again". */
  ready: number
  degraded?: string
}

/**
 * Reclaim every claimed/running task whose lease is older than
 * `staleAfterSec`, then report how much work is ready again.
 *
 * `staleAfterSec <= 0` means "do not judge": the manual tool and this function
 * share that reading, so a zero threshold never turns the background watchdog
 * into a task shredder.
 *
 * `clock` is forwarded to `reapTask` only so phase-boundary tests can pin "now";
 * the host call sites pass nothing and get the real clock.
 *
 * A `stale` action is a **warning, not a reclamation**: it must not be logged as
 * "Auto-reaped …" and must not count toward the "pool has new ready tasks" line,
 * because nothing left `running` and nothing became ready. Only released/failed/
 * blocked entries are audited as reaps; the warning gets its own line.
 */
export async function autoReap(
  store: TaskStore,
  staleAfterSec: number,
  clock?: () => Date,
): Promise<AutoReapResult> {
  if (!(staleAfterSec > 0)) {
    return { ok: true, reaped: [], logs: [], ready: 0, degraded: store.degraded }
  }
  const outcome = clock === undefined
    ? await reapTask(store, staleAfterSec)
    : await reapTask(store, staleAfterSec, clock)
  const logs: string[] = []
  let reclaimed = 0
  for (const item of outcome.reaped) {
    if (item.action === 'stale') {
      logs.push(`Auto-reap warned: task ${item.task_id} is STALE — ${item.message}`)
      continue
    }
    reclaimed += 1
    logs.push(`Auto-reaped task ${item.task_id} due to lease timeout.`)
  }
  const all = await store.readAll()
  const ready = computeReady(all.tasks, 0).total
  if (logs.length > 0) {
    for (const line of logs) store.appendAutoReapLog(line)
    if (reclaimed > 0 && ready > 0) store.appendAutoReapLog(`Pool has new ready tasks (${ready}).`)
  }
  return {
    ok: outcome.ok,
    reaped: outcome.reaped,
    logs,
    ready,
    degraded: outcome.degraded ?? all.io.degraded ?? store.degraded,
  }
}
