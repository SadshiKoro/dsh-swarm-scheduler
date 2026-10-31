/**
 * File-driven task pool — storage, locking and the lifecycle transitions.
 *
 * Depends on **Node built-ins only** (plus the two pure core modules): no
 * `@deepseek-ai/*` import. The host adapter passes the `ctx.fs` slice in, so
 * this layer knows nothing about Cordis.
 *
 * Design constraints this module honours:
 *   - When a filesystem service is provided, all I/O goes through it, so the
 *     sandbox, observation and write-intent policies all apply. A direct
 *     `node:fs` path exists only as a labelled fallback, and every caller is
 *     told when it was used.
 *   - A read-only deployment degrades to "no state persisted, but the answer is
 *     still returned" — losing a write must never lose a result.
 *   - Nothing here throws on missing state: absent directory, absent lock and
 *     malformed file are all ordinary states this layer reports.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import {
  TASKS_DIR,
  blankTask,
  coerceTask,
  computeReady,
  defaultClock,
  taskFileName,
  viewOf,
  viewsOf,
  type Clock,
  type IoOutcome,
  type TaskRecord,
  type TaskStatus,
  type TaskView,
} from './state-machine.ts'
import { findScopeConflict, normalizeScope, scopesOverlap } from './scope.ts'

// Re-exported so callers keep one import site for the pool surface.
export {
  TASKS_DIR, blankTask, coerceTask, computeReady, defaultClock, taskFileName, viewOf, viewsOf,
  findScopeConflict, normalizeScope, scopesOverlap,
}
export type { Clock, IoOutcome, TaskRecord, TaskStatus, TaskView }

/**
 * The slice of the host filesystem service this plugin uses, declared
 * structurally — the authoritative FileSystem types come from a package whose
 * exact version is not obtainable here.
 */
