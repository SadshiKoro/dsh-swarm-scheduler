/**
 * The file-driven tool surface: ten tools, all of them plain task-pool I/O.
 *
 * None of these touch a Cordis service beyond `ctx.fs` (through `TaskStore`),
 * because every richer service this plugin once relied on proved unreachable
 * from its fiber. Dispatch is therefore not this plugin's job any more: the Lead
 * reads `swarm_ready` and assigns work with its own kernel subagent tools, while
 * this layer owns only the durable record of what exists, what is taken and what
 * finished.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
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
  reapTask,
  readLog,
  computeReady,
  missingRequiredFiles,
  hashMismatches,
  viewsOf,
  type TaskRecord,
  type TaskView,
} from './core/task-store.js'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** Maximum tasks accepted in one `swarm_plan` call. */
const MAX_PLAN_TASKS = 200
/** Longest accepted compressed result; detail belongs in a handoff file. */
const MAX_RESULT_CHARS = 4_000

/**
 * Render an age in seconds as a short human interval: `45s`, `15m`, `2h3m`.
 *
 * Coarse on purpose — the number exists to tell a reader "this has been held a
 * long time", not to be arithmetically precise.
 */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

export interface FileToolDeps {
  ctx: Context
  store: TaskStore
  /**
   * Staleness threshold in seconds, read once at registration.
   *
   * Only `swarm_status` uses it: a claim older than this is reported as STALE so
   * the Lead can decide whether to release it. Nothing here acts on the value.
   */
  staleAssignmentSec: number
  /**
   * Maximum concurrent workers (claimed + running). When reached, `swarm_ready`
   * returns 0 ready tasks.
   */
  max_workers: number
  /** agent id → 'standard' | 'premium'; unlisted workers are standard. */
  worker_tiers: Record<string, string>
  /** Collects every disposer from this registration, in one ownership list. */
  disposers: Array<() => void>
}

function viewRow(view: TaskView): Record<string, unknown> {
  return {
    task_id: view.task_id,
    big_task_id: view.big_task_id,
    title: view.title,
    status: view.status,
    claimed_by: view.claimed_by,
    ready: view.ready,
    blocked_by: view.blocked_by,
    blocked_by_open: view.blocked_by_open,
    write_scopes: view.write_scopes,
    retry_count: view.retry_count,
    max_retries: view.max_retries,
    failure_reason: view.failure_reason,
    running_age_sec: view.running_age_sec,
    heartbeat_age_sec: view.heartbeat_age_sec,
  }
}

