/**
 * Pure task-state model: the six-state machine, record shapes, and the derived
 * views callers schedule on.
 *
 * Depends on **Node built-ins only** — no `@deepseek-ai/*` import anywhere in
 * `src/core/`. That is the whole point of the split: the scheduling rules can be
 * reasoned about, tested and reused without a DSH runtime, and the host adapter
 * (`src/tools-file.ts`) is the only place that knows about Cordis.
 *
 * State machine:
 *
 *   pending ──claim──▶ claimed ──start──▶ running ──complete(success)──▶ completed
 *      ▲                  │                  │
 *      │                  │                  └─complete(!success)──▶ failed ──retry▶ (start again)
 *      │                  │                                             │
 *      └──release─────────┘                                             └─retry_count >= max_retries──▶ blocked
 */

/** Workspace-relative directory holding one JSON file per task. */
export const TASKS_DIR = '.dsh-tasks'

export type TaskStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'blocked'

/** How hard a block is, used only for worker routing. */
export type Complexity = 'low' | 'medium' | 'high'
/** Minimum worker class a task accepts; `any` opts out of routing. */
export type WorkerTierRequirement = 'any' | 'standard' | 'premium'

export interface TaskRecord {
  task_id: string
  big_task_id: string
  title: string
  description: string
  status: TaskStatus
  claimed_by: string
  claimed_at: string
  started_at: string
  heartbeat_at: string
  completed_at: string
  result: string
  blocked_by: string[]
  write_scopes: string[]
  retry_count: number
  max_retries: number
  failure_reason: string
  /** ISO timestamp written when the task file is created; drives FIFO ordering. */
  created_at: string
  /** Larger wins a claim race: `computeReady` sorts by this descending. */
  priority: number
  /** Workspace-relative files that must exist before the task may be claimed. */
  required_files: string[]
  /**
   * Content contract for prerequisites: path → expected sha256 hex digest.
   *
   * Checked after existence: a missing file is `missing_dependencies`, an
   * existing file whose content differs is `hash_mismatch`. This is a content
   * hash, not a git object id and not a version string.
   */
  required_hashes: Record<string, string>
  /** Estimated difficulty, used for routing; never mapped to a concrete model. */
  complexity: Complexity
  /** Minimum worker tier; `any` means no routing restriction. */
  required_worker_tier: WorkerTierRequirement
  /** Capability tags the worker must declare; empty means no requirement. */
  required_capabilities: string[]
  /** Rough input size; 0 means "not estimated", which disables the context gate. */
  estimated_tokens: number
  /**
   * Budget ceiling for this task's estimated cost; 0 means no ceiling.
   *
   * Compared against `cost_per_1k_tokens × estimated_tokens / 1000` of the
   * worker. This is the one place where cost is a hard gate; everywhere else it
   * stays a scheduling preference.
   */
  max_cost_tokens: number
}

/** A task plus the derived facts callers actually schedule on. */
export interface TaskView extends TaskRecord {
  ready: boolean
  blocked_by_open: string[]
  /** Seconds since the claim, or `undefined` when nothing is claimed. */
  claimed_age_sec?: number
  /** Seconds since the task started running, or `undefined` when not running. */
  running_age_sec?: number
  /** Seconds since the last heartbeat, or `undefined` when not running. */
  heartbeat_age_sec?: number
  /** True when the claim/running is older than the configured threshold. */
  stale: boolean
}

export interface IoOutcome {
  ok: boolean
  /** Set when the write could not go through `ctx.fs`; names the fallback used. */
  degraded?: string
  /** Human-readable reason for a failed read/write. */
  error?: string
}

/** Injectable clock so tests and callers can reason about timestamps. */
export type Clock = () => Date

