// src/index.ts
import { appendFileSync } from "fs";

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  tasksRoot: Schema.string().default(""),
  debugLogPath: Schema.string().default(""),
  staleAssignmentSec: Schema.number().default(600)
});

// src/task-store.ts
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
var TASKS_DIR = ".dsh-tasks";
var LOCK_SUFFIX = ".lock";
var KEEP_FILE = ".keep";
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
    completed_at: fields.completed_at ?? "",
    result: fields.result ?? "",
    blocked_by: fields.blocked_by ?? [],
    write_scopes: fields.write_scopes ?? []
  };
}
function coerceTask(value, fallbackId) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const taskId = typeof raw.task_id === "string" && raw.task_id.length > 0 ? raw.task_id : fallbackId;
  if (taskId.length === 0) return void 0;
  const status = raw.status === "claimed" || raw.status === "completed" ? raw.status : "pending";
  const strings = (input) => Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
  return blankTask(taskId, {
    big_task_id: typeof raw.big_task_id === "string" ? raw.big_task_id : "",
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    status,
    claimed_by: typeof raw.claimed_by === "string" ? raw.claimed_by : "",
    claimed_at: typeof raw.claimed_at === "string" ? raw.claimed_at : "",
    completed_at: typeof raw.completed_at === "string" ? raw.completed_at : "",
    result: typeof raw.result === "string" ? raw.result : "",
    blocked_by: strings(raw.blocked_by),
    write_scopes: strings(raw.write_scopes)
  });
}
var TaskStore = class _TaskStore {
  #ctx;
  #cwd;
  #clock;
  #fs;
  /** Set once a write has gone through the fallback, so reports stay honest. */
  #fallbackNote;
  /** Latched backend. `'node'` means the service refused and must not be retried. */
  #backend;
  constructor(ctx, cwd, clock = defaultClock) {
    this.#ctx = ctx;
    this.#cwd = cwd;
    this.#clock = clock;
    this.#fs = ctx.get("fs");
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
      await this.#fs.writeText(target, "# dsh-swarm-scheduler task pool\n");
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
      const taskId = name2.slice(0, -".json".length);
      const target = await fs.resolve(`${TASKS_DIR}/${name2}`, { cwd: this.#cwd });
      const text2 = await readTextIfAvailable(fs, target);
      if (text2 === void 0) continue;
      const task = parseTask(text2, taskId);
      if (task !== void 0) tasks.push(task);
    }
    return tasks;
  }
  #readAllViaNode() {
    const tasks = [];
    try {
      if (!existsSync(this.dirPath)) return { tasks, io: { ok: true, degraded: this.#fallbackNote } };
      for (const name2 of readdirSync(this.dirPath)) {
        if (!name2.endsWith(".json")) continue;
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
  async readOne(taskId) {
    const all = await this.readAll();
    return { task: all.tasks.find((candidate) => candidate.task_id === taskId), io: all.io };
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
    const body = `${JSON.stringify(task, null, 2)}
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
};
var heldLocks = /* @__PURE__ */ new Set();
async function claimTask(store, taskId, claimedBy, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) {
    return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  }
  if (found.task.status === "completed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is already completed` };
  }
  if (found.task.status === "claimed") {
    return { ok: false, code: "already_claimed", message: `${taskId} is held by ${found.task.claimed_by || "another agent"}` };
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
    return { ok: true, code: "claimed", message: `${taskId} claimed by ${claimedBy}`, degraded: written.degraded ?? lock.degraded };
  } finally {
    releaseLock(store.dirPath, taskId, lock.mode);
  }
}
async function completeTask(store, taskId, result, completedBy, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  if (found.task.status === "completed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is already completed` };
  }
  const stamp = clock().toISOString();
  const next = {
    ...found.task,
    status: "completed",
    completed_at: stamp,
    result,
    // Record who finished it even when the claim step was skipped.
    claimed_by: found.task.claimed_by.length > 0 ? found.task.claimed_by : completedBy
  };
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `completion not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  return { ok: true, code: "completed", message: `${taskId} completed`, degraded: written.degraded };
}
async function releaseTask(store, taskId, releasedBy, clock = defaultClock) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) {
    return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}`, released_by: "", released_at: "" };
  }
  if (found.task.status !== "claimed") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed task can be released`,
      released_by: "",
      released_at: ""
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
      degraded: written.degraded
    };
  }
  const holder = previousHolder.length > 0 ? previousHolder : "an unknown holder";
  return {
    ok: true,
    code: "released",
    message: `${taskId} released from ${holder} by ${releasedBy}`,
    released_by: releasedBy,
    released_at: stamp,
    degraded: written.degraded
  };
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
function viewOf(task, byId, now = Date.now(), staleAfterSec = 0) {
  const open = task.blocked_by.filter((id) => byId.get(id)?.status !== "completed");
  const claimedMs = Date.parse(task.claimed_at);
  const hasClaimTime = task.status === "claimed" && task.claimed_at.length > 0 && !Number.isNaN(claimedMs);
  const ageSec = hasClaimTime ? Math.max(0, Math.floor((now - claimedMs) / 1e3)) : 0;
  const stale = hasClaimTime && staleAfterSec > 0 && ageSec > staleAfterSec;
  return {
    ...task,
    ready: task.status === "pending" && open.length === 0,
    blocked_by_open: open,
    ...hasClaimTime ? { claimed_age_sec: ageSec } : {},
    stale
  };
}
function viewsOf(tasks, now = Date.now(), staleAfterSec = 0) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return tasks.map((task) => viewOf(task, byId, now, staleAfterSec));
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
  try {
    unlinkSync(join(dirPath, `${taskId}${LOCK_SUFFIX}`));
  } catch {
  }
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

// src/tools-file.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var text = (value) => [{ type: "text", text: value }];
var MAX_PLAN_TASKS = 200;
var MAX_RESULT_CHARS = 4e3;
function formatAge(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
function registerFileTools({ ctx, store, staleAssignmentSec, disposers }) {
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_plan",
    description: "Create the task pool on disk: one JSON file per task under .dsh-tasks/. Call this first, with the whole decomposition. An existing task_id is never overwritten \u2014 it is reported as a conflict so a repeated call cannot silently reset finished work. blocked_by names other task_ids in the same call or already on disk; a task is ready only once every blocker is completed.",
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
            write_scopes: { type: "array", description: "Files or directory prefixes this task will modify", items: { type: "string" } }
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
          dir: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const created = value.created ?? [];
        const conflicts = value.conflicts ?? [];
        const errors = value.errors ?? [];
        const lines = [`pool: ${created.length} created, ${conflicts.length} conflict(s), ${errors.length} error(s)`];
        if (created.length > 0) lines.push(`  created: ${created.join(", ")}`);
        if (conflicts.length > 0) lines.push(`  already present (not overwritten): ${conflicts.join(", ")}`);
        if (errors.length > 0) lines.push(...errors.map((line) => `  ! ${line}`));
        if (value.degraded !== void 0 && value.degraded !== "") lines.push(`  degraded: ${value.degraded}`);
        return text(lines.join("\n"));
      }
    },
    async execute(args) {
      const created = [];
      const conflicts = [];
      const errors = [];
      const incoming = args.tasks ?? [];
      if (incoming.length > MAX_PLAN_TASKS) {
        return { created, conflicts, errors: [`${incoming.length} tasks exceeds the ${MAX_PLAN_TASKS} limit for one call`], dir: TASKS_DIR, degraded: "" };
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
        const record = blankTask(taskId, {
          big_task_id: spec.big_task_id,
          title: spec.title,
          description: spec.description,
          blocked_by: spec.blocked_by ?? [],
          write_scopes: spec.write_scopes ?? []
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
        if (tasks.length === 0) return text(`ready: 0 (pool: ${value.dir ?? TASKS_DIR})`);
        return text(`ready: ${value.total ?? tasks.length}
` + tasks.map((task) => `  ${task.task_id} [${task.big_task_id ?? ""}] ${task.title ?? ""}` + ((task.write_scopes ?? []).length > 0 ? `  scope: ${(task.write_scopes ?? []).join(", ")}` : "")).join("\n"));
      }
    },
    async execute(args) {
      const all = await store.readAll();
      const filter = args.big_task_id;
      const ready = viewsOf(all.tasks).filter((view) => view.ready).filter((view) => filter === void 0 || view.big_task_id === filter);
      return {
        total: ready.length,
        dir: TASKS_DIR,
        tasks: ready.map((view) => ({
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
    description: "Claim one task for one worker, atomically. Two concurrent callers cannot both win: the loser is told the task is taken so it can pick another. Normally the Lead claims on the worker's behalf before assigning it; a worker that polls the pool itself may claim its own task instead. Claiming never overwrites completed work.",
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
          code: { type: "string", enum: ["claimed", "already_claimed", "not_found", "invalid_state", "io_error"] },
          message: { type: "string" },
          claimed_by: { type: "string" },
          claimed_at: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const outcome = await claimTask(store, args.task_id, args.claimed_by);
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: void 0 };
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: outcome.message,
        claimed_by: after.task?.claimed_by ?? "",
        claimed_at: after.task?.claimed_at ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_complete",
    description: "Record that one task finished, with its outcome. Call it yourself when you did the work, or on a worker's behalf when it reported back. The result is the compressed outcome \u2014 paths, decisions, evidence \u2014 and a second completion of the same task is refused rather than silently accepted.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task that finished" },
      result: { type: "string", required: true, description: "Compressed outcome: files, decisions, evidence" },
      completed_by: { type: "string", required: true, description: "Agent id that did the work" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["completed", "not_found", "invalid_state", "io_error", "result_too_long"] },
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
      const outcome = await completeTask(store, args.task_id, args.result, args.completed_by);
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
    description: "Report the whole pool in one call: how many tasks exist, how many are pending, claimed or completed, how many are ready to start, how many are still blocked, and a compact line per task. A claim older than `staleAssignmentSec` is marked STALE \u2014 a suspicion that its worker died mid-task, because a claim never expires on its own. Release such a task with swarm_release if you agree it is abandoned; this report only makes it visible and never reclaims anything by itself. Use it to decide whether to plan more, assign more, or stop.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string" },
          total: { type: "integer" },
          pending: { type: "integer" },
          claimed: { type: "integer" },
          completed: { type: "integer" },
          ready: { type: "integer" },
          blocked: { type: "integer" },
          stale: { type: "integer" },
          stale_after_sec: { type: "integer" },
          big_tasks: { type: "array", items: { type: "string" } },
          tasks: { type: "array", items: { type: "string" } },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? [];
        const stale = value.stale ?? 0;
        const head = `pool ${value.dir ?? TASKS_DIR}: total ${value.total ?? 0} \xB7 pending ${value.pending ?? 0} \xB7 claimed ${value.claimed ?? 0}${stale > 0 ? ` (${stale} stale)` : ""} \xB7 completed ${value.completed ?? 0} \xB7 ready ${value.ready ?? 0} \xB7 blocked ${value.blocked ?? 0}`;
        const hint = stale > 0 ? [`  \u26A0 ${stale} claim(s) older than ${value.stale_after_sec ?? 0}s \u2014 release with swarm_release if abandoned`] : [];
        return text([
          head,
          ...hint,
          ...tasks.map((line) => `  ${line}`),
          ...value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : []
        ].join("\n"));
      }
    },
    async execute() {
      const all = await store.readAll();
      const views = viewsOf(all.tasks, Date.now(), staleAssignmentSec);
      const pending = views.filter((view) => view.status === "pending").length;
      const claimed = views.filter((view) => view.status === "claimed").length;
      const completed = views.filter((view) => view.status === "completed").length;
      const ready = views.filter((view) => view.ready).length;
      const blocked = views.filter((view) => view.status === "pending" && !view.ready).length;
      const stale = views.filter((view) => view.stale).length;
      const bigTasks = [...new Set(views.map((view) => view.big_task_id).filter((id) => id.length > 0))].sort();
      return {
        dir: TASKS_DIR,
        total: views.length,
        pending,
        claimed,
        completed,
        ready,
        blocked,
        stale,
        stale_after_sec: staleAssignmentSec,
        big_tasks: bigTasks,
        tasks: views.map((view) => `${view.task_id} [${view.status}${view.ready ? ", ready" : ""}]` + (view.claimed_by.length > 0 ? ` by ${view.claimed_by}` : "") + (view.stale ? ` [STALE, claimed ${formatAge(view.claimed_age_sec ?? 0)} ago]` : "") + (view.blocked_by_open.length > 0 ? ` waiting on ${view.blocked_by_open.join(",")}` : "") + ` \u2014 ${view.title}`),
        degraded: all.io.degraded ?? store.degraded ?? ""
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
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
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
var name = "dsh-swarm-scheduler";
var MODULE_PROBE = process.env.DSH_SWARM_SCHEDULER_MODULE_PROBE;
if (MODULE_PROBE && MODULE_PROBE.trim().length > 0) {
  try {
    appendFileSync(MODULE_PROBE, `${(/* @__PURE__ */ new Date()).toISOString()} MODULE EVALUATED pid=${process.pid}
`, "utf8");
  } catch {
  }
}
function debugLog(configured, line) {
  const target = configured.trim();
  if (target.length === 0) return;
  try {
    appendFileSync(target, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
  } catch {
  }
}
var inject = ["tools", "fs", "systemPrompt"];
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

2. \u7528 list_agents \u67E5\u770B\u6709\u6CA1\u6709\u7A7A\u95F2\u7684 teammate\uFF08status \u4E3A inactive \u7684\uFF09\u3002
   \u6709\u7A7A\u95F2\u7684 \u2192 \u76F4\u63A5 send_message \u5524\u9192\u5B83\u4EEC\uFF0C\u4E0D\u8981\u65B0\u5EFA\u3002
   \u6CA1\u6709\u7A7A\u95F2\u7684 \u2192 \u7528 spawn_teammate \u521B\u5EFA 2-3 \u4E2A\u3002

3. \u7ED9\u6BCF\u4E2A worker \u53D1\u4E00\u6761 send_message\uFF0C\u6D88\u606F\u91CC\u53EA\u8BF4\uFF1A
   "\u53BB swarm_ready \u67E5\u5C31\u7EEA\u4EFB\u52A1\uFF0Cswarm_claim \u81EA\u9886\uFF0C\u505A\u5B8C\u7528 swarm_complete \u56DE\u62A5\uFF0C\u7136\u540E\u56DE\u5230 swarm_ready \u518D\u62C9\u4E00\u5708\uFF0C\u76F4\u5230 swarm_ready \u8FD4\u56DE 0\u3002"

4. \u4E0D\u8981\u6307\u5B9A\u5177\u4F53\u4EFB\u52A1\u7ED9 worker\u3002\u8C01\u9886\u5230\u54EA\u4E00\u4E2A\u662F\u539F\u5B50\u7ADE\u4E89\u7684\u7ED3\u679C\u3002

5. \u7528 swarm_status \u67E5\u770B\u6574\u4F53\u8FDB\u5EA6\uFF0C\u5411\u7528\u6237\u6C47\u62A5\u3002

6. \u5982\u679C worker \u5728\u6267\u884C\u4E2D\u649E\u5230\u4F9D\u8D56\u51B2\u7A81\uFF08\u6BD4\u5982\u4E24\u4E2A\u4EFB\u52A1\u8981\u6539\u540C\u4E00\u4E2A\u6587\u4EF6\u3001\u6216\u8005\u4E32\u884C\u94FE\u5728\u89C4\u5212\u671F\u6CA1\u58F0\u660E\uFF09\uFF0C\u5B83\u4F1A\u901A\u8FC7 send_message \u62A5\u544A\u4F60\u3002\u4F60\u6536\u5230\u62A5\u544A\u540E\uFF0C\u7528 swarm_set_deps \u8C03\u6574\u4EFB\u52A1\u7684 blocked_by\uFF0C\u628A\u51B2\u7A81\u7684\u4EFB\u52A1\u4E32\u884C\u5316\u3002\u4F9D\u8D56\u8C03\u6574\u53EA\u7531\u4F60\u505A\uFF0C\u4E0D\u8981\u8BA9 worker \u81EA\u5DF1\u6539\u3002

7. \u5B9A\u671F\u7528 swarm_status \u67E5\u770B\u8FDB\u5EA6\u3002\u5982\u679C\u67D0\u4E2A\u4EFB\u52A1\u88AB\u6807\u4E3A STALE\uFF08claimed \u65F6\u95F4\u8D85\u8FC7\u9608\u503C\uFF0C\u53EF\u80FD worker \u5361\u6B7B\u6216\u6D88\u5931\uFF09\uFF0C\u7528 swarm_release \u91CA\u653E\u5B83\uFF0C\u8BA9\u5176\u4ED6 worker \u80FD\u91CD\u65B0\u9886\u53D6\u3002

\u4E0D\u8981\u81EA\u5DF1\u9886\u4EFB\u52A1\u3001\u4E0D\u8981\u81EA\u5DF1\u505A\u5177\u4F53\u7F16\u7801\u3002\u4F60\u7684\u89D2\u8272\u662F\u8C03\u5EA6\u8005\u3002`;
function apply(ctx, config) {
  try {
    const cwd = config.tasksRoot.trim().length > 0 ? config.tasksRoot.trim() : process.cwd();
    const store = new TaskStore(ctx, cwd);
    const disposers = [];
    const staleAssignmentSec = Number.isFinite(config.staleAssignmentSec) && config.staleAssignmentSec > 0 ? config.staleAssignmentSec : 0;
    registerFileTools({ ctx, store, staleAssignmentSec, disposers });
    void store.ensureDir().catch(() => void 0);
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
    debugLog(config.debugLogPath, `APPLY OK pool=${TASKS_DIR} root=${cwd} (source=${config.tasksRoot.trim().length > 0 ? "config.tasksRoot" : "process.cwd()"})`);
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