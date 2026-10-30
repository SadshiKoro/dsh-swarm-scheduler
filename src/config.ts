import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /**
   * Root directory the task pool lives under. **Required in practice**: an empty
   * value is refused at activation (v0.2.7) instead of falling back to
   * `process.cwd()`.
   *
   * `process.cwd()` is NOT the session workspace: in this deployment it is the
   * profile directory, which is where the pool was first created by mistake.
   * The old fallback kept that mistake available — a deployment that forgot the
   * setting still "worked" and wrote its tasks where nobody looks.
   * `resolveTasksRoot` below turns the omission into a startup error.
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
  /**
   * A `claimed` or `running` task older than this many **seconds** is reported
   * as `STALE` by `swarm_status`. Default 600 (ten minutes).
   *
   * This marks a suspicion, it does not act on one: a claim has no expiry, so a
   * worker that dies mid-task leaves the task `claimed`/`running` forever and
   * everything blocked by it unreachable. `swarm_status` makes that visible;
   * releasing it is still the Lead's decision, via `swarm_release`. The `swarm_reap`
   * tool can automatically reap stale tasks when invoked.
   */
  staleAssignmentSec: number
  /**
   * Maximum number of concurrent workers (claimed + running tasks). When this
   * limit is reached, `swarm_ready` returns 0 ready tasks to prevent
   * overscheduling. Default 3.
   */
  max_workers: number
}

/**
 * Three settings, because three are read.
 *
 * This interface used to declare fourteen fields. Twelve of them were never
 * read anywhere in `src/` — they were vestigial from the pre-route-B design
 * (`maxWorkers` / `maxSummaryChars` / `handoffDir` and friends belonged to
 * modules that were deleted). A configuration surface that accepts values it
 * ignores is the same class of defect as documentation that describes behaviour
 * the code does not have: the user sets something, nothing happens, and there is
 * no error to explain why.
 *
 * Post-release feedback flagged this, so the dead fields were removed rather
 * than documented. `staleAssignmentSec` was one of the twelve and came back in
 * v0.2.5 for a real purpose — it is read by the same change that declares it,
 * which is the rule below.
 *
 * **Rule: if a setting is added back, it must be read by code in the same
 * change.**
 */
export const Config: Schema<Config> = Schema.object({
  tasksRoot: Schema.string().default(''),
  debugLogPath: Schema.string().default(''),
  staleAssignmentSec: Schema.number().default(600),
  max_workers: Schema.number().default(3),
})

/**
 * Resolve `tasksRoot`, refusing an empty value instead of falling back to
 * `process.cwd()`.
 *
 * The fallback was a defect that fails silently: activation succeeded, the pool
 * was created somewhere, and every task appeared "lost" because it went to a
 * directory the user never opens. A wrong rule that reports itself is better
 * than a forgiving rule that hides.
 *
 * The message names the setting, the consequence, the path the fallback would
 * have used, and the line to add — a startup error is the one moment the user
 * is guaranteed to be looking.
 */
export function resolveTasksRoot(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length > 0) return trimmed

  const fallback = process.cwd()
  throw new Error(
    'tasksRoot is empty. Refusing to place the task pool under process.cwd() '
    + `(${fallback}) — in this deployment that is the profile directory, not the workspace `
    + 'being scheduled, so every task would land where you never look. '
    + 'Set it where this plugin is configured, e.g.\n'
    + "  tasksRoot: 'C:/path/to/the/workspace/being/scheduled'",
  )
}

/** Team board limits from the kernel: exceeding them fails creation outright. */
export const KERNEL_MAX_TASKS = 256
export const KERNEL_MAX_MEMBERS = 16
/** Subject/description limits enforced by the kernel's `requiredText`. */
export const SUBJECT_MAX = 200
export const DESCRIPTION_MAX = 16_384
/** Group prefix budget: "[T1] " style prefixes must stay far below SUBJECT_MAX. */
export const BIG_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/