export const defaultClock: Clock = () => new Date()

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
    started_at: fields.started_at ?? '',
    heartbeat_at: fields.heartbeat_at ?? '',
    completed_at: fields.completed_at ?? '',
    result: fields.result ?? '',
    blocked_by: fields.blocked_by ?? [],
    write_scopes: fields.write_scopes ?? [],
    retry_count: fields.retry_count ?? 0,
    max_retries: fields.max_retries ?? 3,
    failure_reason: fields.failure_reason ?? '',
    created_at: fields.created_at ?? '',
    priority: fields.priority ?? 0,
    required_files: fields.required_files ?? [],
    required_hashes: fields.required_hashes ?? {},
    complexity: fields.complexity ?? 'medium',
    required_worker_tier: fields.required_worker_tier ?? 'any',
    required_capabilities: fields.required_capabilities ?? [],
    estimated_tokens: fields.estimated_tokens ?? 0,
    max_cost_tokens: fields.max_cost_tokens ?? 0,
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
  const validStatuses: TaskStatus[] = ['pending', 'claimed', 'running', 'completed', 'failed', 'blocked']
  const status = validStatuses.includes(raw.status as TaskStatus) ? (raw.status as TaskStatus) : 'pending'
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
  const num = (input: unknown): number => typeof input === 'number' && Number.isFinite(input) ? input : 0
  const hashMap = (input: unknown): Record<string, string> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  }
  return blankTask(taskId, {
    big_task_id: typeof raw.big_task_id === 'string' ? raw.big_task_id : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status,
    claimed_by: typeof raw.claimed_by === 'string' ? raw.claimed_by : '',
    claimed_at: typeof raw.claimed_at === 'string' ? raw.claimed_at : '',
    started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
    heartbeat_at: typeof raw.heartbeat_at === 'string' ? raw.heartbeat_at : '',
    completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : '',
    result: typeof raw.result === 'string' ? raw.result : '',
    blocked_by: strings(raw.blocked_by),
    write_scopes: strings(raw.write_scopes),
    retry_count: num(raw.retry_count),
    max_retries: num(raw.max_retries) || 3,
    failure_reason: typeof raw.failure_reason === 'string' ? raw.failure_reason : '',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    priority: num(raw.priority),
    required_files: strings(raw.required_files),
    required_hashes: hashMap(raw.required_hashes),
    complexity: raw.complexity === 'low' || raw.complexity === 'high' ? raw.complexity : 'medium',
    required_worker_tier: raw.required_worker_tier === 'standard' || raw.required_worker_tier === 'premium'
      ? raw.required_worker_tier
      : 'any',
    required_capabilities: strings(raw.required_capabilities),
    estimated_tokens: Math.max(0, num(raw.estimated_tokens)),
    max_cost_tokens: Math.max(0, num(raw.max_cost_tokens)),
  })
}

/**
 * Derive readiness, and whether a claim/running looks abandoned.
 *
 * A blocker that does not exist counts as *not* completed, so a task can never
 * become ready because its dependency was deleted.
 *
 * `staleAfterSec` defaults to `0`, which means "do not judge staleness".
 *
 * Staleness follows the **lease**, not the claim timestamp — the same rule
 * `swarm_reap` uses (v0.4.0), so "status says STALE" and "reap reclaims it"
 * cannot disagree:
 *   - `running`: `heartbeat_at`, falling back to `claimed_at` when absent;
 *   - `claimed`: `max(claimed_at, heartbeat_at)`.
 * `claimed_age_sec` stays "how long ago the claim happened" — informational,
 * not the staleness input.
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
  const hasClaimTime = (task.status === 'claimed' || task.status === 'running')
    && task.claimed_at.length > 0 && !Number.isNaN(claimedMs)
  const ageSec = hasClaimTime ? Math.max(0, Math.floor((now - claimedMs) / 1000)) : 0

  const startedMs = Date.parse(task.started_at)
  const hasStartTime = task.status === 'running' && task.started_at.length > 0 && !Number.isNaN(startedMs)
  const runningAgeSec = hasStartTime ? Math.max(0, Math.floor((now - startedMs) / 1000)) : 0

  const heartbeatMs = Date.parse(task.heartbeat_at)
  const hasHeartbeatTime = task.status === 'running' && task.heartbeat_at.length > 0 && !Number.isNaN(heartbeatMs)
  const heartbeatAgeSec = hasHeartbeatTime ? Math.max(0, Math.floor((now - heartbeatMs) / 1000)) : 0

  const leaseMs = leaseReferenceMs(task)
  const leaseAgeSec = leaseMs === undefined ? 0 : Math.max(0, Math.floor((now - leaseMs) / 1000))
  const stale = leaseMs !== undefined && staleAfterSec > 0 && leaseAgeSec > staleAfterSec
  const ready = task.status === 'pending' && open.length === 0

  return {
    ...task,
    ready,
    blocked_by_open: open,
    ...hasClaimTime ? { claimed_age_sec: ageSec } : {},
    ...hasStartTime ? { running_age_sec: runningAgeSec } : {},
    ...hasHeartbeatTime ? { heartbeat_age_sec: heartbeatAgeSec } : {},
    stale,
  }
}

/**
 * The timestamp the lease is judged by, mirroring `swarm_reap`.
 *
 * Returns `undefined` when nothing parseable exists, which means "cannot judge"
 * rather than "stale" — never call a task abandoned on a guess.
 */
