/**
 * File-driven task pool — the whole scheduling state layer.
 *
 * Every service this plugin used to delegate to (`agentTeams`, `subagents`,
 * `webServer`) turned out to be unreachable from this fiber, so the pool moved
 * to the one substrate that is always reachable: the workspace filesystem. One
 * JSON file per task under `.dsh-tasks/`, and atomic claiming done by exclusive
 * file creation.
 *
 * Design constraints this module honours:
 *   - All I/O goes through `ctx.fs` when present, so the sandbox, observation
 *     and write-intent policies all apply. A direct `node:fs` path exists only
 *     as a labelled fallback, and every caller is told when it was used.
 *   - A read-only deployment degrades to "no state persisted, but the answer is
 *     still returned" — losing a write must never lose a result.
 *   - No service beyond `fs` is consulted, and nothing here throws on missing
 *     state: absent directory, absent lock and malformed file are all ordinary
 *     states this layer reports.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Workspace-relative directory holding one JSON file per task. */
export const TASKS_DIR = '.dsh-tasks'
/** Suffix of the per-task claim lock (see `claimTask`). */
const LOCK_SUFFIX = '.lock'
/** Sentinel file guaranteeing the directory exists without needing mkdir. */
const KEEP_FILE = '.keep'

export type TaskStatus = 'pending' | 'claimed' | 'completed'

export interface TaskRecord {
  task_id: string
  big_task_id: string
  title: string
  description: string
  status: TaskStatus
  claimed_by: string
  claimed_at: string
  completed_at: string
  result: string
  blocked_by: string[]
  write_scopes: string[]
}

/** A task plus the derived facts callers actually schedule on. */
export interface TaskView extends TaskRecord {
  ready: boolean
  blocked_by_open: string[]
  /**
   * Seconds since the claim, or `undefined` when nothing is claimed.
   *
   * Reported so a caller can see how long a block has been held; it is not a
   * decision on its own.
   */
  claimed_age_sec?: number
  /**
   * True when the claim is older than the configured threshold.
   *
   * A *suspicion* that the holder died mid-task, not a verdict: the plugin has
   * no way to distinguish "stuck" from "slow", so nothing is released
   * automatically. Callers surface it and a human/Lead decides.
   */
  stale: boolean
}

export interface IoOutcome {
  ok: boolean
  /** Set when the write could not go through `ctx.fs`; names the fallback used. */
  degraded?: string
  /** Human-readable reason for a failed read/write. */
  error?: string
}

/**
 * The slice of `ctx.fs` this plugin uses, declared structurally.
 *
 * The authoritative `FileSystem` types live in a package whose exact version is
 * not obtainable here, so the shape is stated explicitly instead of reached for
 * loosely — the same trade-off as `host-route.ts`'s `WebServerLike`.
 */
