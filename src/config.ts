import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Maximum spawned teammates this scheduler will create and drive. */
  maxWorkers: number
  /** Refuse a plan larger than this, so a decomposition cannot exhaust the Team task board. */
  maxTasksPerPlan: number
  /** Run the pump automatically from agent/status + a fallback timer. */
  autoDispatch: boolean
  /** Fallback poll interval; covers missed events and cold resumes (seed events never publish). */
  autoDispatchFallbackMs: number
  /** An in-progress block whose worker has no turn for this long is flagged STALE_ASSIGNMENT. */
  staleAssignmentSec: number
  /** Hard cap on the compressed report a worker may send back. */
  maxSummaryChars: number
  /**
   * Subagent provider used to materialize a teammate. Empty means "this
   * deployment has not told us which provider to use": spawning a worker then
   * fails loudly with an actionable message rather than guessing a name.
   */
  workerProvider: string
  /** Require every task subject to start with "[<big_task_id>] ". */
  strictGroupPrefix: boolean
  /** Workspace-relative directory for handoff notes. */
  handoffDir: string
  /** Hard cap on handoff note bytes; the note is a summary, not a transcript. */
  maxHandoffBytes: number
  /** Read-only board route path for the Web panel (must be plugin-prefixed). */
  boardRoutePath: string
  /** Browser-side panel poll interval. */
  pollIntervalMs: number
  /**
   * Root directory the task pool lives under. Empty means `process.cwd()`.
   *
   * `process.cwd()` is NOT the session workspace: in this deployment it is the
   * profile directory, which is where the pool was first created by mistake.
   * Deployments therefore set this explicitly to the workspace being scheduled.
   */
  tasksRoot: string
  /**
   * Optional debug log file for activation diagnostics. Empty means "write no
   * log at all", which is the default and the shipping behaviour.
   *
   * This replaces a hard-coded absolute path that used to live in `index.ts`.
   * That path embedded one developer's home directory in the source, and was
   * useless to anyone else — it pointed at a directory that does not exist on
   * another machine, so the probe silently degraded into a no-op. Making it a
   * configuration value keeps the diagnostic available to whoever needs it
   * without shipping anyone's local paths.
   */
  debugLogPath: string
}

export const Config: Schema<Config> = Schema.object({
  maxWorkers: Schema.number().default(3),
  maxTasksPerPlan: Schema.number().default(60),
  autoDispatch: Schema.boolean().default(true),
  autoDispatchFallbackMs: Schema.number().default(60_000),
  staleAssignmentSec: Schema.number().default(180),
  maxSummaryChars: Schema.number().default(1500),
  workerProvider: Schema.string().default(''),
  strictGroupPrefix: Schema.boolean().default(true),
  handoffDir: Schema.string().default('.dsh-swarm/reports'),
  maxHandoffBytes: Schema.number().default(16_384),
  boardRoutePath: Schema.string().default('/api/swarm/board'),
  pollIntervalMs: Schema.number().default(2_000),
  tasksRoot: Schema.string().default(''),
  debugLogPath: Schema.string().default(''),
})

/** Team board limits from the kernel: exceeding them fails creation outright. */
export const KERNEL_MAX_TASKS = 256
export const KERNEL_MAX_MEMBERS = 16
/** Subject/description limits enforced by the kernel's `requiredText`. */
export const SUBJECT_MAX = 200
export const DESCRIPTION_MAX = 16_384
/** Group prefix budget: "[T1] " style prefixes must stay far below SUBJECT_MAX. */
export const BIG_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/