function leaseReferenceMs(task: TaskRecord): number | undefined {
  const claimedMs = Date.parse(task.claimed_at)
  const heartbeatMs = Date.parse(task.heartbeat_at)
  const claimedOk = task.claimed_at.length > 0 && !Number.isNaN(claimedMs)
  const heartbeatOk = task.heartbeat_at.length > 0 && !Number.isNaN(heartbeatMs)
  if (task.status === 'claimed') {
    const latest = Math.max(claimedOk ? claimedMs : 0, heartbeatOk ? heartbeatMs : 0)
    return latest === 0 ? undefined : latest
  }
  if (task.status === 'running') {
    if (heartbeatOk) return heartbeatMs
    return claimedOk ? claimedMs : undefined
  }
  return undefined
}

export function viewsOf(
  tasks: readonly TaskRecord[],
  now: number = Date.now(),
  staleAfterSec: number = 0,
): TaskView[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  return tasks.map(task => viewOf(task, byId, now, staleAfterSec))
}

/** What `swarm_ready` is allowed to hand out. */
export interface ReadyResult {
  total: number
  tasks: TaskRecord[]
  /** True when the concurrency ceiling suppressed an otherwise non-empty pool. */
  limited: boolean
  /**
   * Human-readable reason when `limited`, so the adapter has something to show.
   *
   * It lives here rather than in the tool handler so the wording is unit-tested
   * and there is exactly one place that can produce it — the v0.3.0 defect was
   * a second, overriding source in the adapter.
   */
  notice?: string
}

/**
 * Claim order: priority descending, then oldest `created_at` first, then id.
 *
 * The third key is not decoration: two tasks written in the same millisecond (or
 * both missing `created_at`) must still come out in a stable order, otherwise
 * "ready" would reshuffle between calls and a worker could starve a block by
 * re-reading a different permutation each round.
 */
export function compareReadyOrder(a: TaskRecord, b: TaskRecord): number {
  if (b.priority !== a.priority) return b.priority - a.priority
  const at = Date.parse(a.created_at)
  const bt = Date.parse(b.created_at)
  const aHas = a.created_at.length > 0 && !Number.isNaN(at)
  const bHas = b.created_at.length > 0 && !Number.isNaN(bt)
  if (aHas && bHas && at !== bt) return at - bt
  return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0
}

/**
 * The ready pool, capped by the `max_workers` ceiling.
 *
 * The ceiling counts **claimed + running** tasks: those are the workers that are
 * actually consuming capacity. Reaching it is not an error and not an empty
 * pool — the caller is told it was the limit (`limited: true`) so the
 * distinction is observable instead of looking like "nothing to do".
 *
 * Below the ceiling the result is ordered by {@link compareReadyOrder}, so the
 * caller does not have to re-sort and file-traversal order never leaks out.
 */
export function computeReady(
  tasks: readonly TaskRecord[],
  maxWorkers: number,
  filter?: string,
): ReadyResult {
  const active = tasks.filter(task => task.status === 'claimed' || task.status === 'running').length
  if (maxWorkers > 0 && active >= maxWorkers) {
    return { total: 0, tasks: [], limited: true, notice: `max_workers limit (${maxWorkers}) reached` }
  }
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  const ready = tasks
    .map(task => viewOf(task, byId))
    .filter(view => view.ready)
    .filter(view => filter === undefined || view.big_task_id === filter)
    .map(view => tasks.find(task => task.task_id === view.task_id) as TaskRecord)
    .sort(compareReadyOrder)
  return { total: ready.length, tasks: ready, limited: false }
}
