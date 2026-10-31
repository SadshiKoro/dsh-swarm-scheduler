// src/index.ts
import { appendFileSync as appendFileSync2 } from "fs";

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  tasksRoot: Schema.string().default(""),
  debugLogPath: Schema.string().default(""),
  auto_reap: Schema.boolean().default(true),
  staleAssignmentSec: Schema.number().default(600),
  max_workers: Schema.number().default(3),
  worker_tiers: Schema.dict(Schema.string()).default({}),
  worker_profiles: Schema.dict(Schema.object({
    tier: Schema.string().default("standard"),
    capabilities: Schema.array(Schema.string()).default([]),
    max_context_tokens: Schema.number().default(32e3),
    cost_per_1k_tokens: Schema.number().default(0.01)
  })).default({})
});
function resolveTasksRoot(raw) {
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed;
  const fallback = process.cwd();
  throw new Error(
    `tasksRoot is empty. Refusing to place the task pool under process.cwd() (${fallback}) \u2014 in this deployment that is the profile directory, not the workspace being scheduled, so every task would land where you never look. Set it where this plugin is configured, e.g.
  tasksRoot: 'C:/path/to/the/workspace/being/scheduled'`
  );
}

// src/core/task-store.ts
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, isAbsolute } from "path";

// src/core/state-machine.ts
var TASKS_DIR = ".dsh-tasks";
var defaultClock = () => /* @__PURE__ */ new Date();
function taskFileName(taskId) {
  return `${taskId}.json`;
}
function blankTask(taskId, fields = {}) {
  return {
    task_id: taskId,
    big_task_id: fields.big_task_id ?? "",
    title: fields.title ?? "",
    description: fields.description ?? "",
    status: fields.status ?? "pending",
    claimed_by: fields.claimed_by ?? "",
    claimed_at: fields.claimed_at ?? "",
    started_at: fields.started_at ?? "",
    heartbeat_at: fields.heartbeat_at ?? "",
    completed_at: fields.completed_at ?? "",
    result: fields.result ?? "",
    blocked_by: fields.blocked_by ?? [],
    write_scopes: fields.write_scopes ?? [],
    retry_count: fields.retry_count ?? 0,
    max_retries: fields.max_retries ?? 3,
    failure_reason: fields.failure_reason ?? "",
    created_at: fields.created_at ?? "",
    priority: fields.priority ?? 0,
    required_files: fields.required_files ?? [],
    required_hashes: fields.required_hashes ?? {},
    complexity: fields.complexity ?? "medium",
    required_worker_tier: fields.required_worker_tier ?? "any",
    required_capabilities: fields.required_capabilities ?? [],
    estimated_tokens: fields.estimated_tokens ?? 0,
    max_cost_tokens: fields.max_cost_tokens ?? 0
  };
}
function coerceTask(value, fallbackId) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const taskId = typeof raw.task_id === "string" && raw.task_id.length > 0 ? raw.task_id : fallbackId;
  if (taskId.length === 0) return void 0;
  const validStatuses = ["pending", "claimed", "running", "completed", "failed", "blocked"];
  const status = validStatuses.includes(raw.status) ? raw.status : "pending";
  const strings = (input) => Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
  const num = (input) => typeof input === "number" && Number.isFinite(input) ? input : 0;
  const hashMap = (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
    const out = {};
    for (const [key, value2] of Object.entries(input)) {
      if (typeof value2 === "string") out[key] = value2;
    }
    return out;
  };
  return blankTask(taskId, {
    big_task_id: typeof raw.big_task_id === "string" ? raw.big_task_id : "",
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    status,
    claimed_by: typeof raw.claimed_by === "string" ? raw.claimed_by : "",
    claimed_at: typeof raw.claimed_at === "string" ? raw.claimed_at : "",
    started_at: typeof raw.started_at === "string" ? raw.started_at : "",
    heartbeat_at: typeof raw.heartbeat_at === "string" ? raw.heartbeat_at : "",
    completed_at: typeof raw.completed_at === "string" ? raw.completed_at : "",
    result: typeof raw.result === "string" ? raw.result : "",
    blocked_by: strings(raw.blocked_by),
    write_scopes: strings(raw.write_scopes),
    retry_count: num(raw.retry_count),
    max_retries: num(raw.max_retries) || 3,
    failure_reason: typeof raw.failure_reason === "string" ? raw.failure_reason : "",
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    priority: num(raw.priority),
    required_files: strings(raw.required_files),
    required_hashes: hashMap(raw.required_hashes),
    complexity: raw.complexity === "low" || raw.complexity === "high" ? raw.complexity : "medium",
    required_worker_tier: raw.required_worker_tier === "standard" || raw.required_worker_tier === "premium" ? raw.required_worker_tier : "any",
    required_capabilities: strings(raw.required_capabilities),
    estimated_tokens: Math.max(0, num(raw.estimated_tokens)),
    max_cost_tokens: Math.max(0, num(raw.max_cost_tokens))
  });
}
function viewOf(task, byId, now = Date.now(), staleAfterSec = 0) {
  const open = task.blocked_by.filter((id) => byId.get(id)?.status !== "completed");
  const claimedMs = Date.parse(task.claimed_at);
  const hasClaimTime = (task.status === "claimed" || task.status === "running") && task.claimed_at.length > 0 && !Number.isNaN(claimedMs);
  const ageSec = hasClaimTime ? Math.max(0, Math.floor((now - claimedMs) / 1e3)) : 0;
  const startedMs = Date.parse(task.started_at);
  const hasStartTime = task.status === "running" && task.started_at.length > 0 && !Number.isNaN(startedMs);
  const runningAgeSec = hasStartTime ? Math.max(0, Math.floor((now - startedMs) / 1e3)) : 0;
  const heartbeatMs = Date.parse(task.heartbeat_at);
  const hasHeartbeatTime = task.status === "running" && task.heartbeat_at.length > 0 && !Number.isNaN(heartbeatMs);
  const heartbeatAgeSec = hasHeartbeatTime ? Math.max(0, Math.floor((now - heartbeatMs) / 1e3)) : 0;
  const leaseMs = leaseReferenceMs(task);
  const leaseAgeSec = leaseMs === void 0 ? 0 : Math.max(0, Math.floor((now - leaseMs) / 1e3));
  const stale = leaseMs !== void 0 && staleAfterSec > 0 && leaseAgeSec > staleAfterSec;
  const ready = task.status === "pending" && open.length === 0;
  return {
    ...task,
    ready,
    blocked_by_open: open,
    ...hasClaimTime ? { claimed_age_sec: ageSec } : {},
    ...hasStartTime ? { running_age_sec: runningAgeSec } : {},
    ...hasHeartbeatTime ? { heartbeat_age_sec: heartbeatAgeSec } : {},
    stale
  };
}
function leaseReferenceMs(task) {
  const claimedMs = Date.parse(task.claimed_at);
  const heartbeatMs = Date.parse(task.heartbeat_at);
  const claimedOk = task.claimed_at.length > 0 && !Number.isNaN(claimedMs);
  const heartbeatOk = task.heartbeat_at.length > 0 && !Number.isNaN(heartbeatMs);
  if (task.status === "claimed") {
    const latest = Math.max(claimedOk ? claimedMs : 0, heartbeatOk ? heartbeatMs : 0);
    return latest === 0 ? void 0 : latest;
  }
  if (task.status === "running") {
    if (heartbeatOk) return heartbeatMs;
    return claimedOk ? claimedMs : void 0;
  }
  return void 0;
}
function viewsOf(tasks, now = Date.now(), staleAfterSec = 0) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return tasks.map((task) => viewOf(task, byId, now, staleAfterSec));
}
function compareReadyOrder(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const at = Date.parse(a.created_at);
  const bt = Date.parse(b.created_at);
  const aHas = a.created_at.length > 0 && !Number.isNaN(at);
  const bHas = b.created_at.length > 0 && !Number.isNaN(bt);
  if (aHas && bHas && at !== bt) return at - bt;
  return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
}
function computeReady(tasks, maxWorkers, filter) {
  const active = tasks.filter((task) => task.status === "claimed" || task.status === "running").length;
  if (maxWorkers > 0 && active >= maxWorkers) {
    return { total: 0, tasks: [], limited: true, notice: `max_workers limit (${maxWorkers}) reached` };
  }
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const ready = tasks.map((task) => viewOf(task, byId)).filter((view) => view.ready).filter((view) => filter === void 0 || view.big_task_id === filter).map((view) => tasks.find((task) => task.task_id === view.task_id)).sort(compareReadyOrder);
  return { total: ready.length, tasks: ready, limited: false };
}