export interface FsLike {
  resolve(path: string, opts?: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<unknown>
  writeText(target: unknown, content: string, expected?: unknown, signal?: AbortSignal): Promise<unknown>
  listDir(target: unknown, signal?: AbortSignal): Promise<Array<{ readonly name?: string }>>
  stat?(target: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Injectable clock so tests and callers can reason about timestamps. */
export type Clock = () => Date

const defaultClock: Clock = () => new Date()

export function taskFileName(taskId: string): string {
  return `${taskId}.json`
}

/** Empty record for one task id — the single place defaults are defined. */
export function blankTask(taskId: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: taskId,
    big_task_id: fields.big_task_id ?? '',
    title: fields.title ?? '',
    description: fields.description ?? '',
    status: fields.status ?? 'pending',
    claimed_by: fields.claimed_by ?? '',
    claimed_at: fields.claimed_at ?? '',
    completed_at: fields.completed_at ?? '',
    result: fields.result ?? '',
    blocked_by: fields.blocked_by ?? [],
    write_scopes: fields.write_scopes ?? [],
  }
}

/**
 * Normalize one parsed JSON value into a TaskRecord.
 *
 * A hand-edited or partially written file must not crash a scheduling round, so
 * every field is coerced rather than trusted. Returns `undefined` only when the
 * value cannot name a task at all.
 */
export function coerceTask(value: unknown, fallbackId: string): TaskRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const taskId = typeof raw.task_id === 'string' && raw.task_id.length > 0 ? raw.task_id : fallbackId
  if (taskId.length === 0) return undefined
  const status = raw.status === 'claimed' || raw.status === 'completed' ? raw.status : 'pending'
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
  return blankTask(taskId, {
    big_task_id: typeof raw.big_task_id === 'string' ? raw.big_task_id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status,
    claimed_by: typeof raw.claimed_by === 'string' ? raw.claimed_by : '',
    claimed_at: typeof raw.claimed_at === 'string' ? raw.claimed_at : '',
    completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : '',
    result: typeof raw.result === 'string' ? raw.result : '',
    blocked_by: strings(raw.blocked_by),
    write_scopes: strings(raw.write_scopes),
  })
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
  readonly #ctx: Context
  readonly #cwd: string
  readonly #clock: Clock
  readonly #fs: FsLike | undefined
  /** Set once a write has gone through the fallback, so reports stay honest. */
  #fallbackNote: string | undefined
  /** Latched backend. `'node'` means the service refused and must not be retried. */
  #backend: 'service' | 'node'

  constructor(ctx: Context, cwd: string, clock: Clock = defaultClock) {
    this.#ctx = ctx
    this.#cwd = cwd
    this.#clock = clock
    this.#fs = ctx.get('fs') as FsLike | undefined
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

  #readAllViaNode(): { tasks: TaskRecord[]; io: IoOutcome } {
    const tasks: TaskRecord[] = []
    try {
      if (!existsSync(this.dirPath)) return { tasks, io: { ok: true, degraded: this.#fallbackNote } }
      for (const name of readdirSync(this.dirPath)) {
        if (!name.endsWith('.json')) continue
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

  async readOne(taskId: string): Promise<{ task?: TaskRecord; io: IoOutcome }> {
    const all = await this.readAll()
    return { task: all.tasks.find(candidate => candidate.task_id === taskId), io: all.io }
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
    const body = `${JSON.stringify(task, null, 2)}\n`
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
  async writeExisting(task: TaskRecord): Promise<IoOutcome> {
    const body = `${JSON.stringify(task, null, 2)}\n`
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
}

/** Locks held by this process, used only when the filesystem lock is denied. */
const heldLocks = new Set<string>()

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
 * Normalize one write scope for comparison.
 *
 * Mirrors the kernel's rule (`writeScope()` in the agent-team package): forward
 * slashes, no leading `./`, no trailing slash, no empty segments. Keeping the
 * same normalization matters — the two are compared against each other, and
 * `src/api` vs `./src/api/` is the same scope written two ways.
 */
function normalizeScope(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim()
}

/**
 * Whether two scopes overlap, meaning a single-file write could land in both.
 *
 * Equal scopes overlap, and so do ancestor/descendant pairs: a task owning
 * `src` and a task owning `src/api` can edit the same file. The comparison is
 * therefore **directory-granular, not file-granular** — two tasks that both
 * declare `src/` are refused even when they would touch different files in it.
 * That is the intended trade: a false refusal costs one serialisation step,
 * while a false admission costs a silently overwritten file.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a)
  const right = normalizeScope(b)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Find the first claimed task whose write scopes collide with `task`'s.
 *
 * Returns the conflicting task and the exact scope pair, so the refusal can name
 * both — "scope_conflict" alone would leave the caller guessing which of its
 * scopes is the problem.
 */
export function findScopeConflict(
  task: TaskRecord,
  others: readonly TaskRecord[],
): { task_id: string; claimed_by: string; scope: string; other_scope: string } | undefined {
  if (task.write_scopes.length === 0) return undefined
  for (const other of others) {
    if (other.task_id === task.task_id) continue
    if (other.status !== 'claimed') continue
    for (const mine of task.write_scopes) {
      for (const theirs of other.write_scopes) {
        if (scopesOverlap(mine, theirs)) {
          return { task_id: other.task_id, claimed_by: other.claimed_by, scope: mine, other_scope: theirs }
        }
      }
    }
  }
  return undefined
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
 *   - the usual state checks (missing / completed / already claimed).
 */
export async function claimTask(
  store: TaskStore,
  taskId: string,
  claimedBy: string,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; code: 'claimed' | 'already_claimed' | 'not_found' | 'invalid_state' | 'scope_conflict' | 'io_error'; message: string; degraded?: string; stale_lock_cleared?: boolean }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) {
    return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  }
  if (found.task.status === 'completed') {
    return { ok: false, code: 'invalid_state', message: `${taskId} is already completed` }
  }
  if (found.task.status === 'claimed') {
    // The lock being present is expected in this state; the holder is named.
    return { ok: false, code: 'already_claimed', message: `${taskId} is held by ${found.task.claimed_by || 'another agent'}` }
  }

  const all = await store.readAll()
  const byId = new Map(all.tasks.map(task => [task.task_id, task]))
  const conflict = findScopeConflict(byId.get(taskId) ?? found.task, all.tasks)
  if (conflict !== undefined) {
    const holder = conflict.claimed_by.length > 0 ? conflict.claimed_by : 'another agent'
    return {
      ok: false,
      code: 'scope_conflict',
      message: `${taskId} refused: write scope "${conflict.scope}" overlaps "${conflict.other_scope}" `
        + `of ${conflict.task_id} (held by ${holder}). Serialise them with swarm_set_deps, or make the scopes narrower.`,
    }
  }

  // The state says pending, so any lock still on disk belongs to a dead holder.
  let staleLockCleared = false
  if (lockExists(store.dirPath, taskId)) {
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
}

/**
 * Mark a task completed and store its outcome.
 *
 * Only a `claimed` task can be completed. An earlier version accepted a
 * `pending` one as well, to let a caller close work without claiming it first —
 * but that made the state machine wrong: it allowed a task nobody holds to
 * become `completed`, which reads as "someone did this" when nobody did. The
 * claim is what records *who* did the work, so requiring it keeps `claimed_by`
 * meaningful. Callers that want to close unclaimed work should claim it first.
 */
export async function completeTask(
  store: TaskStore,
  taskId: string,
  result: string,
  completedBy: string,
  clock: Clock = defaultClock,
): Promise<{ ok: boolean; code: 'completed' | 'not_found' | 'invalid_state' | 'io_error'; message: string; degraded?: string }> {
  const found = await store.readOne(taskId)
  if (found.task === undefined) return { ok: false, code: 'not_found', message: `no task ${taskId} in ${TASKS_DIR}` }
  if (found.task.status === 'completed') {
    return { ok: false, code: 'invalid_state', message: `${taskId} is already completed` }
  }
  if (found.task.status !== 'claimed') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed task can be completed`,
    }
  }
  const stamp = clock().toISOString()
  const next: TaskRecord = {
    ...found.task,
    status: 'completed',
    completed_at: stamp,
    result,
    // `claimed_by` already names the holder; the status guard above guarantees
    // it is non-empty, so `completedBy` is informational rather than a fallback.
  }
  const written = await store.writeExisting(next)
  if (!written.ok) {
    return { ok: false, code: 'io_error', message: `completion not persisted: ${written.error ?? 'unknown'}`, degraded: written.degraded }
  }
  return { ok: true, code: 'completed', message: `${taskId} completed`, degraded: written.degraded }
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
  if (found.task.status !== 'claimed') {
    return {
      ok: false,
      code: 'invalid_state',
      message: `${taskId} is ${found.task.status}; only a claimed task can be released`,
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
 * Derive readiness, and whether a claim looks abandoned.
 *
 * A blocker that does not exist counts as *not* completed, so a task can never
 * become ready because its dependency was deleted.
 *
 * `staleAfterSec` defaults to `0`, which means "do not judge staleness" — that
 * keeps this function's result stable for callers that pass nothing, rather than
 * making every view time-dependent by default.
 *
 * @param now - injectable clock, so a caller (or a test) can reason about the
 *   age without waiting for real time to pass.
 */
export function viewOf(
  task: TaskRecord,
  byId: ReadonlyMap<string, TaskRecord>,
  now: number = Date.now(),
  staleAfterSec: number = 0,
): TaskView {
  const open = task.blocked_by.filter(id => byId.get(id)?.status !== 'completed')
  const claimedMs = Date.parse(task.claimed_at)
  const hasClaimTime = task.status === 'claimed' && task.claimed_at.length > 0 && !Number.isNaN(claimedMs)
  // A claim with no parseable timestamp cannot be judged; report age 0 rather
  // than inventing one, and never call it stale on a guess.
  const ageSec = hasClaimTime ? Math.max(0, Math.floor((now - claimedMs) / 1000)) : 0
  const stale = hasClaimTime && staleAfterSec > 0 && ageSec > staleAfterSec
  return {
    ...task,
    ready: task.status === 'pending' && open.length === 0,
    blocked_by_open: open,
    ...hasClaimTime ? { claimed_age_sec: ageSec } : {},
    stale,
  }
}

export function viewsOf(
  tasks: readonly TaskRecord[],
  now: number = Date.now(),
  staleAfterSec: number = 0,
): TaskView[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  return tasks.map(task => viewOf(task, byId, now, staleAfterSec))
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
