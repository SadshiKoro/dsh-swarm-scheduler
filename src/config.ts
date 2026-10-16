import Schema from '@deepseek-ai/schemastery'

export interface Config {
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

/**
 * Exactly two settings, because exactly two are read.
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
 * than documented. If a setting is added back, it must be read by code in the
 * same change.
 */
export const Config: Schema<Config> = Schema.object({
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