export function registerFileTools({ ctx, store, staleAssignmentSec, max_workers, worker_tiers, disposers }: FileToolDeps): void {
  // ------------------------------------------------------------- swarm_plan ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_plan',
    description:
      'Create the task pool on disk: one JSON file per task under .dsh-tasks/. Call this first, with the '
      + 'whole decomposition. An existing task_id is never overwritten — it is reported as a conflict so a '
      + 'repeated call cannot silently reset finished work. blocked_by names other task_ids in the same call '
      + 'or already on disk; a task is ready only once every blocker is completed. Each task may also set '
      + '`priority` (larger claims first; ties are FIFO by creation time) and `required_files` '
      + '(workspace-relative paths that must exist before the task may be claimed); `required_hashes` pins '
      + 'each of those files to a sha256 digest, so a changed prerequisite refuses the claim with `hash_mismatch`.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'Tasks to create. Each becomes <task_id>.json.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task_id: { type: 'string', required: true, description: 'Unique id, e.g. big-1/small-1-1' },
            big_task_id: { type: 'string', required: true, description: 'Owning big task block, e.g. big-1' },
            title: { type: 'string', required: true, description: 'Short title' },
            description: { type: 'string', required: true, description: 'Inputs, outputs and acceptance criteria' },
            blocked_by: { type: 'array', description: 'Task ids that must complete first', items: { type: 'string' } },
            write_scopes: { type: 'array', description: 'Files or directory prefixes this task will modify', items: { type: 'string' } },
            priority: { type: 'number', description: 'Claim priority: larger wins; ties are FIFO by creation time. Default 0.' },
            required_files: { type: 'array', description: 'Workspace-relative files that must exist before the task can be claimed', items: { type: 'string' } },
            required_hashes: {
              type: 'object',
              description: 'Map of workspace-relative file path -> expected sha256 hex digest; a mismatch refuses the claim',
              additionalProperties: true,
            },
            complexity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Estimated difficulty, used for worker routing. Default medium.' },
            required_worker_tier: { type: 'string', enum: ['any', 'standard', 'premium'], description: 'Minimum worker tier allowed to claim. Default any.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'array', items: { type: 'string' } },
          conflicts: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          dir: { type: 'string' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const created = value.created ?? []
        const conflicts = value.conflicts ?? []
        const errors = value.errors ?? []
        const warnings = value.warnings ?? []
        const lines = [`pool: ${created.length} created, ${conflicts.length} conflict(s), ${errors.length} error(s)`]
        if (created.length > 0) lines.push(`  created: ${created.join(', ')}`)
        if (conflicts.length > 0) lines.push(`  already present (not overwritten): ${conflicts.join(', ')}`)
        if (warnings.length > 0) lines.push(...warnings.map(line => `  ⚠ ${line}`))
        if (errors.length > 0) lines.push(...errors.map(line => `  ! ${line}`))
        if (value.degraded !== undefined && value.degraded !== '') lines.push(`  degraded: ${value.degraded}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const created: string[] = []
      const conflicts: string[] = []
      const errors: string[] = []
      const warnings: string[] = []
      const incoming = args.tasks ?? []
      if (incoming.length > MAX_PLAN_TASKS) {
        return { created, conflicts, errors: [`${incoming.length} tasks exceeds the ${MAX_PLAN_TASKS} limit for one call`], warnings, dir: TASKS_DIR, degraded: '' }
      }
      const ensured = await store.ensureDir()
      if (!ensured.ok) errors.push(`pool directory unavailable: ${ensured.error ?? 'unknown'}`)

      const seen = new Set<string>()
      for (const spec of incoming) {
        const taskId = spec.task_id.trim()
        if (taskId.length === 0) { errors.push('a task arrived with an empty task_id'); continue }
        if (seen.has(taskId)) { conflicts.push(taskId); continue }
        seen.add(taskId)
        // The schema cannot express "string -> string" (additionalProperties is
        // boolean-only here), so non-string digest values are dropped instead of
        // being trusted.
        const requiredHashes: Record<string, string> = {}
        const rawHashes = spec.required_hashes
        if (typeof rawHashes === 'object' && rawHashes !== null && !Array.isArray(rawHashes)) {
          for (const [file, digest] of Object.entries(rawHashes)) {
            if (typeof digest === 'string') requiredHashes[file] = digest
          }
        }
        // Directory-level scopes block parallelism at directory granularity.
        for (const scope of spec.write_scopes ?? []) {
          if (scope.trim().endsWith('/')) {
            warnings.push(`任务 ${taskId} 声明了目录级 scope ${scope}，可能阻塞并行，建议细化到文件`)
          }
        }
        const record: TaskRecord = blankTask(taskId, {
          big_task_id: spec.big_task_id,
          title: spec.title,
          description: spec.description,
          blocked_by: spec.blocked_by ?? [],
          write_scopes: spec.write_scopes ?? [],
          priority: spec.priority ?? 0,
          required_files: spec.required_files ?? [],
          required_hashes: requiredHashes,
          complexity: spec.complexity ?? 'medium',
          required_worker_tier: spec.required_worker_tier ?? 'any',
        })
        const written = await store.createExclusive(record)
        if (written.ok) created.push(taskId)
        else if ((written.error ?? '').includes('already exists')) conflicts.push(taskId)
        else errors.push(`${taskId}: ${written.error ?? 'write failed'}`)
      }
      return {
        created,
        conflicts,
        errors,
        warnings,
        dir: TASKS_DIR,
        degraded: ensured.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // ------------------------------------------------------------ swarm_ready ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_ready',
    description:
      'List the tasks a worker can start right now: status pending with every blocked_by entry completed. '
      + 'Readiness is derived from the files on disk on every call, so it needs no bookkeeping. Use this to '
      + 'decide what to assign next; assign with your own subagent tools, not from here.',
    parameters: {
      big_task_id: { type: 'string', description: 'Limit to one big task block' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          dir: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string' },
                big_task_id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                write_scopes: { type: 'array', items: { type: 'string' } },
                blocked_by: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? []
        const degraded = value.degraded !== undefined && value.degraded !== ''
          ? [`  degraded: ${value.degraded}`]
          : []
        if (tasks.length === 0) {
          // The empty list is exactly where the ceiling reason matters, so the
          // degraded line must survive this branch (v0.3.1 defect fix).
          return text([`ready: 0 (pool: ${value.dir ?? TASKS_DIR})`, ...degraded].join('\n'))
        }
        return text([`ready: ${value.total ?? tasks.length}`,
          ...tasks.map(task => `  ${task.task_id} [${task.big_task_id ?? ''}] ${task.title ?? ''}`
            + ((task.write_scopes ?? []).length > 0 ? `  scope: ${(task.write_scopes ?? []).join(', ')}` : '')),
          ...degraded].join('\n'))
      },
    },
    async execute(args) {
      const all = await store.readAll()
      const result = computeReady(all.tasks, max_workers, args.big_task_id)
      const fsNote = all.io.degraded ?? store.degraded ?? ''
      if (result.limited) {
        // The ceiling notice is the reason the caller must see; the filesystem
        // degradation is secondary and appended, never allowed to shadow it.
        return {
          total: 0,
          dir: TASKS_DIR,
          tasks: [],
          degraded: [result.notice, fsNote].filter(note => note !== undefined && note !== '').join('; '),
        }
      }
      return {
        total: result.total,
        dir: TASKS_DIR,
        tasks: result.tasks.map(view => ({
          task_id: view.task_id,
          big_task_id: view.big_task_id,
          title: view.title,
          description: view.description,
          write_scopes: view.write_scopes,
          blocked_by: view.blocked_by,
        })),
        degraded: all.io.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // ------------------------------------------------------------ swarm_claim ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_claim',
    description:
      'Claim one task for one worker, atomically. Two concurrent callers cannot both win: the loser is told '
      + 'the task is taken so it can pick another. Normally the Lead claims on the worker\'s behalf before '
      + 'assigning it; a worker that polls the pool itself may claim its own task instead. Claiming never '
      + 'overwrites completed work. '
      + 'This is also where `write_scopes` is enforced: if the task\'s scopes overlap '
      + 'those of a task that is already claimed, the claim is refused with `scope_conflict` naming both the '
      + 'conflicting task and the overlapping scopes. Serialise the two with `swarm_set_deps`, or declare '
      + 'narrower scopes. Overlap is judged at directory granularity, so two tasks that both declare `src/` '
      + 'are refused even when they would edit different files. '
      + 'A lock left behind by a worker that died mid-claim is cleared automatically.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to claim' },
      claimed_by: { type: 'string', required: true, description: 'Agent id of the worker taking it' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['claimed', 'already_claimed', 'not_found', 'invalid_state', 'scope_conflict', 'missing_dependencies', 'hash_mismatch', 'worker_too_weak', 'io_error'] },
          message: { type: 'string' },
          claimed_by: { type: 'string' },
          claimed_at: { type: 'string' },
          stale_lock_cleared: { type: 'boolean' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + (value.stale_lock_cleared === true ? '\n  note: a stale lock left by a dead holder was cleared' : '')
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      const outcome = await claimTask(store, args.task_id, args.claimed_by, undefined, worker_tiers)
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: undefined }
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        claimed_by: after.task?.claimed_by ?? '',
        claimed_at: after.task?.claimed_at ?? '',
        stale_lock_cleared: outcome.stale_lock_cleared === true,
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // --------------------------------------------------------- swarm_complete ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_complete',
    description:
      'Record that one task finished, with its outcome. Call it yourself when you did the work, or on a '
      + 'worker\'s behalf when it reported back. The result is the compressed outcome — paths, decisions, '
      + 'evidence. Use success=false to mark a failure (will retry up to max_retries, then become blocked). '
      + 'A second completion of the same task is refused rather than silently accepted.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task that finished' },
      result: { type: 'string', required: true, description: 'Compressed outcome: files, decisions, evidence' },
      completed_by: { type: 'string', required: true, description: 'Agent id that did the work' },
      success: { type: 'boolean', description: 'Whether the task succeeded (default true). False triggers retry logic.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['completed', 'failed', 'blocked', 'not_found', 'invalid_state', 'io_error', 'result_too_long'] },
          message: { type: 'string' },
          completed_at: { type: 'string' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      if (args.result.length > MAX_RESULT_CHARS) {
        return {
          ok: false, code: 'result_too_long' as const,
          message: `result is ${args.result.length} chars; keep it under ${MAX_RESULT_CHARS} and put detail in a handoff file`,
          completed_at: '', degraded: '',
        }
      }
      const outcome = await completeTask(store, args.task_id, args.result, args.completed_by, undefined, args.success ?? true)
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: undefined }
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        completed_at: after.task?.completed_at ?? '',
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // ----------------------------------------------------------- swarm_status ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_status',
    description:
      'Report the whole pool in one call: how many tasks exist in each of the six states (pending, claimed, '
      + 'running, completed, failed, blocked), how many are ready to start, how many are still blocked, and a '
      + 'compact line per task. A claim/running older than `staleAssignmentSec` is marked STALE — a suspicion '
      + 'that its worker died mid-task. Release such a task with swarm_release if you agree it is abandoned; '
      + 'or use swarm_reap to automatically recover stale tasks. Use this to decide whether to plan more, '
      + 'assign more, or stop. Pass include_log=true to see the last 5 log lines per task.',
    parameters: {
      include_log: { type: 'boolean', description: 'Include last 5 log lines per task' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          total: { type: 'integer' },
          pending: { type: 'integer' },
          claimed: { type: 'integer' },
          running: { type: 'integer' },
          completed: { type: 'integer' },
          failed: { type: 'integer' },
          blocked: { type: 'integer' },
          ready: { type: 'integer' },
          stale: { type: 'integer' },
          stale_after_sec: { type: 'integer' },
          big_tasks: { type: 'array', items: { type: 'string' } },
          tasks: { type: 'array', items: { type: 'string' } },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? []
        const stale = value.stale ?? 0
        const head = `pool ${value.dir ?? TASKS_DIR}: total ${value.total ?? 0} · pending ${value.pending ?? 0}`
          + ` · claimed ${value.claimed ?? 0} · running ${value.running ?? 0}${stale > 0 ? ` (${stale} stale)` : ''}`
          + ` · completed ${value.completed ?? 0} · failed ${value.failed ?? 0} · blocked ${value.blocked ?? 0}`
          + ` · ready ${value.ready ?? 0}`
        const hint = stale > 0
          ? [`  ⚠ ${stale} task(s) older than ${value.stale_after_sec ?? 0}s — release with swarm_release or reap with swarm_reap if abandoned`]
          : []
        return text([head, ...hint, ...tasks.map(line => `  ${line}`),
          ...(value.degraded !== undefined && value.degraded !== '' ? [`  degraded: ${value.degraded}`] : [])].join('\n'))
      },
    },
    async execute(args) {
      const all = await store.readAll()
      const views = viewsOf(all.tasks, Date.now(), staleAssignmentSec)
      const pending = views.filter(view => view.status === 'pending').length
      const claimed = views.filter(view => view.status === 'claimed').length
      const running = views.filter(view => view.status === 'running').length
      const completed = views.filter(view => view.status === 'completed').length
      const failed = views.filter(view => view.status === 'failed').length
      const blocked = views.filter(view => view.status === 'blocked').length
      const ready = views.filter(view => view.ready).length
      const stale = views.filter(view => view.stale).length
      const bigTasks = [...new Set(views.map(view => view.big_task_id).filter(id => id.length > 0))].sort()
      const taskLines = views.map(view => {
        let line = `${view.task_id} [${view.status}${view.ready ? ', ready' : ''}]`
        if (view.claimed_by.length > 0) line += ` by ${view.claimed_by}`
        if (view.stale) {
          if (view.status === 'running') line += ` [STALE, running ${formatAge(view.running_age_sec ?? 0)} ago, heartbeat ${formatAge(view.heartbeat_age_sec ?? 0)} ago]`
          else line += ` [STALE, claimed ${formatAge(view.claimed_age_sec ?? 0)} ago]`
        }
        if (view.blocked_by_open.length > 0) line += ` waiting on ${view.blocked_by_open.join(',')}`
        if (view.status === 'failed' || view.status === 'blocked') {
          line += ` (retry ${view.retry_count}/${view.max_retries}`
          if (view.failure_reason) line += `, reason: ${view.failure_reason}`
          line += ')'
        }
        line += ` — ${view.title}`
        // Routing profile, only when it differs from the defaults (medium/any),
        // so ordinary lines stay readable.
        if (view.complexity !== 'medium' || view.required_worker_tier !== 'any') {
          line += ` [complexity: ${view.complexity}, req: ${view.required_worker_tier}]`
        }
        // Context-integrity marker: a pending task whose declared prerequisites
        // are absent (or whose pinned content digest no longer matches) cannot be
        // claimed, even though DAG-wise it is ready.
        if (view.status === 'pending') {
          const missing = missingRequiredFiles(store, view)
          if (missing.length > 0) line += ` [blocked: missing ${missing.join(', ')}]`
          const mismatch = hashMismatches(store, view)
          if (mismatch.length > 0) line += ` [blocked: hash mismatch on ${mismatch.map(m => m.file).join(', ')}]`
        }
        return line
      })
      let degraded = all.io.degraded ?? store.degraded ?? ''
      let logOutput = ''
      if (args.include_log) {
        for (const view of views) {
          const log = await readLog(store, view.task_id)
          if (log.length > 0) {
            logOutput += `\n  ${view.task_id} log:\n    ${log.join('\n    ')}`
          }
        }
      }
      return {
        dir: TASKS_DIR,
        total: views.length,
        pending,
        claimed,
        running,
        completed,
        failed,
        blocked,
        ready,
        stale,
        stale_after_sec: staleAssignmentSec,
        big_tasks: bigTasks,
        tasks: taskLines,
        degraded: (degraded + logOutput).trim(),
      }
    },
  })))

  // ---------------------------------------------------------- swarm_release ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_release',
    description:
      'Return a claimed task to the pool so another worker can pick it up. Use it when the worker holding a task '
      + 'disappeared before finishing (interrupted, closed, crashed): without this, the claim never expires, the '
      + 'task stays claimed forever, and every task blocked by it stays unreachable. Only a claimed task can be '
      + 'released — completing a task is a different transition, and a completed task is never re-opened by this.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Claimed task to return to the pool' },
      released_by: { type: 'string', required: true, description: 'Who is releasing it, e.g. lead' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['released', 'not_found', 'invalid_state', 'io_error'] },
          message: { type: 'string' },
          released_by: { type: 'string' },
          released_at: { type: 'string' },
          lock_removed: { type: 'boolean' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + (value.lock_removed === true ? '\n  note: the stale lock file was removed too' : '')
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      const outcome = await releaseTask(store, args.task_id, args.released_by)
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        released_by: outcome.released_by,
        released_at: outcome.released_at,
        lock_removed: outcome.lock_removed,
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // ------------------------------------------------------------ swarm_start ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_start',
    description:
      'Start a claimed task: claimed -> running. Records the start time and initial heartbeat. '
      + 'Only a claimed task can be started. The worker must call this after claiming and before executing.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to start' },
      started_by: { type: 'string', required: true, description: 'Agent id starting the task' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['started', 'not_found', 'invalid_state', 'io_error'] },
          message: { type: 'string' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      const outcome = await startTask(store, args.task_id, args.started_by)
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // -------------------------------------------------------- swarm_heartbeat ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_heartbeat',
    description:
      'Renew the lease on a task you hold: update heartbeat_at to now. Only a claimed or running task can '
      + 'heartbeat, and only the agent recorded in claimed_by may renew it (otherwise not_owner). Long-running '
      + 'workers should call this well inside staleAssignmentSec so swarm_reap does not reclaim live work.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task you hold' },
      agent_id: { type: 'string', required: true, description: 'Agent id that claimed the task' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['heartbeat', 'not_found', 'invalid_state', 'not_owner', 'io_error'] },
          message: { type: 'string' },
          heartbeat_at: { type: 'string' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + (value.heartbeat_at !== undefined && value.heartbeat_at !== '' ? `\n  heartbeat_at: ${value.heartbeat_at}` : '')
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      const outcome = await heartbeatTask(store, args.task_id, args.agent_id)
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        heartbeat_at: outcome.heartbeat_at ?? '',
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // ------------------------------------------------------------ swarm_reap ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_reap',
    description:
      'Watchdog: scan claimed/running tasks and recover those past the staleAssignmentSec threshold. '
      + '- claimed (not running) past threshold: revert to pending, delete lock. '
      + '- running past threshold: mark failed (heartbeat timeout), increment retry_count; if retry_count >= max_retries, mark blocked. '
      + 'Returns list of reaped tasks and their outcomes. Call periodically from the Lead.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reaped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string' },
                action: { type: 'string', enum: ['released', 'failed', 'blocked'] },
                message: { type: 'string' },
              },
            },
          },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const reaped = value.reaped ?? []
        if (reaped.length === 0) return text('reap: nothing to reap')
        return text('reap: ' + reaped.length + ' task(s)\n'
          + reaped.map(r => `  ${r.task_id}: ${r.action} — ${r.message}`).join('\n')
          + (value.degraded ? `\n  degraded: ${value.degraded}` : ''))
      },
    },
    async execute() {
      const outcome = await reapTask(store, staleAssignmentSec)
      return {
        ok: outcome.ok,
        reaped: outcome.reaped,
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))

  // --------------------------------------------------------- swarm_set_deps ---
  disposers.push(ctx.tools.register(defineTool({
    name: 'swarm_set_deps',
    description:
      'LEAD ONLY — replace one task\'s blocked_by list. Do not call this as a worker: if you hit a dependency '
      + 'conflict while executing (two tasks touching one file, or a serialisation chain that was never declared '
      + 'at plan time), report it to the Lead with send_message and let the Lead decide. Dependency editing is '
      + 'centralised on purpose — concurrent edits by workers would race each other and could interleave into a '
      + 'cycle. The Lead uses this to serialise conflicting tasks after the fact, which planning could not know '
      + 'about. Rejects unknown task ids (invalid_dependency) and any change that would close a dependency cycle '
      + '(cycle_detected), including a self-reference.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task whose dependency list is being replaced' },
      blocked_by: {
        type: 'array',
        required: true,
        description: 'The complete new dependency list; an empty array clears all dependencies',
        items: { type: 'string' },
      },
      updated_by: { type: 'string', required: true, description: 'Who is making the change, e.g. lead' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string', enum: ['updated', 'not_found', 'invalid_dependency', 'cycle_detected', 'io_error'] },
          message: { type: 'string' },
          blocked_by: { type: 'array', items: { type: 'string' } },
          updated_by: { type: 'string' },
          degraded: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.ok === true ? 'OK' : 'REJECTED'} ${value.code ?? '?'}: ${value.message ?? ''}`
        + ((value.blocked_by ?? []).length > 0 ? `\n  blocked_by now: ${(value.blocked_by ?? []).join(', ')}` : '')
        + (value.degraded !== undefined && value.degraded !== '' ? `\n  degraded: ${value.degraded}` : '')),
    },
    async execute(args) {
      const outcome = await setDependencies(store, args.task_id, args.blocked_by ?? [], args.updated_by)
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        blocked_by: outcome.blocked_by,
        updated_by: outcome.updated_by,
        degraded: outcome.degraded ?? store.degraded ?? '',
      }
    },
  })))
}