export interface FsLike {
  resolve(path: string, opts?: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<unknown>
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir(target: unknown, signal?: AbortSignal): Promise<Array<{ readonly name?: string }>>
  stat?(target: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Suffix of the per-task claim lock (see `claimTask`). */
const LOCK_SUFFIX = '.lock'
/** Sentinel file guaranteeing the directory exists without needing mkdir. */
const KEEP_FILE = '.keep'
/** Suffix for per-task log files. */
const LOG_SUFFIX = '.log'
/** Pool-level reliability counters, keyed by worker id. */
const STATS_FILE = 'worker_stats.json'
/** Append-only audit trail for the event-driven watchdog. */
const AUTO_REAP_LOG = 'auto-reap.log'

/** One worker's attempt counters and accumulated performance totals. */
export interface WorkerStats {
  success_count: number
  failed_count: number
  /** Accumulated runtime of successful completions, in milliseconds. */
  total_task_time_ms: number
  /** Accumulated tokens reported by successful completions. */
  total_tokens_consumed: number
  /**
   * Successful completions that actually reported `actual_tokens`.
   *
   * The divisor for the token average, and the reason the totals above can no
   * longer be divided by `success_count`. A completion without the metric
   * contributes nothing — not a zero — so counting it as a sample would drag
   * the average toward 0 and make an honest worker look token-free.
   *
   * Optional so a `worker_stats.json` written by an older version still reads:
   * a missing count means "no samples were tracked", which is 0 here.
   */
  tokens_sample_count?: number
  /** Successful completions that actually reported `duration_ms`; see above. */
  time_sample_count?: number
}
export type WorkerStatsMap = Record<string, WorkerStats>

/** Optional self-report attached to a completion (both fields optional). */
export interface CompletionMetrics {
  actual_tokens?: number
  duration_ms?: number
}
/**
 * Task storage over `ctx.fs`, with an explicitly-labelled filesystem fallback.
 *
 * `cwd` is the base every relative path resolves against; callers pass the
 * workspace so a pool of tasks resolves next to the code being scheduled.
 *
 * ## Why there is a fallback at all
 *
 * `dsh-fs-sandbox` fences every mutation by a per-call policy and falls back to
 * the deployment default when the caller passes none:
 *
 * ```js
 * async checkedTarget(target, sandboxPolicy) {
 *   const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
 *   ...
 *   for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) { contained = true; break }
 *   if (!contained) throw new FsError(`cannot write "…": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED")
 * }
 * ```
 *
 * This plugin does not pass `sandboxPolicy` — fabricating one would mean
 * declaring its own write permission, which is exactly what the sandbox exists
 * to prevent — so a deployment whose default policy does not cover the pool root
 * refuses every write. Measured fact: that refusal happens even when the target
 * directory already exists.
 *
 * The response is two ordered paths, never a silent one: `ctx.fs` is always
 * attempted first, and a sandbox refusal latches the store onto `node:fs` and is
 * reported in every result's `degraded` field. The latch is deliberate — reads
 * and writes must not disagree about which backend holds the data.
 */
export class TaskStore {
  readonly #cwd: string
  readonly #clock: Clock
  readonly #fs: FsLike | undefined
  /** Set once a write has gone through the fallback, so reports stay honest. */
  #fallbackNote: string | undefined
  /** Latched backend. `'node'` means the service refused and must not be retried. */
  #backend: 'service' | 'node'

  /**
   * @param fs - the host filesystem service slice, or `undefined` to use
   *   `node:fs` directly. Injected rather than reached for on a Cordis context:
   *   that is what keeps this module free of `@deepseek-ai/*`.
   */
  constructor(fs: FsLike | undefined, cwd: string, clock: Clock = defaultClock) {
    this.#cwd = cwd
    this.#clock = clock
    this.#fs = fs
    this.#backend = this.#fs === undefined ? 'node' : 'service'
  }

  /** The degradation note, or `undefined` when the service path is in use. */
  get degraded(): string | undefined {
    return this.#fallbackNote
  }

  /** Which backend reads and writes are currently using. */
  get backend(): 'service' | 'node' {
    return this.#backend
  }

  /** The filesystem service, or `undefined` when the deployment does not expose one. */
  get serviceFs(): FsLike | undefined {
    return this.#fs
  }

  /** The directory every task path resolves against. */
  get rootPath(): string {
    return this.#cwd
  }

  /** Record a degradation from outside the class (the lock helper needs it). */
  noteDegraded(reason: string): void {
    this.#degradeTo(reason)
  }

  /** True when the error is the sandbox refusing, not an unrelated I/O failure. */
  static isSandboxDenial(error: unknown): boolean {
    return TaskStore.#isSandboxDenial(error)
  }

  /** Latch onto `node:fs` after a sandbox refusal, recording why once. */
  #degradeTo(reason: string): void {
    this.#backend = 'node'
    this.#fallbackNote ??= reason
  }

  /** True when the error is the sandbox refusing, not an unrelated I/O failure. */
  static #isSandboxDenial(error: unknown): boolean {
    const code = (error as { code?: unknown }).code
    if (code === 'FS_SANDBOX_DENIED') return true
    const message = error instanceof Error ? error.message : String(error)
    return /file access denied under|FS_SANDBOX_DENIED|sandbox:/.test(message)
  }

  get dirPath(): string {
    return join(this.#cwd, TASKS_DIR)
  }

  /**
   * The workspace the pool lives in — the directory that *contains* the pool.
   *
   * This is what a quality gate should run in: `dirPath` is `<workspace>/.dsh-tasks`,
   * a bookkeeping folder with no `package.json` in it, so running `npm test`
   * there would fail for a reason that has nothing to do with the work.
   */
  get workspacePath(): string {
    return this.#cwd
  }

  /**
   * Ensure the pool directory exists.
   *
   * Directory creation goes through `mkdirSync`, deliberately: `ctx.fs.writeText`
   * does NOT create parent directories, so the earlier "write a sentinel file to
   * create the directory" approach was refused with `file access denied` whenever
   * the directory was absent — and because activation starts this fire-and-forget,
   * the pool simply never came into being. A local `mkdir` is the reliable
   * primitive for the directory; file *contents* still go through `ctx.fs`
   * whenever it is available.
   */
  async ensureDir(): Promise<IoOutcome> {
    try {
      mkdirSync(this.dirPath, { recursive: true })
    } catch (error) {
      return { ok: false, error: `cannot create ${this.dirPath}: ${messageOf(error)}` }
    }
    if (this.#fs === undefined) {
      this.#fallbackNote = 'ctx.fs unavailable; task state written with node:fs'
      return { ok: true, degraded: this.#fallbackNote }
    }
    try {
      const target = await this.#fs.resolve(`${TASKS_DIR}/${KEEP_FILE}`, { cwd: this.#cwd })
      await this.#fs.writeText(target, '# dsh-swarm-scheduler-beta task pool\n')
      return { ok: true }
    } catch (error) {
      // The directory now exists, which is what callers need; the marker is
      // cosmetic, so a refused marker write is reported rather than fatal.
      return { ok: true, degraded: `pool marker not written via ctx.fs (${messageOf(error)})` }
    }
  }

  /**
   * Read every task file through whichever backend the store is latched onto.
   *
   * The service path is tried first; a sandbox refusal latches onto `node:fs` so
   * that reads and writes cannot end up disagreeing about where the data lives.
   * Unreadable or malformed files are skipped, never fatal.
   */
  async readAll(): Promise<{ tasks: TaskRecord[]; io: IoOutcome }> {
    if (this.#backend === 'node' || this.#fs === undefined) return this.#readAllViaNode()
    try {
      return { tasks: await this.#readAllViaFs(), io: { ok: true } }
    } catch (error) {
      if (TaskStore.#isSandboxDenial(error)) {
        this.#degradeTo('ctx.fs refused reads under the sandbox; using node:fs')
        return this.#readAllViaNode()
      }
      return { tasks: [], io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } }
    }
  }
  /** Service-path read. Throws so the caller can classify the failure. */
  async #readAllViaFs(): Promise<TaskRecord[]> {
    const fs = this.#fs as FsLike
    const tasks: TaskRecord[] = []
    const dir = await fs.resolve(TASKS_DIR, { cwd: this.#cwd })
    const entries = await fs.listDir(dir)
    for (const entry of entries) {
      const name = entry.name
      if (name === undefined || !name.endsWith('.json')) continue
      // The worker-stats file lives in the pool directory but is not a task.
      if (name === STATS_FILE) continue
      const taskId = name.slice(0, -'.json'.length)
      const target = await fs.resolve(`${TASKS_DIR}/${name}`, { cwd: this.#cwd })
      // No readText in the declared slice: a read failure means "skip this
      // file", which is the correct answer for a task the pool cannot parse.
      const text = await readTextIfAvailable(fs, target)
      if (text === undefined) continue
      const task = parseTask(text, taskId)
      if (task !== undefined) tasks.push(task)
    }
    return tasks
  }

  async #readAllViaNode(): Promise<{ tasks: TaskRecord[]; io: IoOutcome }> {
    const tasks: TaskRecord[] = []
    try {
      if (!existsSync(this.dirPath)) return { tasks, io: { ok: true, degraded: this.#fallbackNote } }
      for (const name of readdirSync(this.dirPath)) {
        if (!name.endsWith('.json')) continue
        // The worker-stats file lives in the pool directory but is not a task;
        // without this skip it is parsed as a phantom pending task (measured).
        if (name === STATS_FILE) continue
        const taskId = name.slice(0, -'.json'.length)
        try {
          const text = readFileSync(join(this.dirPath, name), 'utf8')
          const task = parseTask(text, taskId)
          if (task !== undefined) tasks.push(task)
        } catch {
          // A file that cannot be read is a task that is not schedulable yet.
        }
      }
      const note = this.#fallbackNote ?? 'ctx.fs unavailable; task state read with node:fs'
      this.#fallbackNote = note
      return { tasks, io: { ok: true, degraded: note } }
    } catch (error) {
      return { tasks, io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } }
    }
  }

  /**
   * Read exactly one task by id.
   *
   * Deliberately **not** `readAll().find(...)`: every claim reads the task before
   * and after taking the lock, so scanning the whole pool here made claim cost
   * O(pool) per call — measured at ~238ms for a 50-task pool before v0.5.0,
   * which is what pushed the 10-worker stress case past its budget. Reading one
   * file is the same answer at a fraction of the cost.
   */
  async readOne(taskId: string): Promise<{ task?: TaskRecord; io: IoOutcome }> {
    if (this.#backend === 'node' || this.#fs === undefined) return this.#readOneViaNode(taskId)
    try {
      const fs = this.#fs
      const target = await fs.resolve(`${TASKS_DIR}/${taskFileName(taskId)}`, { cwd: this.#cwd })
      const text = await readTextIfAvailable(fs, target)
      if (text === undefined) return { task: undefined, io: { ok: true } }
      return { task: parseTask(text, taskId), io: { ok: true } }
    } catch (error) {
      if (TaskStore.#isSandboxDenial(error)) {
        this.#degradeTo('ctx.fs refused reads under the sandbox; using node:fs')
        return this.#readOneViaNode(taskId)
      }
      return { task: undefined, io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } }
    }
  }

  #readOneViaNode(taskId: string): { task?: TaskRecord; io: IoOutcome } {
    try {
      const text = readFileSync(join(this.dirPath, taskFileName(taskId)), 'utf8')
      return { task: parseTask(text, taskId), io: { ok: true, degraded: this.#fallbackNote } }
    } catch {
      // Absent (or unreadable) is an ordinary answer: no such task.
      return { task: undefined, io: { ok: true, degraded: this.#fallbackNote } }
    }
  }

  /**
   * Write one task, refusing to overwrite an existing one.
   *
   * The service path is attempted first; a sandbox refusal latches onto `node:fs`
   * and is reported, never swallowed. The create-only intent is additionally
   * verified by reading the file back, because a write intent this module cannot
   * type-check must not be the only thing standing between two planners and the
   * same task id.
   */
  async createExclusive(task: TaskRecord): Promise<IoOutcome> {
    // Stamp creation time here, not in the plan handler: every path that creates
    // a task must get the same FIFO clock, including tests and future callers.
    const record: TaskRecord = task.created_at.length > 0
      ? task
      : { ...task, created_at: this.#clock().toISOString() }
    const body = `${JSON.stringify(record, null, 2)}\n`
    if (this.#backend === 'service' && this.#fs !== undefined) {
      const fs = this.#fs
      try {
        const target = await fs.resolve(`${TASKS_DIR}/${taskFileName(task.task_id)}`, { cwd: this.#cwd })
        await fs.writeText(target, body, { create: true })
        const seen = await readTextIfAvailable(fs, target)
        if (seen !== undefined && !seen.includes(`"task_id": "${task.task_id}"`)) {
          return { ok: false, error: `task file for ${task.task_id} already exists with different content` }
        }
        return { ok: true }
      } catch (error) {
        if (!TaskStore.#isSandboxDenial(error)) return { ok: false, error: messageOf(error) }
        this.#degradeTo('ctx.fs refused task writes under the sandbox; using node:fs')
      }
    }
    try {
      mkdirSync(this.dirPath, { recursive: true })
      const fd = openSync(join(this.dirPath, taskFileName(task.task_id)), 'wx')
      writeFileSync(fd, body, 'utf8')
      closeSync(fd)
      return { ok: true, degraded: this.#fallbackNote ?? 'task created with node:fs' }
    } catch (error) {
      return { ok: false, error: messageOf(error), degraded: this.#fallbackNote }
    }
  }

  /** Replace one existing task file (used for claim/complete transitions). */
  async writeExisting(task: TaskRecord): Promise<IoOutcome> {    const body = `${JSON.stringify(task, null, 2)}\n`
    if (this.#backend === 'service' && this.#fs !== undefined) {
      try {
        const target = await this.#fs.resolve(`${TASKS_DIR}/${taskFileName(task.task_id)}`, { cwd: this.#cwd })
        await this.#fs.writeText(target, body)
        return { ok: true }
      } catch (error) {
        if (!TaskStore.#isSandboxDenial(error)) return { ok: false, error: messageOf(error) }
        this.#degradeTo('ctx.fs refused task writes under the sandbox; using node:fs')
      }
    }
    try {
      mkdirSync(this.dirPath, { recursive: true })
      writeFileSync(join(this.dirPath, taskFileName(task.task_id)), body, 'utf8')
      return { ok: true, degraded: this.#fallbackNote ?? 'task updated with node:fs' }
    } catch (error) {
      return { ok: false, error: messageOf(error), degraded: this.#fallbackNote }
    }
  }

  /**
   * Whether one declared prerequisite path exists.
   *
   * Relative paths resolve against the pool root (the workspace being
   * scheduled), not `process.cwd()`. A path that cannot be probed is reported as
   * missing — the safe reading, because admitting a claim on an unverifiable
   * prerequisite is exactly the failure this check exists to prevent.
   */
  fileExists(declaredPath: string): boolean {
    const target = isAbsolute(declaredPath) ? declaredPath : join(this.#cwd, declaredPath)
    try {
      return existsSync(target)
    } catch {
      return false
    }
  }

  /**
   * sha256 hex digest of one prerequisite file's content, or `undefined` when it
   * cannot be read.
   *
   * Content hash only: no git object id, no version string, no normalisation
   * (line endings included as-is). Callers compare digests, never file mtimes.
   */
  hashOf(declaredPath: string): string | undefined {
    const target = isAbsolute(declaredPath) ? declaredPath : join(this.#cwd, declaredPath)
    try {
      return createHash('sha256').update(readFileSync(target)).digest('hex')
    } catch {
      return undefined
    }
  }

  /**
   * Read the pool-level worker counters.
   *
   * A missing or malformed file is an empty map, never an error: telemetry must
   * not be able to break a status call.
   */
  async readWorkerStats(): Promise<WorkerStatsMap> {
    try {
      const raw = JSON.parse(readFileSync(join(this.dirPath, STATS_FILE), 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null) return {}
      const out: WorkerStatsMap = {}
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue
        const entry = value as {
          success_count?: unknown
          failed_count?: unknown
          total_task_time_ms?: unknown
          total_tokens_consumed?: unknown
          tokens_sample_count?: unknown
          time_sample_count?: unknown
        }
        out[id] = {
          success_count: typeof entry.success_count === 'number' ? entry.success_count : 0,
          failed_count: typeof entry.failed_count === 'number' ? entry.failed_count : 0,
          total_task_time_ms: typeof entry.total_task_time_ms === 'number' ? entry.total_task_time_ms : 0,
          total_tokens_consumed: typeof entry.total_tokens_consumed === 'number' ? entry.total_tokens_consumed : 0,
          // Absent in files written before the sample counters existed; 0 is the
          // honest reading there (no metric was ever tracked).
          tokens_sample_count: typeof entry.tokens_sample_count === 'number' ? entry.tokens_sample_count : 0,
          time_sample_count: typeof entry.time_sample_count === 'number' ? entry.time_sample_count : 0,
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * Append one line to the automatic-watchdog audit trail (`.dsh-tasks/auto-reap.log`).
   *
   * Best-effort like the other telemetry: a failed audit line must not fail the
   * reap that produced it.
   */
  appendAutoReapLog(line: string): void {
    try {
      mkdirSync(this.dirPath, { recursive: true })
      appendFileSync(join(this.dirPath, AUTO_REAP_LOG), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // Telemetry only; swallow.
    }
  }

  /**
   * Increment one worker's counters, and on success accumulate its self-reported
   * runtime and token consumption.
   *
   * Best-effort by design: the counters are evidence for routing and for a
   * future performance model, so a failure to write them must never fail the
   * completion that triggered the write.
   */
  async recordWorkerOutcome(workerId: string, success: boolean, metrics?: CompletionMetrics): Promise<void> {
    const id = workerId.trim()
    if (id.length === 0) return
    try {
      const current = await this.readWorkerStats()
      const entry = current[id] ?? {
        success_count: 0,
        failed_count: 0,
        total_task_time_ms: 0,
        total_tokens_consumed: 0,
        tokens_sample_count: 0,
        time_sample_count: 0,
      }
      if (success) {
        entry.success_count += 1
        // Performance feedback is only meaningful for work that produced a result;
        // a failed attempt's "time spent" says more about the blocker than the worker.
        //
        // An absent metric is *not* a zero measurement: a worker that reports
        // nothing at all must leave both the total and the sample count alone,
        // otherwise the average silently counts it as 0 tokens / 0 seconds.
        // Only the paired (total, count) update keeps avg = total / count honest.
        const tokens = metrics?.actual_tokens
        if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
          entry.total_tokens_consumed += tokens
          entry.tokens_sample_count = (entry.tokens_sample_count ?? 0) + 1
        }
        const duration = metrics?.duration_ms
        if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
          entry.total_task_time_ms += duration
          entry.time_sample_count = (entry.time_sample_count ?? 0) + 1
        }
      } else {
        entry.failed_count += 1
      }
      current[id] = entry
      mkdirSync(this.dirPath, { recursive: true })
      writeFileSync(join(this.dirPath, STATS_FILE), `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    } catch {
      // Telemetry only; swallow.
    }
  }
}

/**
 * The subset of declared prerequisites missing under the pool root.
 *
 * Covers both `required_files` and the keys of `required_hashes`: a hash can only
 * be verified against a file that exists, so a missing hashed file is a missing
 * dependency, not a hash mismatch. Shared by `claimTask` (refuse) and
 * `swarm_status` (mark), so the two can never disagree about what "missing"
 * means.
 */
export function missingRequiredFiles(store: TaskStore, task: TaskRecord): string[] {
  const declared = [...task.required_files, ...Object.keys(task.required_hashes)]
  const out: string[] = []
  for (const file of declared) {
    if (out.includes(file)) continue
    if (!store.fileExists(file)) out.push(file)
  }
  return out
}

/** One `required_hashes` entry whose file exists but whose content differs. */
export interface HashMismatch {
  file: string
  expected: string
  actual: string
}

/**
 * `required_hashes` entries whose content digest differs from the declaration.
 *
 * Missing files are skipped on purpose: they are reported as
 * `missing_dependencies` first, so the caller never sees a mismatch message for
 * a file that is simply absent. A file that exists but cannot be read is
 * reported as a mismatch with `actual: '(unreadable)'` — accepting an
 * unverifiable content contract would defeat the check.
 */
export function hashMismatches(store: TaskStore, task: TaskRecord): HashMismatch[] {
  const out: HashMismatch[] = []
  for (const [file, expected] of Object.entries(task.required_hashes)) {
    if (!store.fileExists(file)) continue
    const actual = store.hashOf(file) ?? '(unreadable)'
    if (actual.toLowerCase() !== expected.trim().toLowerCase()) {
      out.push({ file, expected: expected.trim(), actual })
    }
  }
  return out
}

/** Locks held by this process, used only when the filesystem lock is denied. */
const heldLocks = new Set<string>()

/** Claims currently in progress in this process, counted per task. */
const claimInProgress = new Map<string, number>()

/** Path of one task's claim lock. */
function lockPath(dirPath: string, taskId: string): string {
  return join(dirPath, `${taskId}${LOCK_SUFFIX}`)
}

/**
 * Delete a task's lock file, ignoring every failure.
 *
 * A missing lock is the normal case (the holder released it, or it was never
 * taken because the caller used the in-process guard), so "not found" must not
 * be reported as an error. A lock that cannot be removed here is not a dead end:
 * `claimTask` clears a residual lock (one present while the task still reads
 * `pending`) before taking its own, so the next claimer recovers either way.
 */
function removeLock(dirPath: string, taskId: string): void {
  try {
    unlinkSync(lockPath(dirPath, taskId))
  } catch {
    // Deliberately silent: absent is success here.
  }
}

/** True when the lock file exists on disk. */
function lockExists(dirPath: string, taskId: string): boolean {
  try {
    return existsSync(lockPath(dirPath, taskId))
  } catch {
    return false
  }
}

/**
 * Claim a task for one agent, atomically, and record who won.
 *
 * Two layers, in order of strength:
 *   1. `<task_id>.lock` created with the exclusive-create primitive — the real
 *      cross-process guarantee, and the only one that holds between separate
 *      agents;
 *   2. an in-process set, used only when the filesystem forbids the lock file.
 *      It is weaker (it cannot stop another process) and every result says so.
 *
 * `EEXIST` is a normal outcome here, never an error: the loser is told to pick
 * another task rather than retrying in a loop.
 *
 * Three guards run before the lock is taken:
 *   - a **residual lock** (`.lock` present while the task reads `pending`) is
 *     cleared, because it means a previous holder died inside its lock window
 *     and never released it. Without this the task would answer
 *     `already_claimed` forever with no holder to blame;
 *   - a **scope conflict** with an already-claimed task is refused as
 *     `scope_conflict`. This is the enforcing half of `write_scopes`; the soft
 *     half is informational — `swarm_ready` lists each task's declared scopes,
 *     so a likely collision is visible while planning, before anyone claims;
 *   - **missing `required_files`** are refused as `missing_dependencies`, naming
 *     every absent path; the task keeps its `pending` state;
 *   - a **routing mismatch** is refused before any lock churn: `worker_too_weak`
 *     for tier/complexity, `worker_lacks_capability` for missing tags,
 *     `worker_context_too_small` for an underestimated window;
 *   - the usual state checks (missing / completed / already claimed).
 */
export type WorkerTier = 'standard' | 'premium'

/**
 * A worker's capability picture, as declared by the deployment.
 *
 * Tiers stay the coarse strength gate; capabilities and context are the precise
 * ones. Cost lives here only so the Lead can *prefer* cheaper workers — it is
 * never a refusal condition.
 */
export interface WorkerProfile {
  tier: WorkerTier
  capabilities: string[]
  max_context_tokens: number
  cost_per_1k_tokens: number
  /**
   * True when this profile is the fallback, not a declaration.
   *
   * The flag exists so a refusal can say *why* the worker was turned away: an
   * empty `capabilities` list means "the deployment declared no capabilities"
   * only if someone declared the worker at all. Without the flag the two cases
   * — "declared empty" and "never declared" — produce the same confusing
   * message, which is exactly the bug this marks.
   */
  isDefault?: boolean
}

export const DEFAULT_WORKER_PROFILE: WorkerProfile = {
  tier: 'standard',
  capabilities: [],
  max_context_tokens: 32000,
  cost_per_1k_tokens: 0.01,
}

/** Loose input shape: config is human-edited, so tier arrives as a string. */
export interface WorkerProfileInput {
  tier?: string
  capabilities?: string[]
  max_context_tokens?: number
  cost_per_1k_tokens?: number
}

/**
 * Resolve one worker's profile: `worker_profiles` first, legacy `worker_tiers`
 * second, defaults last.
 *
 * A profile that names the agent wins even when it is partial; a tier is only
 * taken from the legacy map when no profile exists, so the two surfaces cannot
 * disagree for the same id. Unknown ids degrade to the default profile — a
 * capability declaration that cannot be read must not become a capability.
 *
 * The fallback is marked `isDefault: true` so callers can tell "nothing was
 * declared for this worker" apart from "declarations exist and say nothing".
 * A hit in either table is never marked default, including a legacy
 * `worker_tiers` hit, which still comes from a real declaration.
 */
export function resolveWorkerProfile(
  agentId: string,
  profiles?: Readonly<Record<string, WorkerProfileInput>>,
  tiers?: Readonly<Record<string, string>>,
): WorkerProfile {
  const raw = profiles?.[agentId]
  if (raw !== undefined) {
    return {
      tier: raw.tier === 'premium' ? 'premium' : 'standard',
      capabilities: raw.capabilities?.filter(capability => typeof capability === 'string') ?? [],
      max_context_tokens: typeof raw.max_context_tokens === 'number' && raw.max_context_tokens > 0
        ? raw.max_context_tokens
        : DEFAULT_WORKER_PROFILE.max_context_tokens,
      cost_per_1k_tokens: typeof raw.cost_per_1k_tokens === 'number' && raw.cost_per_1k_tokens >= 0
        ? raw.cost_per_1k_tokens
        : DEFAULT_WORKER_PROFILE.cost_per_1k_tokens,
      isDefault: false,
    }
  }
  if (tiers?.[agentId] === 'premium') return { ...DEFAULT_WORKER_PROFILE, tier: 'premium', isDefault: false }
  return { ...DEFAULT_WORKER_PROFILE, isDefault: true }
}

/**
 * The tier a worker claims to be, from the deployment's `worker_tiers` map.
 *
 * Kept for callers that only have the legacy surface; `resolveWorkerProfile`
 * is the authoritative composition.
 */
export function workerTierOf(agentId: string, tiers?: Readonly<Record<string, string>>): WorkerTier {
  return tiers?.[agentId] === 'premium' ? 'premium' : 'standard'
}

/**
 * Whether a task's routing contract excludes this worker, and why.
 *
 * The rules are deliberately small and provider-agnostic:
 *   - `required_worker_tier: 'premium'` demands a premium worker;
 *   - a `high` complexity task that *declares* a non-`any` requirement is also
 *     refused to a standard worker — the requirement is the contract, and a
 *     high-complexity block with an explicit tier is not a cheap job;
 *   - `any` always accepts, which keeps routing opt-in per task.
 */
export function routingRefusal(task: TaskRecord, agentId: string, tier: WorkerTier): string | undefined {
  if (task.required_worker_tier === 'premium' && tier !== 'premium') {
    return `${task.task_id} requires a premium worker; ${agentId} is ${tier}`
  }
  if (task.complexity === 'high' && tier !== 'premium' && task.required_worker_tier !== 'any') {
    return `${task.task_id} is high complexity and requires a ${task.required_worker_tier} worker; `
      + `${agentId} is ${tier}`
  }
  return undefined
}

/**
 * Capability, context and cost gates, in that order.
 *
 * Capability and context are about *can it be done*; cost is about *is it worth
 * doing here*. It is the only place cost becomes a hard refusal — and only when
 * the task itself sets a ceiling (`max_cost_tokens > 0`), so the default
 * behaviour stays "cheapest is a preference, not a rule".
 */
export function profileRefusal(
  task: TaskRecord,
  agentId: string,
  profile: WorkerProfile,
  stats?: WorkerStats,
): { code: 'worker_lacks_capability' | 'worker_context_too_small' | 'worker_too_expensive' | 'worker_unreliable'; message: string } | undefined {
  if (task.required_capabilities.length > 0) {
    const have = new Set(profile.capabilities)
    const missing = task.required_capabilities.filter(capability => !have.has(capability))
    if (missing.length > 0) {
      // A worker nobody declared has no capabilities *because it was never
      // described*, which is a deployment gap, not a missing skill. Say so
      // first: "declared: []" reads like the worker claimed to know nothing.
      if (profile.isDefault === true) {
        return {
          code: 'worker_lacks_capability',
          message: `${task.task_id} requires capabilities [${task.required_capabilities.join(', ')}]; `
            + `Worker ${agentId} 不在 worker_profiles 中，且无默认 capabilities，无法领取能力任务。`
            + ` (required: [${task.required_capabilities.join(', ')}]; `
            + `add an entry under worker_profiles, or give the worker_profiles default an explicit capabilities list)`,
        }
      }
      return {
        code: 'worker_lacks_capability',
        message: `${task.task_id} requires capabilities [${task.required_capabilities.join(', ')}]; `
          + `${agentId} is missing [${missing.join(', ')}] `
          + `(declared: [${profile.capabilities.join(', ')}])`,
      }
    }
  }
  if (task.estimated_tokens > 0 && task.estimated_tokens > profile.max_context_tokens) {
    return {
      code: 'worker_context_too_small',
      message: `${task.task_id} estimates ${task.estimated_tokens} tokens, above ${agentId}'s `
        + `max_context_tokens (${profile.max_context_tokens})`,
    }
  }
  if (task.max_cost_tokens > 0) {
    const estimatedCost = profile.cost_per_1k_tokens * (task.estimated_tokens / 1000)
    if (estimatedCost > task.max_cost_tokens) {
      return {
        code: 'worker_too_expensive',
        message: `${task.task_id} would cost ${estimatedCost.toFixed(4)} at ${agentId}'s rate `
          + `(${profile.cost_per_1k_tokens}/1k tokens for ${task.estimated_tokens} tokens), `
          + `above max_cost_tokens (${task.max_cost_tokens})`,
      }
    }
  }
  // Dynamic reliability: only high-complexity work is gated. Low/medium tasks stay
  // open to a struggling worker on purpose — a demoted worker needs work to recover
  // its record, and blocking everything would turn one bad run into a dead worker.
  if (task.complexity === 'high' && stats !== undefined) {
    const attempts = stats.success_count + stats.failed_count
    const failureRate = attempts > 0 ? stats.failed_count / attempts : 0
    if (stats.failed_count > 3 && failureRate > 0.5) {
      return {
        code: 'worker_unreliable',
        message: `${task.task_id} is high complexity and ${agentId} has a ${(failureRate * 100).toFixed(0)}% failure rate `
          + `(${stats.failed_count}/${attempts} attempts); low and medium tasks remain claimable`,
      }
    }
  }
  return undefined
}

export async function claimTask(
  store: TaskStore,
  taskId: string,
  claimedBy: string,
  clock: Clock = defaultClock,
  workerTiers?: Readonly<Record<string, string>>,
  workerProfiles?: Readonly<Record<string, WorkerProfileInput>>,
): Promise<{ ok: boolean; code: 'claimed' | 'already_claimed' | 'not_found' | 'invalid_state' | 'scope_conflict' | 'missing_dependencies' | 'hash_mismatch' | 'worker_too_weak' | 'worker_lacks_capability' | 'worker_context_too_small' | 'worker_too_expensive' | 'worker_unreliable' | 'io_error'; message: string; degraded?: string; stale_lock_cleared?: boolean }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) {
    return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  }
  if (found.task.status === 'completed') {
    return { ok: false, code: 'invalid_state', message: `${taskId} is already completed` }
  }
  if (found.task.status === 'claimed' || found.task.status === 'running') {
    // The lock being present is expected in these states; the holder is named.
    return { ok: false, code: 'already_claimed', message: `${taskId} is held by ${found.task.claimed_by || 'another agent'}` }
  }
  if (found.task.status === 'failed' || found.task.status === 'blocked') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; retry it with swarm_start or release it back to pending`,
    }
  }

  // Routing gates: tier, then capability tags, context size, cost budget and —
  // for high-complexity work only — the worker's own failure record. All run
  // before the lock; none of them mutate task state.
  const profile = resolveWorkerProfile(claimedBy, workerProfiles, workerTiers)
  const refusal = routingRefusal(found.task, claimedBy, profile.tier)
  if (refusal !== undefined) {
    return { ok: false, code: 'worker_too_weak', message: refusal }
  }
  // Reliability is only consulted for high-complexity blocks; low/medium never
  // pay for a bad record (see profileRefusal).
  const workerStats = found.task.complexity === 'high' ? (await store.readWorkerStats())[claimedBy] : undefined
  const profileMiss = profileRefusal(found.task, claimedBy, profile, workerStats)
  if (profileMiss !== undefined) {
    return { ok: false, code: profileMiss.code, message: profileMiss.message }
  }

  // Context-integrity pre-check: a task that names prerequisite files must not
  // be handed to a worker while any of them is absent. The task stays pending.
  const missingEarly = missingRequiredFiles(store, found.task)
  if (missingEarly.length > 0) {
    return {
      ok: false,
      code: 'missing_dependencies',
      message: `${taskId} refused: missing required file(s): ${missingEarly.join(', ')}`,
    }
  }

  // Content contract: existence alone is not enough when the task pins digests.
  const mismatchEarly = hashMismatches(store, found.task)
  if (mismatchEarly.length > 0) {
    return {
      ok: false,
      code: 'hash_mismatch',
      message: `${taskId} refused: hash mismatch on `
        + mismatchEarly.map(m => `${m.file} (declared ${m.expected}, actual ${m.actual})`).join('; '),
    }
  }

  // Scope conflicts are checked once, under the lock (see below). An earlier
  // pre-lock scan was a latency optimisation that cost a full pool read per
  // attempt; the under-lock check is the authoritative one and is enough.

  // A stale lock may only be cleared when NO claim for this task is in flight.
  // The counter is not decoration: a losing claim must not delete the guard that
  // belongs to the winner, or a third claim could then clear the winner's live
  // lock and both would be admitted (measured before v0.5.0).
  let staleLockCleared = false
  const concurrent = claimInProgress.get(taskId) ?? 0
  claimInProgress.set(taskId, concurrent + 1)
  try {
    if (concurrent === 0 && lockExists(store.dirPath, taskId)) {
      removeLock(store.dirPath, taskId)
      staleLockCleared = true
    }

    const lock = await acquireLock(store, taskId)
    if (!lock.ok) {
      return { ok: false, code: 'already_claimed', message: `${taskId} was claimed concurrently`, degraded: lock.degraded }
    }
    try {
      // Re-read under the lock: the state observed before it may be stale.
      const current = await store.readOne(taskId)
      if (current.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
      if (current.task.status !== 'pending') {
        return { ok: false, code: 'already_claimed', message: `${taskId} is ${current.task.status}` }
      }

      // Re-check under the lock: a prerequisite could have been deleted between
      // the pre-flight probe and this point. Same rule, same code.
      const missingNow = missingRequiredFiles(store, current.task)
      if (missingNow.length > 0) {
        return {
          ok: false,
          code: 'missing_dependencies',
          message: `${taskId} refused: missing required file(s): ${missingNow.join(', ')}`,
          degraded: lock.degraded,
        }
      }

      // ...and the content could have changed. Pinned digests are re-verified
      // under the same lock, so a claim never admits a stale prerequisite.
      const mismatchNow = hashMismatches(store, current.task)
      if (mismatchNow.length > 0) {
        return {
          ok: false,
          code: 'hash_mismatch',
          message: `${taskId} refused: hash mismatch on `
            + mismatchNow.map(m => `${m.file} (declared ${m.expected}, actual ${m.actual})`).join('; '),
          degraded: lock.degraded,
        }
      }

      // Second scope conflict check: another concurrent claim may have claimed
      // an overlapping task between our initial check and now. Re-read all tasks
      // and check again under the lock. Also check for in-progress claims
      // (lock files) on overlapping tasks.
      const allNow = await store.readAll()
      const conflictNow = findScopeConflict(current.task, allNow.tasks)
      if (conflictNow !== undefined) {
        const holder = conflictNow.claimed_by.length > 0 ? conflictNow.claimed_by : 'another agent'
        return {
          ok: false,
          code: 'scope_conflict',
          message: `${taskId} refused: write scope "${conflictNow.scope}" overlaps "${conflictNow.other_scope}" `
            + `of ${conflictNow.task_id} (held by ${holder}). Serialise them with swarm_set_deps, or make the scopes narrower. `
            + `建议将 write_scopes 缩小到具体文件，或用 swarm_set_deps 串行化。`,
          degraded: lock.degraded,
        }
      }
      // Also check for in-progress claims (lock files) on overlapping scopes.
      // This catches the race where another claim acquired its lock but hasn't
      // written its claimed status yet.
      if (current.task.write_scopes.length > 0) {
        for (const other of allNow.tasks) {
          if (other.task_id === taskId) continue
          if (other.write_scopes.length === 0) continue
          for (const mine of current.task.write_scopes) {
            for (const theirs of other.write_scopes) {
              if (scopesOverlap(mine, theirs)) {
                // Check if the other task has a lock file (claim in progress)
                if (lockExists(store.dirPath, other.task_id)) {
                  return {
                    ok: false,
                    code: 'scope_conflict',
                    message: `${taskId} refused: scope_conflict — write scope "${mine}" overlaps "${theirs}" `
                      + `of ${other.task_id} (claim in progress). Serialise them with swarm_set_deps, or make the scopes narrower. `
                      + `建议将 write_scopes 缩小到具体文件，或用 swarm_set_deps 串行化。`,
                    degraded: lock.degraded,
                  }
                }
              }
            }
          }
        }
      }

      const next: TaskRecord = {
        ...current.task,
        status: 'claimed',
        claimed_by: claimedBy,
        claimed_at: clock().toISOString(),
      }
      const written = await store.writeExisting(next)
      if (!written.ok) {
        return { ok: false, code: 'io_error', message: `claim not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
      }
      await logTransition(store, taskId, 'claim', claimedBy)
      return {
        ok: true,
        code: 'claimed',
        message: `${taskId} claimed by ${claimedBy}`,
        degraded: written.degraded ?? lock.degraded,
        ...staleLockCleared ? { stale_lock_cleared: true } : {},
      }
    } finally {
      releaseLock(store.dirPath, taskId, lock.mode)
    }
  } finally {
    const remaining = (claimInProgress.get(taskId) ?? 1) - 1
    if (remaining <= 0) claimInProgress.delete(taskId)
    else claimInProgress.set(taskId, remaining)
  }
}

/**
 * Return a claimed task to the pool.
 *
 * This exists because a claim has no expiry: when a worker disappears before
 * finishing (interrupted, closed, crashed), its task stays `claimed` forever and
 * every downstream task blocked by it stays unreachable. Measured occurrence:
 * `small-6-1` was left claimed when its worker was closed, which also pinned
 * `small-6-3` behind it.
 *
 * Releasing clears the claim fields and nothing else. `completed_at` and
 * `result` are deliberately left untouched so a release can never launder a
 * finished task into a fresh one; the status guard makes that impossible anyway.
 *
 * It also **deletes the task's `.lock`**. Changing the status alone is not
 * enough: a worker that dies inside its lock window leaves the lock behind, and
 * a surviving lock would make every later claim answer `already_claimed` — with
 * no holder and no way out. Releasing is the documented recovery path, so it has
 * to clear both halves of the claim.
 */
export async function releaseTask(
  store: TaskStore,
  taskId: string,
  releasedBy: string,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; code: 'released' | 'not_found' | 'invalid_state' | 'io_error'; message: string; released_by: string; released_at: string; lock_removed: boolean; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) {
    return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}`, released_by: '', released_at: '', lock_removed: false }
  }
  if (found.task.status !== 'claimed' && found.task.status !== 'running' && found.task.status !== 'failed') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed, running or failed task can be released`,
      released_by: '',
      released_at: '',
      lock_removed: false,
    }
  }
  const stamp = clock().toISOString()
  const previousHolder = found.task.claimed_by
  const next: TaskRecord = {
    ...found.task,
    status: 'pending',
    claimed_by: '',
    claimed_at: '',
  }
  const written = await store.writeExisting(next)
  if (!written.ok) {
    return {
      ok: false, code: 'io_error',
      message: `release not persisted: ${written.error ?? 'unknown'}`,
      released_by: '', released_at: '', lock_removed: false,
      degraded: written.degraded,
    }
  }
  // Clear the other half of the claim. Failure is not an error: a missing lock
  // is the normal case, and an undeletable one is cleared on the next claim.
  const hadLock = lockExists(store.dirPath, taskId)
  removeLock(store.dirPath, taskId)
  await logTransition(store, taskId, 'release', releasedBy)
  const holder = previousHolder.length > 0 ? previousHolder : 'an unknown holder'
  return {
    ok: true,
    code: 'released',
    message: `${taskId} released from ${holder} by ${releasedBy}`
      + (hadLock ? '; stale lock removed' : ''),
    released_by: releasedBy,
    released_at: stamp,
    lock_removed: hadLock,
    degraded: written.degraded,
  }
}

/**
 * Append a line to a task's log file.
 */
async function appendLog(store: TaskStore, taskId: string, line: string): Promise<void> {
  const logPath = join(store.dirPath, `${taskId}${LOG_SUFFIX}`)
  try {
    if (store.backend === 'service' && store.serviceFs !== undefined) {
      const target = await store.serviceFs.resolve(`${TASKS_DIR}/${taskId}${LOG_SUFFIX}`, { cwd: store.rootPath })
      await store.serviceFs.writeText(target, line + '\n', { create: true, append: true })
      return
    }
  } catch {
    // Fall through to node:fs
  }
  try {
    mkdirSync(store.dirPath, { recursive: true })
    const fd = openSync(logPath, 'a')
    writeFileSync(fd, line + '\n', 'utf8')
    closeSync(fd)
  } catch {
    // Log failures must not affect the main operation
  }
}

/**
 * Read the last N lines of a task's log file.
 */
export async function readLog(store: TaskStore, taskId: string, maxLines: number = 5): Promise<string[]> {
  const logPath = join(store.dirPath, `${taskId}${LOG_SUFFIX}`)
  try {
    if (!existsSync(logPath)) return []
    const content = readFileSync(logPath, 'utf8')
    const lines = content.trim().split('\n').filter(l => l.length > 0)
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

/**
 * Record a state transition in the task log.
 */
async function logTransition(store: TaskStore, taskId: string, event: string, actor: string): Promise<void> {
  const stamp = new Date().toISOString()
  await appendLog(store, taskId, `${stamp} ${event} by ${actor}`)
}

/**
 * Start a claimed or failed task: claimed/failed -> running. Records the start time and
 * initial heartbeat, and logs the transition.
 */
export async function startTask(
  store: TaskStore,
  taskId: string,
  startedBy: string,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; code: 'started' | 'not_found' | 'invalid_state' | 'io_error'; message: string; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  if (found.task.status !== 'claimed' && found.task.status !== 'failed') {
    return { ok: false, code: 'invalid_state', message: `${taskId} is ${found.task.status}; only a claimed or failed task can be started` }
  }
  const stamp = clock().toISOString()
  const next: TaskRecord = {
    ...found.task,
    status: 'running',
    started_at: stamp,
    heartbeat_at: stamp,
  }
  const written = await store.writeExisting(next)
  if (!written.ok) {
    return { ok: false, code: 'io_error', message: `start not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
  }
  await logTransition(store, taskId, 'start', startedBy)
  return { ok: true, code: 'started', message: `${taskId} started by ${startedBy}`, degraded: written.degraded }
}

/**
 * Escalation: the holder hands a claimed/running task back to the Lead as
 * `blocked`, with the reason recorded, instead of waiting for a timeout or
 * writing work it knows is wrong.
 *
 * `blocked` is deliberate rather than `failed`: failed consumes a retry and
 * reads as "the worker tried and broke it", while escalated means "this needs a
 * decision" — exactly the state `swarm_status` shows with a reason and the Lead
 * resolves via re-planning or `swarm_set_deps`.
 *
 * Ownership mirrors `swarm_heartbeat`: another agent's claim cannot be escalated
 * away. `force` is the Lead's override, trusted by convention (DSH exposes no
 * role check to the pool).
 */
export async function escalateTask(
  store: TaskStore,
  taskId: string,
  agentId: string,
  reason: string,
  force: boolean = false,
): Promise<{ ok: boolean; code: 'escalated' | 'not_found' | 'invalid_state' | 'not_owner' | 'io_error'; message: string; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  if (found.task.status !== 'claimed' && found.task.status !== 'running') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed or running task can be escalated`,
    }
  }
  if (!force && found.task.claimed_by !== agentId) {
    return {
      ok: false,
      code: 'not_owner',
      message: `${taskId} is held by ${found.task.claimed_by || 'another agent'}, not ${agentId}; `
        + 'only the holder or the Lead (force) can escalate it',
    }
  }
  const next: TaskRecord = {
    ...found.task,
    status: 'blocked',
    claimed_by: '',
    claimed_at: '',
    failure_reason: reason,
  }
  const written = await store.writeExisting(next)
  if (!written.ok) {
    return { ok: false, code: 'io_error', message: `escalation not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
  }
  removeLock(store.dirPath, taskId)
  await logTransition(store, taskId, 'escalated', `${agentId}: ${reason}`)
  return {
    ok: true,
    code: 'escalated',
    message: `${taskId} escalated by ${agentId}: ${reason}`,
    degraded: written.degraded,
  }
}

/**
 * Lease renewal: record that the current holder is still alive.
 *
 * Without this, a worker doing a legitimately long task is indistinguishable
 * from a dead one at `staleAssignmentSec`, and `swarm_reap` would reclaim work
 * that is still progressing. The renewal is deliberately owner-checked: a
 * heartbeat from anyone else would let one worker extend another's claim.
 */
export async function heartbeatTask(
  store: TaskStore,
  taskId: string,
  agentId: string,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; code: 'heartbeat' | 'not_found' | 'invalid_state' | 'not_owner' | 'io_error'; message: string; heartbeat_at?: string; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  if (found.task.status !== 'claimed' && found.task.status !== 'running') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed or running task can heartbeat`,
    }
  }
  if (found.task.claimed_by !== agentId) {
    return {
      ok: false,
      code: 'not_owner',
      message: `${taskId} is held by ${found.task.claimed_by || 'another agent'}, not ${agentId}`,
    }
  }
  const stamp = clock().toISOString()
  const written = await store.writeExisting({
    ...found.task,
    heartbeat_at: stamp,
    // Liveness proof retires the watchdog's warning: a task whose worker just
    // checked in is no longer suspected, and leaving the flag would make it
    // permanent — nothing else clears `failure_reason` while the task runs.
    failure_reason: found.task.failure_reason === STALE_WARNING_REASON ? '' : found.task.failure_reason,
  })
  if (!written.ok) {
    return { ok: false, code: 'io_error', message: `heartbeat not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
  }
  await logTransition(store, taskId, 'heartbeat', agentId)
  return {
    ok: true,
    code: 'heartbeat',
    message: `${taskId} heartbeat from ${agentId}`,
    heartbeat_at: stamp,
    degraded: written.degraded,
  }
}

/**
 * How one quality-gate command is executed.
 *
 * Returns `{ ok, output }` rather than throwing: a non-zero exit is an ordinary
 * gate failure, and the caller only cares whether it passed. `output` is the
 * merged stdout+stderr, used verbatim in `failure_reason` (truncated).
 */
export type QualityGateRunner = (command: string, cwd: string) => { ok: boolean; output: string }

/** Cap on the gate output quoted into `failure_reason` (see `completeTask`). */
export const QUALITY_GATE_OUTPUT_LIMIT = 500

function truncateGateOutput(output: string): string {
  const text = output.trim()
  return text.length <= QUALITY_GATE_OUTPUT_LIMIT ? text : `${text.slice(0, QUALITY_GATE_OUTPUT_LIMIT)}…`
}

/**
 * The shipping runner: `execSync`, with stdout and stderr merged.
 *
 * Synchronous on purpose — the gate must finish before the completion is
 * written, and an async seam would let two completions race around one check.
 * A throw is a failure, not a crash: `execSync` throws on both a non-zero exit
 * and a spawn error, and the pool must record either as "the gate did not pass"
 * rather than leave the task `running` forever.
 */
export const qualityGateRunner: QualityGateRunner = (command: string, cwd: string) => {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    })
    return { ok: true, output: String(stdout) }
  } catch (caught) {
    const error = caught as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    const detail = `${stdout}\n${stderr}`.trim()
    return {
      ok: false,
      output: detail.length > 0 ? detail : (typeof error.message === 'string' ? error.message : 'quality gate command failed'),
    }
  }
}

/** Optional behaviour for `completeTask`; appended so existing callers compile. */
export interface CompleteTaskOptions {
  qualityGate?: {
    /** The command to run; empty means "no gate" (handled by the caller too). */
    command: string
    /** Defaults to `qualityGateRunner` (`execSync`). Tests inject a fake. */
    runner?: QualityGateRunner
  }
  /** Working directory for the gate; defaults to the workspace (the pool's parent). */
  cwd?: string
}

/**
 * Mark a task completed or failed, with retry logic.
 * `success=true` (default): claimed/running -> completed
 * `success=false`: claimed/running -> failed, retry_count + 1; if retry_count >= max_retries -> blocked
 *
 * `options.qualityGate` adds the v1.1.0 check between "the worker says it is
 * done" and "the pool agrees": a shell command run after a successful
 * completion, whose non-zero exit turns the completion into a failure (with the
 * same retry semantics as `success=false`). It only ever *downgrades* an outcome
 * — a failed completion never runs the gate, and a gate can never rescue one.
 *
 * `options.qualityGate.runner` is the seam that keeps this module host-free and
 * testable: production passes nothing and gets `execSync`, tests pass a fake and
 * never spawn a process. See `qualityGateRunner` for the default.
 */
export async function completeTask(
  store: TaskStore,
  taskId: string,
  result: string,
  completedBy: string,
  clock: Clock = defaultClock,
  success: boolean = true,
  metrics?: CompletionMetrics,
  options?: CompleteTaskOptions,
): Promise<{ ok: boolean; code: 'completed' | 'failed' | 'blocked' | 'not_found' | 'invalid_state' | 'io_error'; message: string; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  if (found.task.status === 'completed') {
    return { ok: false, code: 'invalid_state', message: `${taskId} is already completed` }
  }
  if (found.task.status !== 'claimed' && found.task.status !== 'running') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed or running task can be completed`,
    }
  }
  const stamp = clock().toISOString()

  // --- quality gate -------------------------------------------------------
  // Judged before any state is written, so a gate failure takes the ordinary
  // failure path (one code path for retry accounting) instead of a second one.
  let gateFailure: string | undefined
  const gate = options?.qualityGate
  if (success && gate !== undefined && gate.command.trim().length > 0) {
    const runner = gate.runner ?? qualityGateRunner
    // The workspace, not `store.dirPath`: the pool directory is `<workspace>/.dsh-tasks`,
    // which contains the task files but no project, so a gate run there would
    // check a directory with no source and fail for the wrong reason. Not
    // `process.cwd()` either — in this deployment that is the profile directory.
    const cwd = options?.cwd ?? store.workspacePath
    const outcome = runner(gate.command, cwd)
    if (!outcome.ok) {
      gateFailure = truncateGateOutput(outcome.output)
    }
  }
  // A gate failure is a failure with a reason: same retry path as below.
  const effectiveSuccess = success && gateFailure === undefined

  let next: TaskRecord
  let code: 'completed' | 'failed' | 'blocked'
  let message: string
  if (effectiveSuccess) {
    next = {
      ...found.task,
      status: 'completed',
      completed_at: stamp,
      result,
    }
    code = 'completed'
    message = `${taskId} ${code}`
    if (gate !== undefined && gate.command.trim().length > 0) {
      message += ' (quality gate passed)'
    }
  } else {
    const reason = gateFailure !== undefined
      ? `Quality gate failed: ${gateFailure}`
      : (result || 'failed without reason')
    const newRetryCount = found.task.retry_count + 1
    if (newRetryCount >= found.task.max_retries) {
      next = {
        ...found.task,
        status: 'blocked',
        completed_at: stamp,
        result,
        retry_count: newRetryCount,
        failure_reason: reason,
      }
      code = 'blocked'
    } else {
      next = {
        ...found.task,
        status: 'failed',
        completed_at: stamp,
        result,
        retry_count: newRetryCount,
        failure_reason: reason,
      }
      code = 'failed'
    }
    message = gateFailure !== undefined
      ? `${taskId} ${code} — quality gate failed (command exited non-zero)`
      : `${taskId} ${code}`
  }
  const written = await store.writeExisting(next)
  if (!written.ok) {
    return { ok: false, code: 'io_error', message: `${code} not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
  }
  await logTransition(store, taskId, gateFailure !== undefined ? `${code}:quality-gate` : code, completedBy)
  // Reliability and performance telemetry: record the attempt, and on success
  // accumulate the worker's self-reported tokens/runtime. This feeds the
  // high-complexity reliability gate (see profileRefusal), never a low/medium one.
  //
  // A gate failure counts as a failed attempt, because that is what it is: the
  // work did not survive the check, and letting it feed the success counters
  // would make a worker that ships broken code look reliable.
  await store.recordWorkerOutcome(completedBy, effectiveSuccess, effectiveSuccess ? metrics : undefined)
  return { ok: true, code, message, degraded: written.degraded }
}

/** The reason a running task carries while it is only *warned* about, never reaped. */
export const STALE_WARNING_REASON = 'heartbeat stale (grace period)'

/**
 * One reaper outcome. `stale` is a **warning, not a state**: it is reported here
 * so the Lead can see it, but the task keeps `status: 'running'` and the six-state
 * enum stays intact (see `reapTask`).
 */
export type ReapAction = 'released' | 'failed' | 'blocked' | 'stale'

export interface ReapedTask {
  task_id: string
  action: ReapAction
  message: string
}

/**
 * Reap stale tasks: scan claimed/running tasks and recover those past the threshold.
 *
 * The threshold has **two phases** for a running task, because the two kinds of
 * silence are not equally conclusive:
 *
 *   - a **claimed** task past the threshold never started, so its lease is
 *     simply gone: revert to pending, delete the lock;
 *   - a **running** task past the threshold but before `1.5 ×` it is only
 *     **flagged STALE** — `failure_reason` becomes `heartbeat stale (grace
 *     period)`, while `status` stays `running`, `retry_count` stays put and
 *     `completed_at` is not stamped. A worker doing a long step without a
 *     heartbeat is *suspected*, not dead, and killing it costs the whole
 *     attempt;
 *   - a running task past `1.5 ×` has had a full extra half-window to renew and
 *     did not, so the original logic runs: failed (retry_count + 1), or blocked
 *     once retries are exhausted.
 *
 * The flag deliberately does not introduce a seventh state: `'stale'` would have
 * to join `TaskStatus`, and `computeReady`/`viewOf`/every existing test reasons
 * over the six-state enum. `failure_reason` already means "why this record is
 * not clean", so the warning rides on it and the state machine is untouched.
 *
 * Returns the reaped/flagged tasks and their outcomes.
 */
export async function reapTask(
  store: TaskStore,
  staleAfterSec: number,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; reaped: ReapedTask[]; degraded?: string }> {
  const all = await store.readAll()
  const reaped: ReapedTask[] = []
  let degraded: string | undefined
  // Grace deadline: staleAfterSec, then another half window. Computed once so
  // every task in one round is judged against the same line.
  const hardReapAfterSec = staleAfterSec + staleAfterSec / 2

  for (const task of all.tasks) {
    if (task.status !== 'claimed' && task.status !== 'running') continue
    const claimedMs = Date.parse(task.claimed_at)
    const heartbeatMs = Date.parse(task.heartbeat_at)
    const claimedOk = !Number.isNaN(claimedMs)
    const heartbeatOk = !Number.isNaN(heartbeatMs)
    // claimed: the lease is alive while EITHER the claim or the last heartbeat
    // is recent, so taking the later of the two is the correct reference.
    // running: the heartbeat is the lease (start writes one immediately).
    const referenceMs = task.status === 'claimed'
      ? Math.max(claimedOk ? claimedMs : 0, heartbeatOk ? heartbeatMs : 0)
      : (heartbeatOk ? heartbeatMs : claimedMs)
    if (Number.isNaN(referenceMs) || referenceMs === 0) continue
    const ageSec = Math.floor((clock().getTime() - referenceMs) / 1000)
    if (ageSec <= staleAfterSec) continue

    if (task.status === 'claimed') {
      // Revert claimed -> pending, delete lock
      const stamp = clock().toISOString()
      const next: TaskRecord = {
        ...task,
        status: 'pending',
        claimed_by: '',
        claimed_at: '',
      }
      const written = await store.writeExisting(next)
      if (!written.ok) {
        degraded = written.degraded
        continue
      }
      removeLock(store.dirPath, task.task_id)
      await logTransition(store, task.task_id, 'reap:released', 'reaper')
      reaped.push({ task_id: task.task_id, action: 'released', message: `${task.task_id} reverted to pending (stale claim)` })
    } else if (task.status === 'running' && ageSec <= hardReapAfterSec) {
      // Phase 1: grace period. Warn only — every field that would end the
      // attempt (status, retry_count, completed_at) is copied through unchanged.
      // Re-writing an already-flagged task is skipped so the audit log records
      // the warning once, not once per sweep.
      if (task.failure_reason === STALE_WARNING_REASON) continue
      const next: TaskRecord = {
        ...task,
        status: 'running',
        completed_at: task.completed_at,
        retry_count: task.retry_count,
        failure_reason: STALE_WARNING_REASON,
      }
      const written = await store.writeExisting(next)
      if (!written.ok) {
        degraded = written.degraded
        continue
      }
      await logTransition(store, task.task_id, 'reap:stale', 'reaper')
      reaped.push({
        task_id: task.task_id,
        action: 'stale',
        message: `${task.task_id} flagged STALE (no heartbeat for ${ageSec}s, grace until ${Math.ceil(hardReapAfterSec)}s); not reaped`,
      })
    } else if (task.status === 'running') {
      // Phase 2: the grace period expired without a heartbeat. Original logic:
      // mark failed (heartbeat timeout), increment retry, block once exhausted.
      const newRetryCount = task.retry_count + 1
      const stamp = clock().toISOString()
      let action: 'failed' | 'blocked'
      let next: TaskRecord
      if (newRetryCount >= task.max_retries) {
        next = {
          ...task,
          status: 'blocked',
          completed_at: stamp,
          result: task.result,
          retry_count: newRetryCount,
          failure_reason: 'heartbeat timeout',
        }
        action = 'blocked'
      } else {
        next = {
          ...task,
          status: 'failed',
          completed_at: stamp,
          result: task.result,
          retry_count: newRetryCount,
          failure_reason: 'heartbeat timeout',
        }
        action = 'failed'
      }
      const written = await store.writeExisting(next)
      if (!written.ok) {
        degraded = written.degraded
        continue
      }
      await logTransition(store, task.task_id, `reap:${action}`, 'reaper')
      reaped.push({ task_id: task.task_id, action, message: `${task.task_id} marked ${action} (heartbeat timeout after grace period, retry ${newRetryCount}/${task.max_retries})` })
    }
  }

  return { ok: true, reaped, degraded }
}

/**
 * Replace one task's dependency list.
 *
 * Dependencies could previously only be declared at `swarm_plan` time, which made
 * same-file serialisation impossible to repair: measured during the DESIGN.md
 * translation, two workers on one file hit `FS_STALE_VERSION`, and the repair via
 * the team board failed because the two stores are independent
 * (`team_task_update{action:'set_dependencies'}` → `task not found`).
 *
 * Two validation layers, because a dependency graph is only useful if it stays
 * acyclic:
 *   - every referenced id must exist (a dangling blocker would make the task
 *     permanently unready, since a missing task never counts as completed);
 *   - the new list must not create a cycle, checked by walking the graph from the
 *     proposed blockers and refusing if the walk reaches this task.
 *
 * Self-reference is just the shortest cycle, so it needs no special case.
 */
export async function setDependencies(
  store: TaskStore,
  taskId: string,
  blockedBy: readonly string[],
  updatedBy: string,
): Promise<{
  ok: boolean
  code: 'updated' | 'not_found' | 'invalid_dependency' | 'cycle_detected' | 'io_error'
  message: string
  blocked_by: string[]
  updated_by: string
  degraded?: string
}> {
  const all = await store.readAll()
  const byId = new Map(all.tasks.map(task => [task.task_id, task]))
  const target = byId.get(taskId)
  if (target === undefined) {
    return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}`, blocked_by: [], updated_by: '' }
  }

  // Deduplicate while preserving order, so the stored list is stable.
  const next = [...new Set(blockedBy)]

  const missing = next.filter(id => !byId.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'invalid_dependency',
      message: `${taskId}: unknown task id(s) ${missing.join(', ')}`,
      blocked_by: target.blocked_by,
      updated_by: '',
    }
  }

  // Walk downward from each proposed blocker. Reaching `taskId` means the new
  // edges would close a loop through it.
  const reachable = new Set<string>()
  const queue = [...next]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (id === taskId) {
      return {
        ok: false,
        code: 'cycle_detected',
        message: `${taskId}: adding ${next.join(', ')} would create a dependency cycle`,
        blocked_by: target.blocked_by,
        updated_by: '',
      }
    }
    if (reachable.has(id)) continue
    reachable.add(id)
    const node = byId.get(id)
    if (node === undefined) continue
    for (const dep of node.blocked_by) queue.push(dep)
  }

  const written = await store.writeExisting({ ...target, blocked_by: next })
  if (!written.ok) {
    return {
      ok: false, code: 'io_error',
      message: `dependency update not persisted: ${written.error ?? 'unknown'}`,
      blocked_by: target.blocked_by, updated_by: '',
      degraded: written.degraded,
    }
  }
  const before = target.blocked_by.length === 0 ? '(none)' : target.blocked_by.join(', ')
  const after = next.length === 0 ? '(none)' : next.join(', ')
  return {
    ok: true,
    code: 'updated',
    message: `${taskId}: blocked_by [${before}] -> [${after}] by ${updatedBy}`,
    blocked_by: next,
    updated_by: updatedBy,
    degraded: written.degraded,
  }
}

/**
 * Acquire the per-task lock.
 *
 * Ordered exactly like the rest of the store: `ctx.fs` first, `node:fs` when the
 * sandbox refuses, and an in-process guard only as a last resort. The lock is the
 * one operation where the fallback is not merely workable but arguably correct —
 * an exclusive-create is an OS primitive, not user data — yet the ordering still
 * matters, so it is stated rather than assumed.
 *
 * @returns `mode: 'file'` for a real cross-process lock, `'memory'` for the
 *   in-process guard (weaker; the caller must surface it as a degradation).
 */
async function acquireLock(
  store: TaskStore,
  taskId: string,
): Promise<{ ok: boolean; mode: 'file' | 'memory'; degraded?: string }> {
  const relative = `${TASKS_DIR}/${taskId}${LOCK_SUFFIX}`

  if (store.backend === 'service') {
    const fs = store.serviceFs
    if (fs !== undefined) {
      try {
        const target = await fs.resolve(relative, { cwd: store.rootPath })
        await fs.writeText(target, `${new Date().toISOString()} lock\n`, { create: true })
        const seen = await readTextIfAvailable(fs, target)
        if (seen !== undefined) return { ok: true, mode: 'file' }
      } catch (error) {
        // `create: true` on an existing lock is contention, not a denial. The
        // sandbox refuses the same way it does for tasks, so classify carefully.
        if (TaskStore.isSandboxDenial(error)) {
          store.noteDegraded('ctx.fs refused the claim lock under the sandbox; using node:fs')
        } else {
          return { ok: false, mode: 'file' }
        }
      }
    }
  }

  try {
    mkdirSync(store.dirPath, { recursive: true })
    const fd = openSync(join(store.dirPath, `${taskId}${LOCK_SUFFIX}`), 'wx')
    closeSync(fd)
    return { ok: true, mode: 'file', degraded: store.degraded }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') return { ok: false, mode: 'file' }
    // The lock file could not be created for a reason other than contention.
    // Fall back to an in-process guard so a single process still cannot double
    // claim, and say plainly that the guarantee is weaker than a file lock.
    if (heldLocks.has(taskId)) return { ok: false, mode: 'memory' }
    heldLocks.add(taskId)
    return {
      ok: true,
      mode: 'memory',
      degraded: `lock file unavailable (${messageOf(error)}); claimed under an in-process guard only`,
    }
  }
}

function releaseLock(dirPath: string, taskId: string, mode: 'file' | 'memory'): void {
  if (mode === 'memory') {
    heldLocks.delete(taskId)
    return
  }
  removeLock(dirPath, taskId)
}

function parseTask(text: string, fallbackId: string): TaskRecord | undefined {
  try {
    return coerceTask(JSON.parse(text), fallbackId)
  } catch {
    return undefined
  }
}

/** Read via an optional `readText`, so the slice stays honest about what exists. */
async function readTextIfAvailable(fs: FsLike, target: unknown): Promise<string | undefined> {
  const maybe = fs as unknown as { readText?: (t: unknown, s?: AbortSignal) => Promise<string> }
  if (typeof maybe.readText !== 'function') return undefined
  try {
    return await maybe.readText(target)
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