// src/core/scope.ts
function normalizeScope(raw) {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}
function scopesOverlap(a, b) {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function findScopeConflict(task, others) {
  if (task.write_scopes.length === 0) return void 0;
  for (const other of others) {
    if (other.task_id === task.task_id) continue;
    if (other.status !== "claimed" && other.status !== "running") continue;
    for (const mine of task.write_scopes) {
      for (const theirs of other.write_scopes) {
        if (scopesOverlap(mine, theirs)) {
          return { task_id: other.task_id, claimed_by: other.claimed_by, scope: mine, other_scope: theirs };
        }
      }
    }
  }
  return void 0;
}

// src/core/task-store.ts
var LOCK_SUFFIX = ".lock";
var KEEP_FILE = ".keep";
var LOG_SUFFIX = ".log";
var STATS_FILE = "worker_stats.json";
var AUTO_REAP_LOG = "auto-reap.log";
var TaskStore = class _TaskStore {
  #cwd;
  #clock;
  #fs;
  /** Set once a write has gone through the fallback, so reports stay honest. */
  #fallbackNote;
  /** Latched backend. `'node'` means the service refused and must not be retried. */
  #backend;
  /**
   * @param fs - the host filesystem service slice, or `undefined` to use
   *   `node:fs` directly. Injected rather than reached for on a Cordis context:
   *   that is what keeps this module free of `@deepseek-ai/*`.
   */
  constructor(fs, cwd, clock = defaultClock) {
    this.#cwd = cwd;
    this.#clock = clock;
    this.#fs = fs;
    this.#backend = this.#fs === void 0 ? "node" : "service";
  }
  /** The degradation note, or `undefined` when the service path is in use. */
  get degraded() {
    return this.#fallbackNote;
  }
  /** Which backend reads and writes are currently using. */
  get backend() {
    return this.#backend;
  }
  /** The filesystem service, or `undefined` when the deployment does not expose one. */
  get serviceFs() {
    return this.#fs;
  }
  /** The directory every task path resolves against. */
  get rootPath() {
    return this.#cwd;
  }
  /** Record a degradation from outside the class (the lock helper needs it). */
  noteDegraded(reason) {
    this.#degradeTo(reason);
  }
  /** True when the error is the sandbox refusing, not an unrelated I/O failure. */
  static isSandboxDenial(error) {
    return _TaskStore.#isSandboxDenial(error);
  }
  /** Latch onto `node:fs` after a sandbox refusal, recording why once. */
  #degradeTo(reason) {
    this.#backend = "node";
    this.#fallbackNote ??= reason;
  }
  /** True when the error is the sandbox refusing, not an unrelated I/O failure. */
  static #isSandboxDenial(error) {
    const code = error.code;
    if (code === "FS_SANDBOX_DENIED") return true;
    const message = error instanceof Error ? error.message : String(error);
    return /file access denied under|FS_SANDBOX_DENIED|sandbox:/.test(message);
  }
  get dirPath() {
    return join(this.#cwd, TASKS_DIR);
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
  async ensureDir() {
    try {
      mkdirSync(this.dirPath, { recursive: true });
    } catch (error) {
      return { ok: false, error: `cannot create ${this.dirPath}: ${messageOf(error)}` };
    }
    if (this.#fs === void 0) {
      this.#fallbackNote = "ctx.fs unavailable; task state written with node:fs";
      return { ok: true, degraded: this.#fallbackNote };
    }
    try {
      const target = await this.#fs.resolve(`${TASKS_DIR}/${KEEP_FILE}`, { cwd: this.#cwd });
      await this.#fs.writeText(target, "# dsh-swarm-scheduler-beta task pool\n");
      return { ok: true };
    } catch (error) {
      return { ok: true, degraded: `pool marker not written via ctx.fs (${messageOf(error)})` };
    }
  }
  /**
   * Read every task file through whichever backend the store is latched onto.
   *
   * The service path is tried first; a sandbox refusal latches onto `node:fs` so
   * that reads and writes cannot end up disagreeing about where the data lives.
   * Unreadable or malformed files are skipped, never fatal.
   */
  async readAll() {
    if (this.#backend === "node" || this.#fs === void 0) return this.#readAllViaNode();
    try {
      return { tasks: await this.#readAllViaFs(), io: { ok: true } };
    } catch (error) {
      if (_TaskStore.#isSandboxDenial(error)) {
        this.#degradeTo("ctx.fs refused reads under the sandbox; using node:fs");
        return this.#readAllViaNode();
      }
      return { tasks: [], io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } };
    }
  }
  /** Service-path read. Throws so the caller can classify the failure. */
  async #readAllViaFs() {
    const fs = this.#fs;
    const tasks = [];
    const dir = await fs.resolve(TASKS_DIR, { cwd: this.#cwd });
    const entries = await fs.listDir(dir);
    for (const entry of entries) {
      const name2 = entry.name;
      if (name2 === void 0 || !name2.endsWith(".json")) continue;
      if (name2 === STATS_FILE) continue;
      const taskId = name2.slice(0, -".json".length);
      const target = await fs.resolve(`${TASKS_DIR}/${name2}`, { cwd: this.#cwd });
      const text2 = await readTextIfAvailable(fs, target);
      if (text2 === void 0) continue;
      const task = parseTask(text2, taskId);
      if (task !== void 0) tasks.push(task);
    }
    return tasks;
  }
  async #readAllViaNode() {
    const tasks = [];
    try {
      if (!existsSync(this.dirPath)) return { tasks, io: { ok: true, degraded: this.#fallbackNote } };
      for (const name2 of readdirSync(this.dirPath)) {
        if (!name2.endsWith(".json")) continue;
        if (name2 === STATS_FILE) continue;
        const taskId = name2.slice(0, -".json".length);
        try {
          const text2 = readFileSync(join(this.dirPath, name2), "utf8");
          const task = parseTask(text2, taskId);
          if (task !== void 0) tasks.push(task);
        } catch {
        }
      }
      const note = this.#fallbackNote ?? "ctx.fs unavailable; task state read with node:fs";
      this.#fallbackNote = note;
      return { tasks, io: { ok: true, degraded: note } };
    } catch (error) {
      return { tasks, io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } };
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
  async readOne(taskId) {
    if (this.#backend === "node" || this.#fs === void 0) return this.#readOneViaNode(taskId);
    try {
      const fs = this.#fs;
      const target = await fs.resolve(`${TASKS_DIR}/${taskFileName(taskId)}`, { cwd: this.#cwd });
      const text2 = await readTextIfAvailable(fs, target);
      if (text2 === void 0) return { task: void 0, io: { ok: true } };
      return { task: parseTask(text2, taskId), io: { ok: true } };
    } catch (error) {
      if (_TaskStore.#isSandboxDenial(error)) {
        this.#degradeTo("ctx.fs refused reads under the sandbox; using node:fs");
        return this.#readOneViaNode(taskId);
      }
      return { task: void 0, io: { ok: false, error: messageOf(error), degraded: this.#fallbackNote } };
    }
  }
  #readOneViaNode(taskId) {
    try {
      const text2 = readFileSync(join(this.dirPath, taskFileName(taskId)), "utf8");
      return { task: parseTask(text2, taskId), io: { ok: true, degraded: this.#fallbackNote } };
    } catch {
      return { task: void 0, io: { ok: true, degraded: this.#fallbackNote } };
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
  async createExclusive(task) {
    const record = task.created_at.length > 0 ? task : { ...task, created_at: this.#clock().toISOString() };
    const body = `${JSON.stringify(record, null, 2)}
`;
    if (this.#backend === "service" && this.#fs !== void 0) {
      const fs = this.#fs;
      try {
        const target = await fs.resolve(`${TASKS_DIR}/${taskFileName(task.task_id)}`, { cwd: this.#cwd });
        await fs.writeText(target, body, { create: true });
        const seen = await readTextIfAvailable(fs, target);
        if (seen !== void 0 && !seen.includes(`"task_id": "${task.task_id}"`)) {
          return { ok: false, error: `task file for ${task.task_id} already exists with different content` };
        }
        return { ok: true };
      } catch (error) {
        if (!_TaskStore.#isSandboxDenial(error)) return { ok: false, error: messageOf(error) };
        this.#degradeTo("ctx.fs refused task writes under the sandbox; using node:fs");
      }
    }
    try {
      mkdirSync(this.dirPath, { recursive: true });
      const fd = openSync(join(this.dirPath, taskFileName(task.task_id)), "wx");
      writeFileSync(fd, body, "utf8");
      closeSync(fd);
      return { ok: true, degraded: this.#fallbackNote ?? "task created with node:fs" };
    } catch (error) {
      return { ok: false, error: messageOf(error), degraded: this.#fallbackNote };
    }
  }
  /** Replace one existing task file (used for claim/complete transitions). */
  async writeExisting(task) {
    const body = `${JSON.stringify(task, null, 2)}
`;
    if (this.#backend === "service" && this.#fs !== void 0) {
      try {
        const target = await this.#fs.resolve(`${TASKS_DIR}/${taskFileName(task.task_id)}`, { cwd: this.#cwd });
        await this.#fs.writeText(target, body);
        return { ok: true };
      } catch (error) {
        if (!_TaskStore.#isSandboxDenial(error)) return { ok: false, error: messageOf(error) };
        this.#degradeTo("ctx.fs refused task writes under the sandbox; using node:fs");
      }
    }
    try {
      mkdirSync(this.dirPath, { recursive: true });
      writeFileSync(join(this.dirPath, taskFileName(task.task_id)), body, "utf8");
      return { ok: true, degraded: this.#fallbackNote ?? "task updated with node:fs" };
    } catch (error) {
      return { ok: false, error: messageOf(error), degraded: this.#fallbackNote };
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
  fileExists(declaredPath) {
    const target = isAbsolute(declaredPath) ? declaredPath : join(this.#cwd, declaredPath);
    try {
      return existsSync(target);
    } catch {
      return false;
    }
  }
  /**
   * sha256 hex digest of one prerequisite file's content, or `undefined` when it
   * cannot be read.
   *
   * Content hash only: no git object id, no version string, no normalisation
   * (line endings included as-is). Callers compare digests, never file mtimes.
   */
  hashOf(declaredPath) {
    const target = isAbsolute(declaredPath) ? declaredPath : join(this.#cwd, declaredPath);
    try {
      return createHash("sha256").update(readFileSync(target)).digest("hex");
    } catch {
      return void 0;
    }
  }
  /**
   * Read the pool-level worker counters.
   *
   * A missing or malformed file is an empty map, never an error: telemetry must
   * not be able to break a status call.
   */
  async readWorkerStats() {
    try {
      const raw = JSON.parse(readFileSync(join(this.dirPath, STATS_FILE), "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      const out = {};
      for (const [id, value] of Object.entries(raw)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value;
        out[id] = {
          success_count: typeof entry.success_count === "number" ? entry.success_count : 0,
          failed_count: typeof entry.failed_count === "number" ? entry.failed_count : 0,
          total_task_time_ms: typeof entry.total_task_time_ms === "number" ? entry.total_task_time_ms : 0,
          total_tokens_consumed: typeof entry.total_tokens_consumed === "number" ? entry.total_tokens_consumed : 0
        };
      }
      return out;
    } catch {
      return {};
    }
  }
  /**
   * Append one line to the automatic-watchdog audit trail (`.dsh-tasks/auto-reap.log`).
   *
   * Best-effort like the other telemetry: a failed audit line must not fail the
   * reap that produced it.
   */
  appendAutoReapLog(line) {
    try {
      mkdirSync(this.dirPath, { recursive: true });
      appendFileSync(join(this.dirPath, AUTO_REAP_LOG), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
    } catch {
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
  async recordWorkerOutcome(workerId, success, metrics) {
    const id = workerId.trim();
    if (id.length === 0) return;
    try {
      const current = await this.readWorkerStats();
      const entry = current[id] ?? { success_count: 0, failed_count: 0, total_task_time_ms: 0, total_tokens_consumed: 0 };
      if (success) {
        entry.success_count += 1;
        entry.total_task_time_ms += Math.max(0, metrics?.duration_ms ?? 0);
        entry.total_tokens_consumed += Math.max(0, metrics?.actual_tokens ?? 0);
      } else {
        entry.failed_count += 1;
      }
      current[id] = entry;
      mkdirSync(this.dirPath, { recursive: true });
      writeFileSync(join(this.dirPath, STATS_FILE), `${JSON.stringify(current, null, 2)}
`, "utf8");
    } catch {
    }
  }
};
function missingRequiredFiles(store, task) {
  const declared = [...task.required_files, ...Object.keys(task.required_hashes)];
  const out = [];
  for (const file of declared) {
    if (out.includes(file)) continue;
    if (!store.fileExists(file)) out.push(file);
  }
  return out;
}
function hashMismatches(store, task) {
  const out = [];
  for (const [file, expected] of Object.entries(task.required_hashes)) {
    if (!store.fileExists(file)) continue;
    const actual = store.hashOf(file) ?? "(unreadable)";
    if (actual.toLowerCase() !== expected.trim().toLowerCase()) {
      out.push({ file, expected: expected.trim(), actual });
    }
  }
  return out;
}
var heldLocks = /* @__PURE__ */ new Set();
var claimInProgress = /* @__PURE__ */ new Map();
function lockPath(dirPath, taskId) {
  return join(dirPath, `${taskId}${LOCK_SUFFIX}`);
}
function removeLock(dirPath, taskId) {
  try {
    unlinkSync(lockPath(dirPath, taskId));
  } catch {
  }
}
function lockExists(dirPath, taskId) {
  try {
    return existsSync(lockPath(dirPath, taskId));
  } catch {
    return false;
  }
}
var DEFAULT_WORKER_PROFILE = {
  tier: "standard",
  capabilities: [],
  max_context_tokens: 32e3,
  cost_per_1k_tokens: 0.01
};
function resolveWorkerProfile(agentId, profiles, tiers) {
  const raw = profiles?.[agentId];
  if (raw !== void 0) {
    return {
      tier: raw.tier === "premium" ? "premium" : "standard",
      capabilities: raw.capabilities?.filter((capability) => typeof capability === "string") ?? [],
      max_context_tokens: typeof raw.max_context_tokens === "number" && raw.max_context_tokens > 0 ? raw.max_context_tokens : DEFAULT_WORKER_PROFILE.max_context_tokens,
      cost_per_1k_tokens: typeof raw.cost_per_1k_tokens === "number" && raw.cost_per_1k_tokens >= 0 ? raw.cost_per_1k_tokens : DEFAULT_WORKER_PROFILE.cost_per_1k_tokens
    };
  }
  if (tiers?.[agentId] === "premium") return { ...DEFAULT_WORKER_PROFILE, tier: "premium" };
  return { ...DEFAULT_WORKER_PROFILE };
}
function routingRefusal(task, agentId, tier) {
  if (task.required_worker_tier === "premium" && tier !== "premium") {
    return `${task.task_id} requires a premium worker; ${agentId} is ${tier}`;
  }
  if (task.complexity === "high" && tier !== "premium" && task.required_worker_tier !== "any") {
    return `${task.task_id} is high complexity and requires a ${task.required_worker_tier} worker; ${agentId} is ${tier}`;
  }
  return void 0;
}
function profileRefusal(task, agentId, profile, stats) {
  if (task.required_capabilities.length > 0) {
    const have = new Set(profile.capabilities);
    const missing = task.required_capabilities.filter((capability) => !have.has(capability));
    if (missing.length > 0) {
      return {
        code: "worker_lacks_capability",
        message: `${task.task_id} requires capabilities [${task.required_capabilities.join(", ")}]; ${agentId} is missing [${missing.join(", ")}] (declared: [${profile.capabilities.join(", ")}])`
      };
    }
  }
  if (task.estimated_tokens > 0 && task.estimated_tokens > profile.max_context_tokens) {
    return {
      code: "worker_context_too_small",
      message: `${task.task_id} estimates ${task.estimated_tokens} tokens, above ${agentId}'s max_context_tokens (${profile.max_context_tokens})`
    };
  }
  if (task.max_cost_tokens > 0) {
    const estimatedCost = profile.cost_per_1k_tokens * (task.estimated_tokens / 1e3);
    if (estimatedCost > task.max_cost_tokens) {
      return {
        code: "worker_too_expensive",
        message: `${task.task_id} would cost ${estimatedCost.toFixed(4)} at ${agentId}'s rate (${profile.cost_per_1k_tokens}/1k tokens for ${task.estimated_tokens} tokens), above max_cost_tokens (${task.max_cost_tokens})`
      };
    }
  }
  if (task.complexity === "high" && stats !== void 0) {
    const attempts = stats.success_count + stats.failed_count;
    const failureRate = attempts > 0 ? stats.failed_count / attempts : 0;
    if (stats.failed_count > 3 && failureRate > 0.5) {
      return {
        code: "worker_unreliable",
        message: `${task.task_id} is high complexity and ${agentId} has a ${(failureRate * 100).toFixed(0)}% failure rate (${stats.failed_count}/${attempts} attempts); low and medium tasks remain claimable`
      };
    }
  }
  return void 0;
}
async function claimTask(store, taskId, claimedBy, clock = defaultClock, workerTiers, workerProfiles) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) {
    return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  }
  if (found.task.status === "completed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is already completed` };
  }
  if (found.task.status === "claimed" || found.task.status === "running") {
    return { ok: false, code: "already_claimed", message: `${taskId} is held by ${found.task.claimed_by || "another agent"}` };
  }
  if (found.task.status === "failed" || found.task.status === "blocked") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; retry it with swarm_start or release it back to pending`
    };
  }
  const profile = resolveWorkerProfile(claimedBy, workerProfiles, workerTiers);
  const refusal = routingRefusal(found.task, claimedBy, profile.tier);
  if (refusal !== void 0) {
    return { ok: false, code: "worker_too_weak", message: refusal };
  }
  const workerStats = found.task.complexity === "high" ? (await store.readWorkerStats())[claimedBy] : void 0;
  const profileMiss = profileRefusal(found.task, claimedBy, profile, workerStats);
  if (profileMiss !== void 0) {
    return { ok: false, code: profileMiss.code, message: profileMiss.message };
  }
  const missingEarly = missingRequiredFiles(store, found.task);
  if (missingEarly.length > 0) {
    return {
      ok: false,
      code: "missing_dependencies",
      message: `${taskId} refused: missing required file(s): ${missingEarly.join(", ")}`
    };
  }
  const mismatchEarly = hashMismatches(store, found.task);
  if (mismatchEarly.length > 0) {
    return {
      ok: false,
      code: "hash_mismatch",
      message: `${taskId} refused: hash mismatch on ` + mismatchEarly.map((m) => `${m.file} (declared ${m.expected}, actual ${m.actual})`).join("; ")
    };
  }
  let staleLockCleared = false;
  const concurrent = claimInProgress.get(taskId) ?? 0;
  claimInProgress.set(taskId, concurrent + 1);
  try {
    if (concurrent === 0 && lockExists(store.dirPath, taskId)) {
      removeLock(store.dirPath, taskId);
      staleLockCleared = true;
    }
    const lock = await acquireLock(store, taskId);
    if (!lock.ok) {
      return { ok: false, code: "already_claimed", message: `${taskId} was claimed concurrently`, degraded: lock.degraded };
    }
    try {
      const current = await store.readOne(taskId);
      if (current.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
      if (current.task.status !== "pending") {
        return { ok: false, code: "already_claimed", message: `${taskId} is ${current.task.status}` };
      }
      const missingNow = missingRequiredFiles(store, current.task);
      if (missingNow.length > 0) {
        return {
          ok: false,
          code: "missing_dependencies",
          message: `${taskId} refused: missing required file(s): ${missingNow.join(", ")}`,
          degraded: lock.degraded
        };
      }
      const mismatchNow = hashMismatches(store, current.task);
      if (mismatchNow.length > 0) {
        return {
          ok: false,
          code: "hash_mismatch",
          message: `${taskId} refused: hash mismatch on ` + mismatchNow.map((m) => `${m.file} (declared ${m.expected}, actual ${m.actual})`).join("; "),
          degraded: lock.degraded
        };
      }
      const allNow = await store.readAll();
      const conflictNow = findScopeConflict(current.task, allNow.tasks);
      if (conflictNow !== void 0) {
        const holder = conflictNow.claimed_by.length > 0 ? conflictNow.claimed_by : "another agent";
        return {
          ok: false,
          code: "scope_conflict",
          message: `${taskId} refused: write scope "${conflictNow.scope}" overlaps "${conflictNow.other_scope}" of ${conflictNow.task_id} (held by ${holder}). Serialise them with swarm_set_deps, or make the scopes narrower. \u5EFA\u8BAE\u5C06 write_scopes \u7F29\u5C0F\u5230\u5177\u4F53\u6587\u4EF6\uFF0C\u6216\u7528 swarm_set_deps \u4E32\u884C\u5316\u3002`,
          degraded: lock.degraded
        };
      }
      if (current.task.write_scopes.length > 0) {
        for (const other of allNow.tasks) {
          if (other.task_id === taskId) continue;
          if (other.write_scopes.length === 0) continue;
          for (const mine of current.task.write_scopes) {
            for (const theirs of other.write_scopes) {
              if (scopesOverlap(mine, theirs)) {
                if (lockExists(store.dirPath, other.task_id)) {
                  return {
                    ok: false,
                    code: "scope_conflict",
                    message: `${taskId} refused: scope_conflict \u2014 write scope "${mine}" overlaps "${theirs}" of ${other.task_id} (claim in progress). Serialise them with swarm_set_deps, or make the scopes narrower. \u5EFA\u8BAE\u5C06 write_scopes \u7F29\u5C0F\u5230\u5177\u4F53\u6587\u4EF6\uFF0C\u6216\u7528 swarm_set_deps \u4E32\u884C\u5316\u3002`,
                    degraded: lock.degraded
                  };
                }
              }
            }
          }
        }
      }
      const next = {
        ...current.task,
        status: "claimed",
        claimed_by: claimedBy,
        claimed_at: clock().toISOString()
      };
      const written = await store.writeExisting(next);
      if (!written.ok) {
        return { ok: false, code: "io_error", message: `claim not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
      }
      await logTransition(store, taskId, "claim", claimedBy);
      return {
        ok: true,
        code: "claimed",
        message: `${taskId} claimed by ${claimedBy}`,
        degraded: written.degraded ?? lock.degraded,
        ...staleLockCleared ? { stale_lock_cleared: true } : {}
      };
    } finally {
      releaseLock(store.dirPath, taskId, lock.mode);
    }
  } finally {
    const remaining = (claimInProgress.get(taskId) ?? 1) - 1;
    if (remaining <= 0) claimInProgress.delete(taskId);
    else claimInProgress.set(taskId, remaining);
  }
}
async function releaseTask(store, taskId, releasedBy, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) {
    return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}`, released_by: "", released_at: "", lock_removed: false };
  }
  if (found.task.status !== "claimed" && found.task.status !== "running" && found.task.status !== "failed") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed, running or failed task can be released`,
      released_by: "",
      released_at: "",
      lock_removed: false
    };
  }
  const stamp = clock().toISOString();
  const previousHolder = found.task.claimed_by;
  const next = {
    ...found.task,
    status: "pending",
    claimed_by: "",
    claimed_at: ""
  };
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return {
      ok: false,
      code: "io_error",
      message: `release not persisted: ${written.error ?? "unknown"}`,
      released_by: "",
      released_at: "",
      lock_removed: false,
      degraded: written.degraded
    };
  }
  const hadLock = lockExists(store.dirPath, taskId);
  removeLock(store.dirPath, taskId);
  await logTransition(store, taskId, "release", releasedBy);
  const holder = previousHolder.length > 0 ? previousHolder : "an unknown holder";
  return {
    ok: true,
    code: "released",
    message: `${taskId} released from ${holder} by ${releasedBy}` + (hadLock ? "; stale lock removed" : ""),
    released_by: releasedBy,
    released_at: stamp,
    lock_removed: hadLock,
    degraded: written.degraded
  };
}
async function appendLog(store, taskId, line) {
  const logPath = join(store.dirPath, `${taskId}${LOG_SUFFIX}`);
  try {
    if (store.backend === "service" && store.serviceFs !== void 0) {
      const target = await store.serviceFs.resolve(`${TASKS_DIR}/${taskId}${LOG_SUFFIX}`, { cwd: store.rootPath });
      await store.serviceFs.writeText(target, line + "\n", { create: true, append: true });
      return;
    }
  } catch {
  }
  try {
    mkdirSync(store.dirPath, { recursive: true });
    const fd = openSync(logPath, "a");
    writeFileSync(fd, line + "\n", "utf8");
    closeSync(fd);
  } catch {
  }
}
async function readLog(store, taskId, maxLines = 5) {
  const logPath = join(store.dirPath, `${taskId}${LOG_SUFFIX}`);
  try {
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
async function logTransition(store, taskId, event, actor) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString();
  await appendLog(store, taskId, `${stamp} ${event} by ${actor}`);
}
async function startTask(store, taskId, startedBy, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  if (found.task.status !== "claimed" && found.task.status !== "failed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is ${found.task.status}; only a claimed or failed task can be started` };
  }
  const stamp = clock().toISOString();
  const next = {
    ...found.task,
    status: "running",
    started_at: stamp,
    heartbeat_at: stamp
  };
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `start not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  await logTransition(store, taskId, "start", startedBy);
  return { ok: true, code: "started", message: `${taskId} started by ${startedBy}`, degraded: written.degraded };
}
async function escalateTask(store, taskId, agentId, reason, force = false) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  if (found.task.status !== "claimed" && found.task.status !== "running") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed or running task can be escalated`
    };
  }
  if (!force && found.task.claimed_by !== agentId) {
    return {
      ok: false,
      code: "not_owner",
      message: `${taskId} is held by ${found.task.claimed_by || "another agent"}, not ${agentId}; only the holder or the Lead (force) can escalate it`
    };
  }
  const next = {
    ...found.task,
    status: "blocked",
    claimed_by: "",
    claimed_at: "",
    failure_reason: reason
  };
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `escalation not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  removeLock(store.dirPath, taskId);
  await logTransition(store, taskId, "escalated", `${agentId}: ${reason}`);
  return {
    ok: true,
    code: "escalated",
    message: `${taskId} escalated by ${agentId}: ${reason}`,
    degraded: written.degraded
  };
}
async function heartbeatTask(store, taskId, agentId, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  if (found.task.status !== "claimed" && found.task.status !== "running") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed or running task can heartbeat`
    };
  }
  if (found.task.claimed_by !== agentId) {
    return {
      ok: false,
      code: "not_owner",
      message: `${taskId} is held by ${found.task.claimed_by || "another agent"}, not ${agentId}`
    };
  }
  const stamp = clock().toISOString();
  const written = await store.writeExisting({ ...found.task, heartbeat_at: stamp });
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `heartbeat not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  await logTransition(store, taskId, "heartbeat", agentId);
  return {
    ok: true,
    code: "heartbeat",
    message: `${taskId} heartbeat from ${agentId}`,
    heartbeat_at: stamp,
    degraded: written.degraded
  };
}
async function completeTask(store, taskId, result, completedBy, clock = defaultClock, success = true, metrics) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  if (found.task.status === "completed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is already completed` };
  }
  if (found.task.status !== "claimed" && found.task.status !== "running") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed or running task can be completed`
    };
  }
  const stamp = clock().toISOString();
  let next;
  let code;
  if (success) {
    next = {
      ...found.task,
      status: "completed",
      completed_at: stamp,
      result
    };
    code = "completed";
  } else {
    const newRetryCount = found.task.retry_count + 1;
    if (newRetryCount >= found.task.max_retries) {
      next = {
        ...found.task,
        status: "blocked",
        completed_at: stamp,
        result,
        retry_count: newRetryCount,
        failure_reason: result || "failed without reason"
      };
      code = "blocked";
    } else {
      next = {
        ...found.task,
        status: "failed",
        completed_at: stamp,
        result,
        retry_count: newRetryCount,
        failure_reason: result || "failed without reason"
      };
      code = "failed";
    }
  }
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `${code} not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  await logTransition(store, taskId, code, completedBy);
  await store.recordWorkerOutcome(completedBy, success, metrics);
  return { ok: true, code, message: `${taskId} ${code}`, degraded: written.degraded };
}
async function reapTask(store, staleAfterSec, clock = defaultClock) {
  const all = await store.readAll();
  const reaped = [];
  let degraded;
  for (const task of all.tasks) {
    if (task.status !== "claimed" && task.status !== "running") continue;
    const claimedMs = Date.parse(task.claimed_at);
    const heartbeatMs = Date.parse(task.heartbeat_at);
    const claimedOk = !Number.isNaN(claimedMs);
    const heartbeatOk = !Number.isNaN(heartbeatMs);
    const referenceMs = task.status === "claimed" ? Math.max(claimedOk ? claimedMs : 0, heartbeatOk ? heartbeatMs : 0) : heartbeatOk ? heartbeatMs : claimedMs;
    if (Number.isNaN(referenceMs) || referenceMs === 0) continue;
    const ageSec = Math.floor((clock().getTime() - referenceMs) / 1e3);
    if (ageSec <= staleAfterSec) continue;
    if (task.status === "claimed") {
      const stamp = clock().toISOString();
      const next = {
        ...task,
        status: "pending",
        claimed_by: "",
        claimed_at: ""
      };
      const written = await store.writeExisting(next);
      if (!written.ok) {
        degraded = written.degraded;
        continue;
      }
      removeLock(store.dirPath, task.task_id);
      await logTransition(store, task.task_id, "reap:released", "reaper");
      reaped.push({ task_id: task.task_id, action: "released", message: `${task.task_id} reverted to pending (stale claim)` });
    } else if (task.status === "running") {
      const newRetryCount = task.retry_count + 1;
      const stamp = clock().toISOString();
      let action;
      let next;
      if (newRetryCount >= task.max_retries) {
        next = {
          ...task,
          status: "blocked",
          completed_at: stamp,
          result: task.result,
          retry_count: newRetryCount,
          failure_reason: "heartbeat timeout"
        };
        action = "blocked";
      } else {
        next = {
          ...task,
          status: "failed",
          completed_at: stamp,
          result: task.result,
          retry_count: newRetryCount,
          failure_reason: "heartbeat timeout"
        };
        action = "failed";
      }
      const written = await store.writeExisting(next);
      if (!written.ok) {
        degraded = written.degraded;
        continue;
      }
      await logTransition(store, task.task_id, `reap:${action}`, "reaper");
      reaped.push({ task_id: task.task_id, action, message: `${task.task_id} marked ${action} (heartbeat timeout, retry ${newRetryCount}/${task.max_retries})` });
    }
  }
  return { ok: true, reaped, degraded };
}
async function setDependencies(store, taskId, blockedBy, updatedBy) {
  const all = await store.readAll();
  const byId = new Map(all.tasks.map((task) => [task.task_id, task]));
  const target = byId.get(taskId);
  if (target === void 0) {
    return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}`, blocked_by: [], updated_by: "" };
  }
  const next = [...new Set(blockedBy)];
  const missing = next.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "invalid_dependency",
      message: `${taskId}: unknown task id(s) ${missing.join(", ")}`,
      blocked_by: target.blocked_by,
      updated_by: ""
    };
  }
  const reachable = /* @__PURE__ */ new Set();
  const queue = [...next];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === taskId) {
      return {
        ok: false,
        code: "cycle_detected",
        message: `${taskId}: adding ${next.join(", ")} would create a dependency cycle`,
        blocked_by: target.blocked_by,
        updated_by: ""
      };
    }
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = byId.get(id);
    if (node === void 0) continue;
    for (const dep of node.blocked_by) queue.push(dep);
  }
  const written = await store.writeExisting({ ...target, blocked_by: next });
  if (!written.ok) {
    return {
      ok: false,
      code: "io_error",
      message: `dependency update not persisted: ${written.error ?? "unknown"}`,
      blocked_by: target.blocked_by,
      updated_by: "",
      degraded: written.degraded
    };
  }
  const before = target.blocked_by.length === 0 ? "(none)" : target.blocked_by.join(", ");
  const after = next.length === 0 ? "(none)" : next.join(", ");
  return {
    ok: true,
    code: "updated",
    message: `${taskId}: blocked_by [${before}] -> [${after}] by ${updatedBy}`,
    blocked_by: next,
    updated_by: updatedBy,
    degraded: written.degraded
  };
}
async function acquireLock(store, taskId) {
  const relative = `${TASKS_DIR}/${taskId}${LOCK_SUFFIX}`;
  if (store.backend === "service") {
    const fs = store.serviceFs;
    if (fs !== void 0) {
      try {
        const target = await fs.resolve(relative, { cwd: store.rootPath });
        await fs.writeText(target, `${(/* @__PURE__ */ new Date()).toISOString()} lock
`, { create: true });
        const seen = await readTextIfAvailable(fs, target);
        if (seen !== void 0) return { ok: true, mode: "file" };
      } catch (error) {
        if (TaskStore.isSandboxDenial(error)) {
          store.noteDegraded("ctx.fs refused the claim lock under the sandbox; using node:fs");
        } else {
          return { ok: false, mode: "file" };
        }
      }
    }
  }
  try {
    mkdirSync(store.dirPath, { recursive: true });
    const fd = openSync(join(store.dirPath, `${taskId}${LOCK_SUFFIX}`), "wx");
    closeSync(fd);
    return { ok: true, mode: "file", degraded: store.degraded };
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST") return { ok: false, mode: "file" };
    if (heldLocks.has(taskId)) return { ok: false, mode: "memory" };
    heldLocks.add(taskId);
    return {
      ok: true,
      mode: "memory",
      degraded: `lock file unavailable (${messageOf(error)}); claimed under an in-process guard only`
    };
  }
}
function releaseLock(dirPath, taskId, mode) {
  if (mode === "memory") {
    heldLocks.delete(taskId);
    return;
  }
  removeLock(dirPath, taskId);
}
function parseTask(text2, fallbackId) {
  try {
    return coerceTask(JSON.parse(text2), fallbackId);
  } catch {
    return void 0;
  }
}
async function readTextIfAvailable(fs, target) {
  const maybe = fs;
  if (typeof maybe.readText !== "function") return void 0;
  try {
    return await maybe.readText(target);
  } catch {
    return void 0;
  }
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/core/auto-reap.ts
async function autoReap(store, staleAfterSec) {
  if (!(staleAfterSec > 0)) {
    return { ok: true, reaped: [], logs: [], ready: 0, degraded: store.degraded };
  }
  const outcome = await reapTask(store, staleAfterSec);
  const logs = [];
  for (const item of outcome.reaped) {
    logs.push(`Auto-reaped task ${item.task_id} due to lease timeout.`);
  }
  const all = await store.readAll();
  const ready = computeReady(all.tasks, 0).total;
  if (logs.length > 0) {
    for (const line of logs) store.appendAutoReapLog(line);
    if (ready > 0) store.appendAutoReapLog(`Pool has new ready tasks (${ready}).`);
  }
  return {
    ok: outcome.ok,
    reaped: outcome.reaped,
    logs,
    ready,
    degraded: outcome.degraded ?? all.io.degraded ?? store.degraded
  };
}

// src/tools-file.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var text = (value) => [{ type: "text", text: value }];
var MAX_PLAN_TASKS = 200;
var MAX_RESULT_CHARS = 4e3;
function formatTokens(tokens) {
  if (tokens < 1e3) return `${tokens}`;
  return `${Math.round(tokens / 1e3)}k`;
}
function formatAge(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
function registerFileTools({ ctx, store, staleAssignmentSec, max_workers, worker_tiers, worker_profiles, disposers }) {
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_plan",
    description: "Create the task pool on disk: one JSON file per task under .dsh-tasks/. Call this first, with the whole decomposition. An existing task_id is never overwritten \u2014 it is reported as a conflict so a repeated call cannot silently reset finished work. blocked_by names other task_ids in the same call or already on disk; a task is ready only once every blocker is completed. Each task may also set `priority` (larger claims first; ties are FIFO by creation time) and `required_files` (workspace-relative paths that must exist before the task may be claimed); `required_hashes` pins each of those files to a sha256 digest, so a changed prerequisite refuses the claim with `hash_mismatch`. Routing fields: `complexity`, `required_worker_tier`, `required_capabilities` (worker must declare every tag), `estimated_tokens` (must fit the worker context window) and `max_cost_tokens` (budget ceiling; a worker whose rate would exceed it is refused with `worker_too_expensive`).",
    parameters: {
      tasks: {
        type: "array",
        required: true,
        description: "Tasks to create. Each becomes <task_id>.json.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string", required: true, description: "Unique id, e.g. big-1/small-1-1" },
            big_task_id: { type: "string", required: true, description: "Owning big task block, e.g. big-1" },
            title: { type: "string", required: true, description: "Short title" },
            description: { type: "string", required: true, description: "Inputs, outputs and acceptance criteria" },
            blocked_by: { type: "array", description: "Task ids that must complete first", items: { type: "string" } },
            write_scopes: { type: "array", description: "Files or directory prefixes this task will modify", items: { type: "string" } },
            priority: { type: "number", description: "Claim priority: larger wins; ties are FIFO by creation time. Default 0." },
            required_files: { type: "array", description: "Workspace-relative files that must exist before the task can be claimed", items: { type: "string" } },
            required_hashes: {
              type: "object",
              description: "Map of workspace-relative file path -> expected sha256 hex digest; a mismatch refuses the claim",
              additionalProperties: true
            },
            complexity: { type: "string", enum: ["low", "medium", "high"], description: "Estimated difficulty, used for worker routing. Default medium." },
            required_worker_tier: { type: "string", enum: ["any", "standard", "premium"], description: "Minimum worker tier allowed to claim. Default any." },
            required_capabilities: { type: "array", description: "Capability tags the worker must declare (all of them). Default empty.", items: { type: "string" } },
            estimated_tokens: { type: "number", description: "Rough input size in tokens; must fit the worker context window. 0 means not estimated." },
            max_cost_tokens: { type: "number", description: "Budget ceiling for this task cost (rate \xD7 tokens/1000). 0 means no ceiling." }
          }
        }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          created: { type: "array", items: { type: "string" } },
          conflicts: { type: "array", items: { type: "string" } },
          errors: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          dir: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const created = value.created ?? [];
        const conflicts = value.conflicts ?? [];
        const errors = value.errors ?? [];
        const warnings = value.warnings ?? [];
        const lines = [`pool: ${created.length} created, ${conflicts.length} conflict(s), ${errors.length} error(s)`];
        if (created.length > 0) lines.push(`  created: ${created.join(", ")}`);
        if (conflicts.length > 0) lines.push(`  already present (not overwritten): ${conflicts.join(", ")}`);
        if (warnings.length > 0) lines.push(...warnings.map((line) => `  \u26A0 ${line}`));
        if (errors.length > 0) lines.push(...errors.map((line) => `  ! ${line}`));
        if (value.degraded !== void 0 && value.degraded !== "") lines.push(`  degraded: ${value.degraded}`);
        return text(lines.join("\n"));
      }
    },
    async execute(args) {
      const created = [];
      const conflicts = [];
      const errors = [];
      const warnings = [];
      const incoming = args.tasks ?? [];
      if (incoming.length > MAX_PLAN_TASKS) {
        return { created, conflicts, errors: [`${incoming.length} tasks exceeds the ${MAX_PLAN_TASKS} limit for one call`], warnings, dir: TASKS_DIR, degraded: "" };
      }
      const ensured = await store.ensureDir();
      if (!ensured.ok) errors.push(`pool directory unavailable: ${ensured.error ?? "unknown"}`);
      const seen = /* @__PURE__ */ new Set();
      for (const spec of incoming) {
        const taskId = spec.task_id.trim();
        if (taskId.length === 0) {
          errors.push("a task arrived with an empty task_id");
          continue;
        }
        if (seen.has(taskId)) {
          conflicts.push(taskId);
          continue;
        }
        seen.add(taskId);
        const requiredHashes = {};
        const rawHashes = spec.required_hashes;
        if (typeof rawHashes === "object" && rawHashes !== null && !Array.isArray(rawHashes)) {
          for (const [file, digest] of Object.entries(rawHashes)) {
            if (typeof digest === "string") requiredHashes[file] = digest;
          }
        }
        for (const scope of spec.write_scopes ?? []) {
          if (scope.trim().endsWith("/")) {
            warnings.push(`\u4EFB\u52A1 ${taskId} \u58F0\u660E\u4E86\u76EE\u5F55\u7EA7 scope ${scope}\uFF0C\u53EF\u80FD\u963B\u585E\u5E76\u884C\uFF0C\u5EFA\u8BAE\u7EC6\u5316\u5230\u6587\u4EF6`);
          }
        }
        const record = blankTask(taskId, {
          big_task_id: spec.big_task_id,
          title: spec.title,
          description: spec.description,
          blocked_by: spec.blocked_by ?? [],
          write_scopes: spec.write_scopes ?? [],
          priority: spec.priority ?? 0,
          required_files: spec.required_files ?? [],
          required_hashes: requiredHashes,
          complexity: spec.complexity ?? "medium",
          required_worker_tier: spec.required_worker_tier ?? "any",
          required_capabilities: spec.required_capabilities ?? [],
          estimated_tokens: Math.max(0, spec.estimated_tokens ?? 0),
          max_cost_tokens: Math.max(0, spec.max_cost_tokens ?? 0)
        });
        const written = await store.createExclusive(record);
        if (written.ok) created.push(taskId);
        else if ((written.error ?? "").includes("already exists")) conflicts.push(taskId);
        else errors.push(`${taskId}: ${written.error ?? "write failed"}`);
      }
      return {
        created,
        conflicts,
        errors,
        warnings,
        dir: TASKS_DIR,
        degraded: ensured.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_ready",
    description: "List the tasks a worker can start right now: status pending with every blocked_by entry completed. Readiness is derived from the files on disk on every call, so it needs no bookkeeping. Use this to decide what to assign next; assign with your own subagent tools, not from here.",
    parameters: {
      big_task_id: { type: "string", description: "Limit to one big task block" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer" },
          dir: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string" },
                big_task_id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                write_scopes: { type: "array", items: { type: "string" } },
                blocked_by: { type: "array", items: { type: "string" } }
              }
            }
          },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? [];
        const degraded = value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : [];
        if (tasks.length === 0) {
          return text([`ready: 0 (pool: ${value.dir ?? TASKS_DIR})`, ...degraded].join("\n"));
        }
        return text([
          `ready: ${value.total ?? tasks.length}`,
          ...tasks.map((task) => `  ${task.task_id} [${task.big_task_id ?? ""}] ${task.title ?? ""}` + ((task.write_scopes ?? []).length > 0 ? `  scope: ${(task.write_scopes ?? []).join(", ")}` : "")),
          ...degraded
        ].join("\n"));
      }
    },
    async execute(args) {
      const all = await store.readAll();
      const result = computeReady(all.tasks, max_workers, args.big_task_id);
      const fsNote = all.io.degraded ?? store.degraded ?? "";
      if (result.limited) {
        return {
          total: 0,
          dir: TASKS_DIR,
          tasks: [],
          degraded: [result.notice, fsNote].filter((note) => note !== void 0 && note !== "").join("; ")
        };
      }
      return {
        total: result.total,
        dir: TASKS_DIR,
        tasks: result.tasks.map((view) => ({
          task_id: view.task_id,
          big_task_id: view.big_task_id,
          title: view.title,
          description: view.description,
          write_scopes: view.write_scopes,
          blocked_by: view.blocked_by
        })),
        degraded: all.io.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_claim",
    description: "Claim one task for one worker, atomically. Two concurrent callers cannot both win: the loser is told the task is taken so it can pick another. Normally the Lead claims on the worker's behalf before assigning it; a worker that polls the pool itself may claim its own task instead. Claiming never overwrites completed work. This is also where `write_scopes` is enforced: if the task's scopes overlap those of a task that is already claimed, the claim is refused with `scope_conflict` naming both the conflicting task and the overlapping scopes. Serialise the two with `swarm_set_deps`, or declare narrower scopes. Overlap is judged at directory granularity, so two tasks that both declare `src/` are refused even when they would edit different files. A lock left behind by a worker that died mid-claim is cleared automatically.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task to claim" },
      claimed_by: { type: "string", required: true, description: "Agent id of the worker taking it" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["claimed", "already_claimed", "not_found", "invalid_state", "scope_conflict", "missing_dependencies", "hash_mismatch", "worker_too_weak", "worker_lacks_capability", "worker_context_too_small", "worker_too_expensive", "worker_unreliable", "io_error"] },
          message: { type: "string" },
          claimed_by: { type: "string" },
          claimed_at: { type: "string" },
          stale_lock_cleared: { type: "boolean" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.stale_lock_cleared === true ? "\n  note: a stale lock left by a dead holder was cleared" : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await claimTask(store, args.task_id, args.claimed_by, void 0, worker_tiers, worker_profiles);
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: void 0 };
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        claimed_by: after.task?.claimed_by ?? "",
        claimed_at: after.task?.claimed_at ?? "",
        stale_lock_cleared: outcome.stale_lock_cleared === true,
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_complete",
    description: "Record that one task finished, with its outcome. Call it yourself when you did the work, or on a worker's behalf when it reported back. The result is the compressed outcome \u2014 paths, decisions, evidence. Use success=false to mark a failure (will retry up to max_retries, then become blocked). On success you may report actual_tokens and duration_ms: they feed the per-worker performance averages shown by swarm_status. A second completion of the same task is refused rather than silently accepted.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task that finished" },
      result: { type: "string", required: true, description: "Compressed outcome: files, decisions, evidence" },
      completed_by: { type: "string", required: true, description: "Agent id that did the work" },
      success: { type: "boolean", description: "Whether the task succeeded (default true). False triggers retry logic." },
      actual_tokens: { type: "number", description: "Optional self-report: tokens consumed by this task" },
      duration_ms: { type: "number", description: "Optional self-report: wall time spent on this task, in milliseconds" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["completed", "failed", "blocked", "not_found", "invalid_state", "io_error", "result_too_long"] },
          message: { type: "string" },
          completed_at: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      if (args.result.length > MAX_RESULT_CHARS) {
        return {
          ok: false,
          code: "result_too_long",
          message: `result is ${args.result.length} chars; keep it under ${MAX_RESULT_CHARS} and put detail in a handoff file`,
          completed_at: "",
          degraded: ""
        };
      }
      const outcome = await completeTask(
        store,
        args.task_id,
        args.result,
        args.completed_by,
        void 0,
        args.success ?? true,
        { actual_tokens: args.actual_tokens, duration_ms: args.duration_ms }
      );
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: void 0 };
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        completed_at: after.task?.completed_at ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_status",
    description: "Report the whole pool in one call: how many tasks exist in each of the six states (pending, claimed, running, completed, failed, blocked), how many are ready to start, how many are still blocked, and a compact line per task. A claim/running older than `staleAssignmentSec` is marked STALE \u2014 a suspicion that its worker died mid-task. Release such a task with swarm_release if you agree it is abandoned; or use swarm_reap to automatically recover stale tasks. Use this to decide whether to plan more, assign more, or stop. Pass include_log=true to see the last 5 log lines per task.",
    parameters: {
      include_log: { type: "boolean", description: "Include last 5 log lines per task" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          total: { type: "integer" },
          pending: { type: "integer" },
          claimed: { type: "integer" },
          running: { type: "integer" },
          completed: { type: "integer" },
          failed: { type: "integer" },
          blocked: { type: "integer" },
          ready: { type: "integer" },
          stale: { type: "integer" },
          stale_after_sec: { type: "integer" },
          big_tasks: { type: "array", items: { type: "string" } },
          tasks: { type: "array", items: { type: "string" } },
          workers: { type: "array", items: { type: "string" } },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? [];
        const workers = value.workers ?? [];
        const stale = value.stale ?? 0;
        const head = `pool ${value.dir ?? TASKS_DIR}: total ${value.total ?? 0} \xB7 pending ${value.pending ?? 0} \xB7 claimed ${value.claimed ?? 0} \xB7 running ${value.running ?? 0}${stale > 0 ? ` (${stale} stale)` : ""} \xB7 completed ${value.completed ?? 0} \xB7 failed ${value.failed ?? 0} \xB7 blocked ${value.blocked ?? 0} \xB7 ready ${value.ready ?? 0}`;
        const hint = stale > 0 ? [`  \u26A0 ${stale} task(s) older than ${value.stale_after_sec ?? 0}s \u2014 release with swarm_release or reap with swarm_reap if abandoned`] : [];
        const workerLines = workers.length > 0 ? ["  workers:", ...workers.map((line) => `    ${line}`)] : [];
        return text([
          head,
          ...hint,
          ...tasks.map((line) => `  ${line}`),
          ...workerLines,
          ...value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : []
        ].join("\n"));
      }
    },
    async execute(args) {
      const all = await store.readAll();
      const views = viewsOf(all.tasks, Date.now(), staleAssignmentSec);
      const pending = views.filter((view) => view.status === "pending").length;
      const claimed = views.filter((view) => view.status === "claimed").length;
      const running = views.filter((view) => view.status === "running").length;
      const completed = views.filter((view) => view.status === "completed").length;
      const failed = views.filter((view) => view.status === "failed").length;
      const blocked = views.filter((view) => view.status === "blocked").length;
      const ready = views.filter((view) => view.ready).length;
      const stale = views.filter((view) => view.stale).length;
      const bigTasks = [...new Set(views.map((view) => view.big_task_id).filter((id) => id.length > 0))].sort();
      const taskLines = views.map((view) => {
        let line = `${view.task_id} [${view.status}${view.ready ? ", ready" : ""}]`;
        if (view.claimed_by.length > 0) line += ` by ${view.claimed_by}`;
        if (view.stale) {
          if (view.status === "running") line += ` [STALE, running ${formatAge(view.running_age_sec ?? 0)} ago, heartbeat ${formatAge(view.heartbeat_age_sec ?? 0)} ago]`;
          else line += ` [STALE, claimed ${formatAge(view.claimed_age_sec ?? 0)} ago]`;
        }
        if (view.blocked_by_open.length > 0) line += ` waiting on ${view.blocked_by_open.join(",")}`;
        if (view.status === "failed" || view.status === "blocked") {
          line += ` (retry ${view.retry_count}/${view.max_retries}`;
          if (view.failure_reason) line += `, reason: ${view.failure_reason}`;
          line += ")";
        }
        line += ` \u2014 ${view.title}`;
        if (view.complexity !== "medium" || view.required_worker_tier !== "any") {
          line += ` [complexity: ${view.complexity}, req: ${view.required_worker_tier}]`;
        }
        if (view.required_capabilities.length > 0) {
          line += ` [caps: ${view.required_capabilities.join(",")}]`;
        }
        if (view.estimated_tokens > 0) {
          line += ` [est: ${formatTokens(view.estimated_tokens)} tokens]`;
        }
        if (view.status === "pending") {
          const missing = missingRequiredFiles(store, view);
          if (missing.length > 0) line += ` [blocked: missing ${missing.join(", ")}]`;
          const mismatch = hashMismatches(store, view);
          if (mismatch.length > 0) line += ` [blocked: hash mismatch on ${mismatch.map((m) => m.file).join(", ")}]`;
        }
        return line;
      });
      let degraded = all.io.degraded ?? store.degraded ?? "";
      let logOutput = "";
      if (args.include_log) {
        for (const view of views) {
          const log = await readLog(store, view.task_id);
          if (log.length > 0) {
            logOutput += `
  ${view.task_id} log:
    ${log.join("\n    ")}`;
          }
        }
      }
      const stats = await store.readWorkerStats();
      const workerLines = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => {
        let line = `${id}: ${entry.success_count} success, ${entry.failed_count} failed`;
        if (entry.success_count > 0) {
          const avgTokens = Math.round(entry.total_tokens_consumed / entry.success_count);
          const avgSeconds = entry.total_task_time_ms / entry.success_count / 1e3;
          line += ` | avg ${formatTokens(avgTokens)} tokens, ${formatAge(avgSeconds)}/task`;
        }
        return line;
      });
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
        workers: workerLines,
        degraded: (degraded + logOutput).trim()
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_release",
    description: "Return a claimed task to the pool so another worker can pick it up. Use it when the worker holding a task disappeared before finishing (interrupted, closed, crashed): without this, the claim never expires, the task stays claimed forever, and every task blocked by it stays unreachable. Only a claimed task can be released \u2014 completing a task is a different transition, and a completed task is never re-opened by this.",
    parameters: {
      task_id: { type: "string", required: true, description: "Claimed task to return to the pool" },
      released_by: { type: "string", required: true, description: "Who is releasing it, e.g. lead" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["released", "not_found", "invalid_state", "io_error"] },
          message: { type: "string" },
          released_by: { type: "string" },
          released_at: { type: "string" },
          lock_removed: { type: "boolean" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.lock_removed === true ? "\n  note: the stale lock file was removed too" : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await releaseTask(store, args.task_id, args.released_by);
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        released_by: outcome.released_by,
        released_at: outcome.released_at,
        lock_removed: outcome.lock_removed,
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_start",
    description: "Start a claimed task: claimed -> running. Records the start time and initial heartbeat. Only a claimed task can be started. The worker must call this after claiming and before executing.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task to start" },
      started_by: { type: "string", required: true, description: "Agent id starting the task" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["started", "not_found", "invalid_state", "io_error"] },
          message: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await startTask(store, args.task_id, args.started_by);
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_heartbeat",
    description: "Renew the lease on a task you hold: update heartbeat_at to now. Only a claimed or running task can heartbeat, and only the agent recorded in claimed_by may renew it (otherwise not_owner). Long-running workers should call this well inside staleAssignmentSec so swarm_reap does not reclaim live work.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task you hold" },
      agent_id: { type: "string", required: true, description: "Agent id that claimed the task" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["heartbeat", "not_found", "invalid_state", "not_owner", "io_error"] },
          message: { type: "string" },
          heartbeat_at: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.heartbeat_at !== void 0 && value.heartbeat_at !== "" ? `
  heartbeat_at: ${value.heartbeat_at}` : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await heartbeatTask(store, args.task_id, args.agent_id);
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        heartbeat_at: outcome.heartbeat_at ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_reap",
    description: "Watchdog: scan claimed/running tasks and recover those past the staleAssignmentSec threshold. - claimed (not running) past threshold: revert to pending, delete lock. - running past threshold: mark failed (heartbeat timeout), increment retry_count; if retry_count >= max_retries, mark blocked. Returns list of reaped tasks and their outcomes. Call periodically from the Lead.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          reaped: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string" },
                action: { type: "string", enum: ["released", "failed", "blocked"] },
                message: { type: "string" }
              }
            }
          },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const reaped = value.reaped ?? [];
        if (reaped.length === 0) return text("reap: nothing to reap");
        return text("reap: " + reaped.length + " task(s)\n" + reaped.map((r) => `  ${r.task_id}: ${r.action} \u2014 ${r.message}`).join("\n") + (value.degraded ? `
  degraded: ${value.degraded}` : ""));
      }
    },
    async execute() {
      const outcome = await reapTask(store, staleAssignmentSec);
      return {
        ok: outcome.ok,
        reaped: outcome.reaped,
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_escalate",
    description: "Hand a claimed/running task back to the Lead as blocked, with a reason, instead of waiting for a timeout or writing code you know is wrong. Use it when you hit something you cannot resolve (missing prerequisite, unresolvable conflict, requirement that needs re-planning). Only the holder may escalate; the Lead may pass force=true to pull a task away from a worker. The task becomes blocked, claimed_by is cleared, and failure_reason carries your reason so swarm_status shows it.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task to escalate" },
      agent_id: { type: "string", required: true, description: "Who is escalating, e.g. the claiming worker or lead" },
      reason: { type: "string", required: true, description: "Why this task needs the Lead (missing file, conflict, wrong decomposition\u2026)" },
      force: { type: "boolean", description: "Lead-only override: escalate a task held by another agent (default false)" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["escalated", "not_found", "invalid_state", "not_owner", "io_error"] },
          message: { type: "string" },
          failure_reason: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await escalateTask(store, args.task_id, args.agent_id, args.reason, args.force ?? false);
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: void 0 };
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        failure_reason: after.task?.failure_reason ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_set_deps",
    description: "LEAD ONLY \u2014 replace one task's blocked_by list. Do not call this as a worker: if you hit a dependency conflict while executing (two tasks touching one file, or a serialisation chain that was never declared at plan time), report it to the Lead with send_message and let the Lead decide. Dependency editing is centralised on purpose \u2014 concurrent edits by workers would race each other and could interleave into a cycle. The Lead uses this to serialise conflicting tasks after the fact, which planning could not know about. Rejects unknown task ids (invalid_dependency) and any change that would close a dependency cycle (cycle_detected), including a self-reference.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task whose dependency list is being replaced" },
      blocked_by: {
        type: "array",
        required: true,
        description: "The complete new dependency list; an empty array clears all dependencies",
        items: { type: "string" }
      },
      updated_by: { type: "string", required: true, description: "Who is making the change, e.g. lead" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["updated", "not_found", "invalid_dependency", "cycle_detected", "io_error"] },
          message: { type: "string" },
          blocked_by: { type: "array", items: { type: "string" } },
          updated_by: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + ((value.blocked_by ?? []).length > 0 ? `
  blocked_by now: ${(value.blocked_by ?? []).join(", ")}` : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await setDependencies(store, args.task_id, args.blocked_by ?? [], args.updated_by);
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        blocked_by: outcome.blocked_by,
        updated_by: outcome.updated_by,
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
}

// src/index.ts
var name = "dsh-swarm-scheduler-beta";
var MODULE_PROBE = process.env.DSH_SWARM_SCHEDULER_MODULE_PROBE;
if (MODULE_PROBE && MODULE_PROBE.trim().length > 0) {
  try {
    appendFileSync2(MODULE_PROBE, `${(/* @__PURE__ */ new Date()).toISOString()} MODULE EVALUATED pid=${process.pid}
`, "utf8");
  } catch {
  }
}
function debugLog(configured, line) {
  const target = configured.trim();
  if (target.length === 0) return;
  try {
    appendFileSync2(target, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
  } catch {
  }
}
var inject = ["tools", "fs", "systemPrompt"];
var AUTO_REAP_DEBOUNCE_MS = 2e3;
var PROTOCOL_SECTION = "swarm-scheduler-dispatch-protocol";
var PROTOCOL_ORDER = 590;
var PROTOCOL_TEXT = `\u5F53\u7528\u6237\u63D0\u51FA\u4E00\u4E2A\u8F83\u5927\u7684\u7F16\u7801\u9700\u6C42\uFF08\u6D89\u53CA\u591A\u4E2A\u6587\u4EF6\u3001\u591A\u4E2A\u6A21\u5757\u3001\u6216\u9700\u8981\u591A\u6B65\u5B8C\u6210\uFF09\u65F6\uFF0C\u4E0D\u8981\u81EA\u5DF1\u4E00\u4EF6\u4E00\u4EF6\u505A\u3002\u6539\u7528\u591A\u4F1A\u8BDD\u5E76\u884C\u8C03\u5EA6\uFF1A

1. \u5148\u7528 swarm_plan \u628A\u9700\u6C42\u62C6\u6210\u4E24\u5C42\u4EFB\u52A1\u5199\u8FDB\u4EFB\u52A1\u6C60\u3002
   - \u5927\u4EFB\u52A1\u5757\u4E4B\u95F4\u5C3D\u91CF\u72EC\u7ACB\uFF0C\u5141\u8BB8\u5C11\u91CF\u524D\u540E\u4F9D\u8D56\u3002
   - \u6BCF\u4E2A\u5927\u4EFB\u52A1\u5757\u62C6\u6210\u82E5\u5E72\u5B8C\u6574\u7684\u5C0F\u4EFB\u52A1\u5757\u3002
   - \u6BCF\u4E2A\u5C0F\u4EFB\u52A1\u5757\u8981\u6709\u660E\u786E\u7684\u8F93\u5165\u3001\u8F93\u51FA\u3001\u9A8C\u6536\u6807\u51C6\uFF0C\u4E00\u4E2A\u5B50\u4F1A\u8BDD\u62FF\u5230\u5C31\u80FD\u72EC\u7ACB\u505A\u5B8C\u3002
   - \u5C0F\u4EFB\u52A1\u5757\u4E4B\u95F4\u4E92\u4E0D\u5E72\u6270\uFF0C\u4E0D\u4F1A\u56E0\u4E3A\u5199\u540C\u4E00\u4E2A\u6587\u4EF6\u3001\u6539\u540C\u4E00\u4E2A\u914D\u7F6E\u800C\u51B2\u7A81\u3002
   - \u9700\u8981\u4F9D\u8D56\u5176\u4ED6\u5C0F\u4EFB\u52A1\u5757\u7684\uFF0C\u7528 blocked_by \u6807\u660E\u3002
   - \u62C6\u89E3\u7684\u6700\u5C0F\u7C92\u5EA6\uFF1A\u4E00\u4E2A\u51FD\u6570\u3001\u4E00\u4E2A\u6587\u4EF6\u3001\u4E00\u4E2A\u72EC\u7ACB\u914D\u7F6E\u9879\u3001\u4E00\u4E2A\u53EF\u72EC\u7ACB\u9A8C\u8BC1\u7684\u884C\u4E3A\u3002
   - **\u8BC4\u4F30\u590D\u6742\u5EA6**\uFF1A\u7ED9\u6BCF\u4E2A\u5C0F\u5757\u6807 complexity\uFF08low / medium / high\uFF09\uFF1B\u6807 high \u7684\u5757\u8981\u8BF4\u660E\u7406\u7531\uFF08\u8DE8\u6A21\u5757\u3001\u9700\u8981\u8BBE\u8BA1\u5224\u65AD\u3001\u6613\u9519\uFF09\u3002
   - **\u51B3\u5B9A Worker \u7B49\u7EA7**\uFF1A\u9AD8\u590D\u6742\u6216\u9AD8\u98CE\u9669\u7684\u5757\u8BBE required_worker_tier: 'premium'\uFF0C\u5176\u4F59\u53EF\u7559 'any'\u3002\u8FD9\u662F\u62BD\u8C61\u7B49\u7EA7\uFF0C\u4E0D\u8981\u5199\u5177\u4F53\u6A21\u578B\u540D\u3002
   - **\u8BC4\u4F30\u80FD\u529B\u9700\u6C42**\uFF1A\u5982\u679C\u5757\u9700\u8981\u7279\u5B9A\u6280\u80FD\uFF08test / docs / sql / \u524D\u7AEF\u7B49\uFF09\uFF0C\u5728 required_capabilities \u91CC\u5217\u51FA\uFF1BWorker \u5FC5\u987B\u58F0\u660E\u62E5\u6709**\u5168\u90E8**\u8FD9\u4E9B\u6807\u7B7E\u624D\u80FD\u9886\u53D6\uFF0C\u7F3A\u4E00\u4E2A\u5373\u88AB\u62D2\uFF08worker_lacks_capability\uFF09\u3002
   - **\u4F30\u7B97\u4E0A\u4E0B\u6587**\uFF1A\u590D\u6742\u6216\u5927\u8F93\u5165\u5757\u7ED9\u51FA\u7C97\u7565 estimated_tokens\uFF1B\u8D85\u8FC7 Worker \u7684 max_context_tokens \u4F1A\u88AB\u62D2\uFF08worker_context_too_small\uFF09\u30020 \u8868\u793A\u4E0D\u8BC4\u4F30\u3002
   - **\u6210\u672C\u654F\u611F\u4EFB\u52A1**\uFF1A\u82E5\u8BE5\u5757\u6709\u9884\u7B97\u4E0A\u9650\uFF0C\u8BF7\u58F0\u660E max_cost_tokens\uFF08\u9884\u4F30 tokens \xD7 \u5355\u4EF7\u4E0A\u9650\uFF09\uFF1BWorker \u7684\u9884\u4F30\u6210\u672C\u8D85\u8FC7\u5B83\u4F1A\u88AB\u62D2\uFF08worker_too_expensive\uFF09\u3002\u672A\u58F0\u660E\u65F6\u6210\u672C\u53EA\u662F\u8F6F\u53C2\u8003\u3002
   - **\u80FD\u529B\u58F0\u660E\u8981\u51C6\u786E**\uFF1Acapabilities \u662F\u4F60\u6309\u6A21\u578B\u80FD\u529B\u914D\u7F6E\u7684\u9759\u6001\u58F0\u660E\uFF0CDSH \u4E0D\u63D0\u4F9B\u8DE8\u4F1A\u8BDD\u9A8C\u8BC1\uFF1B\u8BF7\u5982\u5B9E\u914D\u7F6E\uFF0C\u907F\u514D\u628A\u91CD\u6D3B\u6D3E\u7ED9\u5F31 Worker\u3002

2. \u7528 list_agents \u67E5\u770B\u6709\u6CA1\u6709\u7A7A\u95F2\u7684 teammate\uFF08status \u4E3A inactive \u7684\uFF09\u3002
   \u6709\u7A7A\u95F2\u7684 \u2192 \u76F4\u63A5 send_message \u5524\u9192\u5B83\u4EEC\uFF0C\u4E0D\u8981\u65B0\u5EFA\u3002
   \u6CA1\u6709\u7A7A\u95F2\u7684 \u2192 \u7528 spawn_teammate \u521B\u5EFA 2-3 \u4E2A\u3002
   \u9700\u8981 premium \u7EA7 Worker \u65F6\uFF0C\u521B\u5EFA/\u590D\u7528\u4E00\u4E2A\u80FD\u529B\u66F4\u5F3A\u7684 teammate\uFF0C\u5E76\u5728\u90E8\u7F72\u7684 worker_tiers \u6216 worker_profiles \u914D\u7F6E\u91CC\u6807\u6210 premium\uFF08provider/model \u7531\u4F60\u6309\u53EF\u7528\u6027\u5206\u914D\uFF0C\u8C03\u5EA6\u5C42\u4E0D\u8BA4\u8BC6\u5177\u4F53\u6A21\u578B\u540D\uFF09\u3002

3. \u7ED9\u6BCF\u4E2A worker \u53D1\u4E00\u6761 send_message\uFF0C\u6D88\u606F\u91CC\u53EA\u8BF4\uFF1A
   "\u53BB swarm_ready \u67E5\u5C31\u7EEA\u4EFB\u52A1\uFF0Cswarm_claim \u81EA\u9886\uFF0Cswarm_start \u5F00\u5DE5\uFF0C\u505A\u5B8C\u7528 swarm_complete \u56DE\u62A5\uFF08\u5931\u8D25\u65F6 success=false\uFF0C\u6210\u529F\u65F6\u53EF\u9644\u5E26 actual_tokens / duration_ms \u4F9B\u6027\u80FD\u7EDF\u8BA1\uFF09\uFF0C\u7136\u540E\u56DE\u5230 swarm_ready \u518D\u62C9\u4E00\u5708\uFF0C\u76F4\u5230 swarm_ready \u8FD4\u56DE 0\u3002\u9884\u8BA1\u8017\u65F6\u8D85\u8FC7 staleAssignmentSec \u4E00\u534A\u7684\u4EFB\u52A1\uFF0Crunning \u671F\u95F4\u6BCF\u9694\u4E00\u6BB5\u65F6\u95F4\u8C03\u4E00\u6B21 swarm_heartbeat \u7EED\u7EA6\u3002\u5982\u679C\u4F60\u53D1\u73B0\u81EA\u5DF1\u641E\u4E0D\u5B9A\uFF08\u7F3A\u5173\u952E\u6587\u4EF6\u3001\u4EE3\u7801\u51B2\u7A81\u65E0\u6CD5\u89E3\u51B3\u3001\u9700\u6C42\u672C\u8EAB\u9700\u8981\u91CD\u65B0\u89C4\u5212\uFF09\uFF0C\u4E0D\u8981\u786C\u5199\u5047\u4EE3\u7801\uFF0C\u8C03\u7528 swarm_escalate \u628A\u4EFB\u52A1\u6302\u8D77\uFF08\u72B6\u6001\u53D8 blocked\uFF0C\u539F\u56E0\u5199\u8FDB failure_reason\uFF09\uFF0C\u8BA9 Lead \u91CD\u65B0\u89C4\u5212\u3002"

4. \u4E0D\u8981\u6307\u5B9A\u5177\u4F53\u4EFB\u52A1\u7ED9 worker\u3002\u8C01\u9886\u5230\u54EA\u4E00\u4E2A\u662F\u539F\u5B50\u7ADE\u4E89\u7684\u7ED3\u679C\u3002

5. \u7528 swarm_status \u67E5\u770B\u6574\u4F53\u8FDB\u5EA6\uFF0C\u5411\u7528\u6237\u6C47\u62A5\u3002

6. \u5982\u679C worker \u5728\u6267\u884C\u4E2D\u649E\u5230\u4F9D\u8D56\u51B2\u7A81\uFF08\u6BD4\u5982\u4E24\u4E2A\u4EFB\u52A1\u8981\u6539\u540C\u4E00\u4E2A\u6587\u4EF6\u3001\u6216\u8005\u4E32\u884C\u94FE\u5728\u89C4\u5212\u671F\u6CA1\u58F0\u660E\uFF09\uFF0C\u5B83\u4F1A\u901A\u8FC7 send_message \u62A5\u544A\u4F60\u3002\u4F60\u6536\u5230\u62A5\u544A\u540E\uFF0C\u7528 swarm_set_deps \u8C03\u6574\u4EFB\u52A1\u7684 blocked_by\uFF0C\u628A\u51B2\u7A81\u7684\u4EFB\u52A1\u4E32\u884C\u5316\u3002\u4F9D\u8D56\u8C03\u6574\u53EA\u7531\u4F60\u505A\uFF0C\u4E0D\u8981\u8BA9 worker \u81EA\u5DF1\u6539\u3002
   \u5982\u679C\u6536\u5230 worker \u7684\u547C\u6551\uFF08swarm_escalate\uFF09\uFF0C\u4EFB\u52A1\u4F1A\u4EE5 blocked \u72B6\u6001\u51FA\u73B0\u5E76\u5728 failure_reason \u91CC\u5199\u660E\u539F\u56E0\uFF1B\u7528 swarm_status \u67E5\u770B\uFF0C\u518D\u51B3\u5B9A\u6539\u9700\u6C42\u3001\u8865\u4F9D\u8D56\u6216\u91CD\u65B0\u62C6\u89E3\u3002\u9700\u8981\u4ECE\u67D0\u4E2A Worker \u624B\u91CC\u5F3A\u884C\u6536\u56DE\u4EFB\u52A1\u65F6\uFF0C\u7528 swarm_escalate(force: true)\u3002
   \u6CE8\u610F\uFF1A\u5931\u8D25\u7387\u8FC7\u9AD8\uFF08\u5931\u8D25\u6B21\u6570 > 3 \u4E14\u5931\u8D25\u7387 > 50%\uFF09\u7684 Worker \u4F1A\u88AB\u62D2\u7EDD\u9886\u53D6 complexity=high \u7684\u4EFB\u52A1\uFF08worker_unreliable\uFF09\uFF0C\u4F46 low/medium \u4ECD\u5BF9\u5B83\u5F00\u653E\u2014\u2014\u8FD9\u662F\u6709\u610F\u7684\u300C\u7EC3\u624B\u4E0E\u7FFB\u8EAB\u300D\u901A\u9053\u3002

7. \u770B\u5230 failed \u7684\u4EFB\u52A1\u65F6\uFF0C\u5224\u65AD\u662F\u5426\u91CD\u8BD5\uFF1A\u53EF\u4EE5\u518D\u53D1\u4E00\u6761 send_message \u8BA9 worker \u91CD\u65B0 swarm_start \u8BE5\u4EFB\u52A1\uFF08failed \u4EFB\u52A1\u53EF\u76F4\u63A5 start\uFF09\uFF0C\u6216\u7528 swarm_release \u628A\u5B83\u653E\u56DE pending \u8BA9\u522B\u4EBA\u91CD\u9886\u3002retry_count \u8FBE\u5230 max_retries \u540E\u4F1A\u53D8\u6210 blocked\uFF0C\u6B64\u65F6\u9700\u8981\u4EBA\u5DE5\u4ECB\u5165\u6216\u8C03\u6574\u62C6\u89E3\u3002

8. \u5B9A\u671F\u7528 swarm_status \u67E5\u770B\u8FDB\u5EA6\u3002\u5982\u679C\u67D0\u4E2A\u4EFB\u52A1\u88AB\u6807\u4E3A STALE\uFF08claimed/running \u8D85\u8FC7\u9608\u503C\uFF0C\u53EF\u80FD worker \u5361\u6B7B\u6216\u6D88\u5931\uFF09\uFF0C\u5148\u786E\u8BA4 worker \u662F\u5426\u8FD8\u80FD\u7EED\u7EA6\uFF1B\u786E\u5B9E\u65E0\u54CD\u5E94\u518D\u7528 swarm_reap \u81EA\u52A8\u56DE\u6536\uFF08claimed \u56DE pending\u3001running \u6807 failed \u8D70\u91CD\u8BD5\uFF09\uFF0C\u6216\u6309\u9700\u7528 swarm_release \u91CA\u653E\u4E2A\u522B\u4EFB\u52A1\u3002\u6B63\u5728\u8DD1\u957F\u4EFB\u52A1\u7684 worker \u5E94\u4E3B\u52A8\u8C03 swarm_heartbeat\uFF0C\u907F\u514D\u88AB\u8BEF\u56DE\u6536\u3002

9. \u5E76\u53D1\u4E0A\u9650\u7531 max_workers \u63A7\u5236\uFF08\u9ED8\u8BA4 3\uFF09\u3002swarm_ready \u5728 claimed+running \u8FBE\u5230\u4E0A\u9650\u65F6\u8FD4\u56DE 0\uFF0C\u8FD9\u662F\u6B63\u5E38\u73B0\u8C61\uFF0C\u7B49\u5DF2\u6709\u4EFB\u52A1\u5B8C\u6210\u540E\u518D\u62C9\u3002

\u4E0D\u8981\u81EA\u5DF1\u9886\u4EFB\u52A1\u3001\u4E0D\u8981\u81EA\u5DF1\u505A\u5177\u4F53\u7F16\u7801\u3002\u4F60\u7684\u89D2\u8272\u662F\u8C03\u5EA6\u8005\u3002`;
function apply(ctx, config) {
  try {
    const cwd = resolveTasksRoot(config.tasksRoot);
    const store = new TaskStore(ctx.get("fs"), cwd);
    const disposers = [];
    const staleAssignmentSec = Number.isFinite(config.staleAssignmentSec) && config.staleAssignmentSec > 0 ? config.staleAssignmentSec : 0;
    registerFileTools({
      ctx,
      store,
      staleAssignmentSec,
      max_workers: config.max_workers,
      worker_tiers: config.worker_tiers ?? {},
      worker_profiles: config.worker_profiles ?? {},
      disposers
    });
    void store.ensureDir().catch(() => void 0);
    if (config.auto_reap !== false) {
      let reapTimer;
      const runAutoReap = () => {
        void autoReap(store, staleAssignmentSec).then((result) => {
          if (result.reaped.length > 0) {
            debugLog(config.debugLogPath, `AUTO REAP ${result.reaped.length} task(s); ready=${result.ready}`);
          }
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          debugLog(config.debugLogPath, `AUTO REAP FAILED ${message}`);
        });
      };
      const scheduleAutoReap = () => {
        if (reapTimer !== void 0) clearTimeout(reapTimer);
        reapTimer = setTimeout(() => {
          reapTimer = void 0;
          runAutoReap();
        }, AUTO_REAP_DEBOUNCE_MS);
      };
      try {
        const off = ctx.on("agent/status", (payload) => {
          if (payload?.status === "idle") scheduleAutoReap();
        });
        disposers.push(() => {
          if (reapTimer !== void 0) clearTimeout(reapTimer);
          off();
        });
        debugLog(config.debugLogPath, `AUTO REAP LISTENER OK debounce=${AUTO_REAP_DEBOUNCE_MS}ms stale=${staleAssignmentSec}s`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog(config.debugLogPath, `AUTO REAP LISTENER FAILED ${message}`);
      }
    }
    try {
      const section = ctx.systemPrompt.section({
        name: PROTOCOL_SECTION,
        order: PROTOCOL_ORDER,
        text: PROTOCOL_TEXT
      });
      disposers.push(section);
      debugLog(config.debugLogPath, `PROMPT SECTION OK name=${PROTOCOL_SECTION} order=${PROTOCOL_ORDER} chars=${PROTOCOL_TEXT.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config.debugLogPath, `PROMPT SECTION FAILED ${message}`);
    }
    ctx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose();
    });
    debugLog(config.debugLogPath, `APPLY OK pool=${TASKS_DIR} root=${cwd} (source=config.tasksRoot)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? "(no stack)" : "(not an Error)";
    debugLog(config.debugLogPath, `APPLY FAILED ${message}
${stack}
---`);
    throw error;
  }
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map