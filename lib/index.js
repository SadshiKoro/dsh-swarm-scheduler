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
  })).default({}),
  quality_gate_command: Schema.string().default(""),
  forbid_inline_comments: Schema.boolean().default(true)
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
import { appendFileSync, closeSync, existsSync as existsSync2, mkdirSync as mkdirSync2, openSync, readdirSync as readdirSync2, readFileSync as readFileSync2, unlinkSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { join as join2, isAbsolute as isAbsolute3 } from "path";

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
    max_cost_tokens: fields.max_cost_tokens ?? 0,
    max_duration_ms: fields.max_duration_ms ?? 0,
    model: fields.model ?? "",
    needs_upgrade: fields.needs_upgrade ?? false,
    consecutive_failures: fields.consecutive_failures ?? 0,
    anchors: fields.anchors ?? [],
    max_budget_tokens: fields.max_budget_tokens ?? 0,
    tokens_used: fields.tokens_used ?? 0,
    workspace: fields.workspace ?? ""
  };
}
function coerceTask(value, fallbackId) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const taskId = typeof raw.task_id === "string" && raw.task_id.length > 0 ? raw.task_id : fallbackId;
  if (taskId.length === 0) return void 0;
  const validStatuses = ["pending", "claimed", "running", "completed", "failed", "blocked", "pending_review"];
  const status = validStatuses.includes(raw.status) ? raw.status : "pending";
  const strings = (input) => Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
  const num = (input) => typeof input === "number" && Number.isFinite(input) ? input : 0;
  const nonNegative = (input) => Math.max(0, num(input));
  const bool = (input) => input === true;
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
    max_cost_tokens: Math.max(0, num(raw.max_cost_tokens)),
    max_duration_ms: Math.max(0, num(raw.max_duration_ms)),
    model: typeof raw.model === "string" ? raw.model : "",
    needs_upgrade: bool(raw.needs_upgrade),
    consecutive_failures: nonNegative(raw.consecutive_failures),
    anchors: strings(raw.anchors),
    max_budget_tokens: nonNegative(raw.max_budget_tokens),
    tokens_used: nonNegative(raw.tokens_used),
    workspace: typeof raw.workspace === "string" ? raw.workspace : ""
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
  const overdue = hasStartTime && task.max_duration_ms > 0 && now - startedMs > task.max_duration_ms;
  return {
    ...task,
    ready,
    blocked_by_open: open,
    ...hasClaimTime ? { claimed_age_sec: ageSec } : {},
    ...hasStartTime ? { running_age_sec: runningAgeSec } : {},
    ...hasHeartbeatTime ? { heartbeat_age_sec: heartbeatAgeSec } : {},
    stale,
    overdue
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
import { statSync } from "fs";
function normalizeScope(raw) {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}
function isDirectoryScope(raw) {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("/")) return true;
  try {
    return statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}
function scopesOverlap(a, b) {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  if (!isDirectoryScope(a) || !isDirectoryScope(b)) return false;
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

// src/core/workspace.ts
import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
var IDENTITY = [
  "-c",
  "user.name=dsh-swarm-scheduler",
  "-c",
  "user.email=dsh-swarm-scheduler@localhost",
  "-c",
  "commit.gpgsign=false"
];
function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}
function detail(run, fallback) {
  return run.stderr || run.stdout || fallback;
}
function safeBranchPart(input) {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : "task";
}
function mainWorktreePath(workspacePath) {
  const run = git(workspacePath, ["worktree", "list", "--porcelain"]);
  if (!run.ok) return void 0;
  const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith("worktree "));
  return line === void 0 ? void 0 : line.slice("worktree ".length).trim();
}
function createWorkspace(repoRoot, tasksDir, taskId) {
  const base = isAbsolute(tasksDir) ? tasksDir : resolve(repoRoot, tasksDir);
  const path = join(base, "workspaces", taskId);
  if (existsSync(path)) {
    return { ok: false, path, message: `workspace already exists: ${path}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  const run = git(repoRoot, ["worktree", "add", "--detach", path, "HEAD"]);
  if (!run.ok) {
    return { ok: false, path, message: detail(run, "git worktree add failed") };
  }
  return { ok: true, path, message: detail(run, "workspace created") };
}
function mergeWorkspace(workspacePath) {
  if (!existsSync(workspacePath)) {
    return { ok: false, conflict: false, message: `workspace not found: ${workspacePath}` };
  }
  const main = mainWorktreePath(workspacePath);
  if (main === void 0) {
    return { ok: false, conflict: false, message: "could not resolve the main worktree" };
  }
  const add2 = git(workspacePath, ["add", "-A"]);
  if (!add2.ok) {
    return { ok: false, conflict: false, message: detail(add2, "git add failed") };
  }
  const status = git(workspacePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return { ok: false, conflict: false, message: detail(status, "git status failed") };
  }
  if (status.stdout.length === 0) {
    return { ok: true, conflict: false, message: "no changes to merge" };
  }
  const branch = `swarm-merge-${safeBranchPart(workspacePath.split(/[\\/]/).pop() ?? "task")}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const checkout = git(workspacePath, ["checkout", "-B", branch, "HEAD"]);
  if (!checkout.ok) {
    return { ok: false, conflict: false, message: detail(checkout, "git checkout failed") };
  }
  const commit = git(workspacePath, [...IDENTITY, "commit", "-m", `swarm: isolated changes (${branch})`]);
  if (!commit.ok) {
    cleanupBranch(workspacePath, main, branch);
    return { ok: false, conflict: false, message: detail(commit, "git commit failed") };
  }
  const merge = git(main, [...IDENTITY, "merge", "--no-ff", branch, "-m", `swarm: merge ${branch}`]);
  if (merge.ok) {
    cleanupBranch(workspacePath, main, branch);
    return { ok: true, conflict: false, message: "merged" };
  }
  const mergeHead = git(main, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.ok) {
    git(main, ["merge", "--abort"]);
    cleanupBranch(workspacePath, main, branch);
    return { ok: false, conflict: true, message: detail(merge, "merge conflict") };
  }
  cleanupBranch(workspacePath, main, branch);
  return { ok: false, conflict: false, message: detail(merge, "git merge failed") };
}
function cleanupBranch(workspacePath, main, branch) {
  git(workspacePath, ["checkout", "--detach", "HEAD"]);
  git(main, ["branch", "-D", branch]);
}
function removeWorkspace(workspacePath) {
  if (!existsSync(workspacePath)) {
    return { ok: true, message: "workspace already removed" };
  }
  const main = mainWorktreePath(workspacePath);
  if (main === void 0) {
    return { ok: false, message: "could not resolve the main worktree" };
  }
  const run = git(main, ["worktree", "remove", "--force", workspacePath]);
  if (!run.ok) {
    return { ok: false, message: detail(run, "git worktree remove failed") };
  }
  return { ok: true, message: "workspace removed" };
}

// src/core/comment-audit.ts
import { spawnSync as spawnSync2 } from "child_process";
import { readFileSync, readdirSync, statSync as statSync2 } from "fs";
import { isAbsolute as isAbsolute2, relative, resolve as resolve2, sep } from "path";
var INLINE_COMMENT_THRESHOLD = 2;
var AUDITABLE_EXTENSION = /\.(ts|tsx|js|mjs)$/;
var JSDOC_LINE = /^\s*(\/\*\*|\*|\*\/)/;
function isInlineCommentLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (JSDOC_LINE.test(line)) return false;
  if (trimmed.startsWith("//")) return true;
  const marker = trimmed.indexOf(" // ");
  if (marker < 0) return false;
  return !trimmed.slice(0, marker).endsWith(":");
}
function countAddedLines(diff) {
  let count = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (isInlineCommentLine(raw.slice(1))) count += 1;
  }
  return count;
}
function countFullText(text2) {
  let count = 0;
  for (const raw of text2.split(/\r?\n/)) {
    if (isInlineCommentLine(raw)) count += 1;
  }
  return count;
}
function filesInScope(root, scope) {
  const absolute = isAbsolute2(scope) ? resolve2(scope) : resolve2(root, scope);
  let stats;
  try {
    stats = statSync2(absolute);
  } catch {
    return [];
  }
  if (stats.isFile()) return [absolute];
  if (!stats.isDirectory()) return [];
  const out = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = resolve2(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(child);
      } else if (entry.isFile() && AUDITABLE_EXTENSION.test(entry.name)) {
        out.push(child);
      }
    }
  }
  return out;
}
function runGit(root, args) {
  const result = spawnSync2("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return {
    ok: result.status === 0 && result.error === void 0,
    stdout: result.stdout ?? ""
  };
}
function countFile(root, absolute) {
  const rel = relative(root, absolute).split(sep).join("/");
  const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", rel]).ok;
  if (!tracked) {
    try {
      return countFullText(readFileSync(absolute, "utf8"));
    } catch {
      return 0;
    }
  }
  const diff = runGit(root, ["diff", "--unified=0", "HEAD", "--", rel]);
  if (!diff.ok) {
    try {
      return countFullText(readFileSync(absolute, "utf8"));
    } catch {
      return 0;
    }
  }
  return countAddedLines(diff.stdout);
}
function auditInlineComments(input) {
  const threshold = typeof input.threshold === "number" && Number.isFinite(input.threshold) && input.threshold > 0 ? input.threshold : INLINE_COMMENT_THRESHOLD;
  const workspace = input.workspace !== void 0 && input.workspace.length > 0 ? input.workspace : void 0;
  const root = workspace ?? input.repoRoot;
  let count = 0;
  const files = [];
  const seen = /* @__PURE__ */ new Set();
  for (const scope of input.scopes) {
    for (const absolute of filesInScope(root, scope)) {
      const rel = relative(root, absolute).split(sep).join("/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      const added = countFile(root, absolute);
      if (added > 0) {
        count += added;
        files.push(rel);
      }
    }
  }
  return { ok: count < threshold, count, files };
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
    return join2(this.#cwd, TASKS_DIR);
  }
  /**
   * The workspace the pool lives in — the directory that *contains* the pool.
   *
   * This is what a quality gate should run in: `dirPath` is `<workspace>/.dsh-tasks`,
   * a bookkeeping folder with no `package.json` in it, so running `npm test`
   * there would fail for a reason that has nothing to do with the work.
   */
  get workspacePath() {
    return this.#cwd;
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
      mkdirSync2(this.dirPath, { recursive: true });
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
      if (!existsSync2(this.dirPath)) return { tasks, io: { ok: true, degraded: this.#fallbackNote } };
      for (const name2 of readdirSync2(this.dirPath)) {
        if (!name2.endsWith(".json")) continue;
        if (name2 === STATS_FILE) continue;
        const taskId = name2.slice(0, -".json".length);
        try {
          const text2 = readFileSync2(join2(this.dirPath, name2), "utf8");
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
      const text2 = readFileSync2(join2(this.dirPath, taskFileName(taskId)), "utf8");
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
      mkdirSync2(this.dirPath, { recursive: true });
      const fd = openSync(join2(this.dirPath, taskFileName(task.task_id)), "wx");
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
      mkdirSync2(this.dirPath, { recursive: true });
      writeFileSync(join2(this.dirPath, taskFileName(task.task_id)), body, "utf8");
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
    const target = isAbsolute3(declaredPath) ? declaredPath : join2(this.#cwd, declaredPath);
    try {
      return existsSync2(target);
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
    const target = isAbsolute3(declaredPath) ? declaredPath : join2(this.#cwd, declaredPath);
    try {
      return createHash("sha256").update(readFileSync2(target)).digest("hex");
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
      const raw = JSON.parse(readFileSync2(join2(this.dirPath, STATS_FILE), "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      const out = {};
      for (const [id, value] of Object.entries(raw)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value;
        out[id] = {
          success_count: typeof entry.success_count === "number" ? entry.success_count : 0,
          failed_count: typeof entry.failed_count === "number" ? entry.failed_count : 0,
          total_task_time_ms: typeof entry.total_task_time_ms === "number" ? entry.total_task_time_ms : 0,
          total_tokens_consumed: typeof entry.total_tokens_consumed === "number" ? entry.total_tokens_consumed : 0,
          // Absent in files written before the sample counters existed; 0 is the
          // honest reading there (no metric was ever tracked).
          tokens_sample_count: typeof entry.tokens_sample_count === "number" ? entry.tokens_sample_count : 0,
          time_sample_count: typeof entry.time_sample_count === "number" ? entry.time_sample_count : 0
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
      mkdirSync2(this.dirPath, { recursive: true });
      appendFileSync(join2(this.dirPath, AUTO_REAP_LOG), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
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
      const entry = current[id] ?? {
        success_count: 0,
        failed_count: 0,
        total_task_time_ms: 0,
        total_tokens_consumed: 0,
        tokens_sample_count: 0,
        time_sample_count: 0
      };
      if (success) {
        entry.success_count += 1;
        const tokens = metrics?.actual_tokens;
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
          entry.total_tokens_consumed += tokens;
          entry.tokens_sample_count = (entry.tokens_sample_count ?? 0) + 1;
        }
        const duration = metrics?.duration_ms;
        if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
          entry.total_task_time_ms += duration;
          entry.time_sample_count = (entry.time_sample_count ?? 0) + 1;
        }
      } else {
        entry.failed_count += 1;
      }
      current[id] = entry;
      mkdirSync2(this.dirPath, { recursive: true });
      writeFileSync(join2(this.dirPath, STATS_FILE), `${JSON.stringify(current, null, 2)}
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
  return join2(dirPath, `${taskId}${LOCK_SUFFIX}`);
}
function removeLock(dirPath, taskId) {
  try {
    unlinkSync(lockPath(dirPath, taskId));
  } catch {
  }
}
function lockExists(dirPath, taskId) {
  try {
    return existsSync2(lockPath(dirPath, taskId));
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
      cost_per_1k_tokens: typeof raw.cost_per_1k_tokens === "number" && raw.cost_per_1k_tokens >= 0 ? raw.cost_per_1k_tokens : DEFAULT_WORKER_PROFILE.cost_per_1k_tokens,
      isDefault: false
    };
  }
  if (tiers?.[agentId] === "premium") return { ...DEFAULT_WORKER_PROFILE, tier: "premium", isDefault: false };
  return { ...DEFAULT_WORKER_PROFILE, isDefault: true };
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
      if (profile.isDefault === true) {
        return {
          code: "worker_lacks_capability",
          message: `${task.task_id} requires capabilities [${task.required_capabilities.join(", ")}]; Worker ${agentId} \u4E0D\u5728 worker_profiles \u4E2D\uFF0C\u4E14\u65E0\u9ED8\u8BA4 capabilities\uFF0C\u65E0\u6CD5\u9886\u53D6\u80FD\u529B\u4EFB\u52A1\u3002 (required: [${task.required_capabilities.join(", ")}]; add an entry under worker_profiles, or give the worker_profiles default an explicit capabilities list)`
        };
      }
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
function statsEntry(stats, id) {
  if (stats === void 0) return void 0;
  if (id !== void 0) return stats[id];
  return stats;
}
function workerHealth(stats, id) {
  const entry = statsEntry(stats, id);
  const success = entry?.success_count ?? 0;
  const failed = entry?.failed_count ?? 0;
  const attempts = success + failed;
  const rate = attempts > 0 ? success / attempts : 0;
  const samples = entry?.time_sample_count ?? 0;
  const avgMs = entry !== void 0 && samples > 0 ? entry.total_task_time_ms / samples : void 0;
  return { attempts, rate, avgMs };
}
function workerPreferenceRefusal(agentId, stats) {
  const mine = workerHealth(stats, agentId);
  if (mine.attempts < 3 || mine.rate >= 0.5) return void 0;
  let best;
  for (const [id] of Object.entries(stats)) {
    if (id === agentId) continue;
    const health = workerHealth(stats, id);
    if (health.attempts < 2 || health.rate <= 0.7) continue;
    if (best === void 0 || health.rate > best.health.rate) best = { id, health };
  }
  if (best === void 0) return void 0;
  const minePercent = Math.round(mine.rate * 100);
  const bestPercent = Math.round(best.health.rate * 100);
  return `${agentId} has a ${minePercent}% success rate over ${mine.attempts} attempts; ${best.id} is healthier (${bestPercent}% over ${best.health.attempts}). High-complexity work prefers the healthier worker; low and medium tasks remain claimable.`;
}
function standardWorkerWithRecord(excludeId, profiles, tiers, stats) {
  const configured = /* @__PURE__ */ new Set();
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    if (profile.tier !== "premium") configured.add(id);
  }
  for (const [id, tier] of Object.entries(tiers ?? {})) {
    if (tier !== "premium") configured.add(id);
  }
  for (const id of configured) {
    if (id === excludeId) continue;
    const health = workerHealth(stats, id);
    if (health.attempts >= 1 && health.rate >= 0.5) return id;
  }
  return void 0;
}
var IDLE_POOL_WARNING = "[WARNING] Idle workers available. Please send_message to wake them up.";
function idlePoolWarning(readyCount, activeCount, configuredWorkers) {
  if (readyCount > 0 && activeCount === 0 && configuredWorkers > 0) return IDLE_POOL_WARNING;
  return void 0;
}
function gateNeededFor(scopes) {
  if (scopes.length === 0) return true;
  for (const scope of scopes) {
    const normalized = scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
    if (normalized.length === 0) return true;
    if (normalized.endsWith(".md") || normalized.endsWith(".mdx")) continue;
    if (normalized === "test" || normalized === "tests" || normalized === "docs") continue;
    if (normalized.startsWith("test/") || normalized.startsWith("tests/") || normalized.startsWith("docs/")) continue;
    return true;
  }
  return false;
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
  if (found.task.status === "pending_review") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is pending_review; the Lead finalises it with swarm_complete(..., reviewed: true)`
    };
  }
  const profile = resolveWorkerProfile(claimedBy, workerProfiles, workerTiers);
  const refusal = routingRefusal(found.task, claimedBy, profile.tier);
  if (refusal !== void 0) {
    return { ok: false, code: "worker_too_weak", message: refusal };
  }
  const needsStats = found.task.complexity === "high" || found.task.complexity === "low" && profile.tier === "premium";
  const statsMap = needsStats ? await store.readWorkerStats() : {};
  const workerStats = statsMap[claimedBy];
  const profileMiss = profileRefusal(found.task, claimedBy, profile, workerStats);
  if (profileMiss !== void 0) {
    return { ok: false, code: profileMiss.code, message: profileMiss.message };
  }
  if (found.task.complexity === "high") {
    const preference = workerPreferenceRefusal(claimedBy, statsMap);
    if (preference !== void 0) {
      return { ok: false, code: "worker_not_preferred", message: `${taskId} refused: ${preference}` };
    }
  }
  if (found.task.complexity === "low" && profile.tier === "premium") {
    const standardCandidate = standardWorkerWithRecord(claimedBy, workerProfiles, workerTiers, statsMap);
    if (standardCandidate !== void 0) {
      return {
        ok: false,
        code: "worker_not_preferred",
        message: `${taskId} is low complexity; prefer the standard/faster worker ${standardCandidate} over premium ${claimedBy}`
      };
    }
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
      const allNow = await store.readAll();
      if (allNow.tasks.some((task) => task.status === "running" && task.claimed_by === claimedBy)) {
        return {
          ok: false,
          code: "worker_busy",
          message: `${claimedBy} already has a running task; finish or escalate it before claiming another`,
          degraded: lock.degraded
        };
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
      let workspace = "";
      if (current.task.complexity === "high") {
        const created = createWorkspace(store.workspacePath, TASKS_DIR, taskId);
        if (!created.ok) {
          return {
            ok: false,
            code: "isolation_unavailable",
            message: "Cannot claim high-complexity task. tasksRoot is not a git repository, Worktree isolation is unavailable.",
            degraded: lock.degraded
          };
        }
        workspace = created.path;
      }
      const next = {
        ...current.task,
        status: "claimed",
        claimed_by: claimedBy,
        claimed_at: clock().toISOString(),
        workspace
      };
      const written = await store.writeExisting(next);
      if (!written.ok) {
        if (workspace !== "") removeWorkspace(workspace);
        return { ok: false, code: "io_error", message: `claim not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
      }
      await logTransition(store, taskId, "claim", claimedBy);
      return {
        ok: true,
        code: "claimed",
        message: `${taskId} claimed by ${claimedBy}`,
        degraded: written.degraded ?? lock.degraded,
        ...staleLockCleared ? { stale_lock_cleared: true } : {},
        workspace
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
    claimed_at: "",
    workspace: ""
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
  if (found.task.workspace !== "") removeWorkspace(found.task.workspace);
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
  const logPath = join2(store.dirPath, `${taskId}${LOG_SUFFIX}`);
  try {
    if (store.backend === "service" && store.serviceFs !== void 0) {
      const target = await store.serviceFs.resolve(`${TASKS_DIR}/${taskId}${LOG_SUFFIX}`, { cwd: store.rootPath });
      await store.serviceFs.writeText(target, line + "\n", { create: true, append: true });
      return;
    }
  } catch {
  }
  try {
    mkdirSync2(store.dirPath, { recursive: true });
    const fd = openSync(logPath, "a");
    writeFileSync(fd, line + "\n", "utf8");
    closeSync(fd);
  } catch {
  }
}
async function readLog(store, taskId, maxLines = 5) {
  const logPath = join2(store.dirPath, `${taskId}${LOG_SUFFIX}`);
  try {
    if (!existsSync2(logPath)) return [];
    const content = readFileSync2(logPath, "utf8");
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
    failure_reason: reason,
    workspace: ""
  };
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `escalation not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  if (found.task.workspace !== "") removeWorkspace(found.task.workspace);
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
  const written = await store.writeExisting({
    ...found.task,
    heartbeat_at: stamp,
    // Liveness proof retires the watchdog's warning: a task whose worker just
    // checked in is no longer suspected, and leaving the flag would make it
    // permanent — nothing else clears `failure_reason` while the task runs.
    failure_reason: found.task.failure_reason === STALE_WARNING_REASON ? "" : found.task.failure_reason
  });
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
var QUALITY_GATE_OUTPUT_LIMIT = 500;
function truncateGateOutput(output) {
  const text2 = output.trim();
  return text2.length <= QUALITY_GATE_OUTPUT_LIMIT ? text2 : `${text2.slice(0, QUALITY_GATE_OUTPUT_LIMIT)}\u2026`;
}
var qualityGateRunner = (command, cwd) => {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3e5
    });
    return { ok: true, output: String(stdout) };
  } catch (caught) {
    const error = caught;
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const detail2 = `${stdout}
${stderr}`.trim();
    return {
      ok: false,
      output: detail2.length > 0 ? detail2 : typeof error.message === "string" ? error.message : "quality gate command failed"
    };
  }
};
var TOO_MANY_INLINE_COMMENTS = "Too many inline comments. Code must be self-explanatory. Move your design intent to anchors, or escalate if the task is too complex.";
async function completeTask(store, taskId, result, completedBy, clock = defaultClock, success = true, metrics, options) {
  const found = await store.readOne(taskId);
  if (found.task === void 0) return { ok: false, code: "not_found", message: `no task ${taskId} in ${TASKS_DIR}` };
  const stamp = clock().toISOString();
  if (found.task.status === "completed") {
    return { ok: false, code: "invalid_state", message: `${taskId} is already completed` };
  }
  if (found.task.status === "pending_review") {
    if (options?.reviewed !== true) {
      return {
        ok: false,
        code: "invalid_state",
        message: `${taskId} is pending_review; pass reviewed: true to finalise it after the global gate`
      };
    }
    const reviewed = {
      ...found.task,
      status: "completed",
      completed_at: stamp,
      claimed_by: "",
      claimed_at: "",
      result: result.length > 0 ? result : found.task.result
    };
    const written2 = await store.writeExisting(reviewed);
    if (!written2.ok) {
      return { ok: false, code: "io_error", message: `review not persisted: ${written2.error ?? "unknown"}`, degraded: written2.degraded };
    }
    await logTransition(store, taskId, "review:completed", completedBy);
    return { ok: true, code: "completed", message: `${taskId} completed (reviewed)`, degraded: written2.degraded };
  }
  if (found.task.status !== "claimed" && found.task.status !== "running") {
    return {
      ok: false,
      code: "invalid_state",
      message: `${taskId} is ${found.task.status}; only a claimed or running task can be completed`
    };
  }
  let gateFailure;
  let gateRan = false;
  let gateSkipped = false;
  const gate = options?.qualityGate;
  const skipLocalGate = options?.skipLocalGate === true;
  if (success && gate !== void 0 && gate.command.trim().length > 0) {
    if (skipLocalGate || !gateNeededFor(found.task.write_scopes)) {
      gateSkipped = true;
    } else {
      const runner = gate.runner ?? qualityGateRunner;
      const cwd = options?.cwd ?? store.workspacePath;
      gateRan = true;
      const outcome = runner(gate.command, cwd);
      if (!outcome.ok) {
        gateFailure = truncateGateOutput(outcome.output);
      }
    }
  }
  const effectiveSuccess = success && gateFailure === void 0;
  const commentAudit = options?.commentAudit;
  let commentFailure;
  if (effectiveSuccess && commentAudit !== void 0) {
    const audited = auditInlineComments({
      repoRoot: commentAudit.repoRoot,
      workspace: commentAudit.workspace,
      scopes: commentAudit.scopes
    });
    if (!audited.ok) commentFailure = TOO_MANY_INLINE_COMMENTS;
  }
  const reportedTokens = typeof metrics?.actual_tokens === "number" && Number.isFinite(metrics.actual_tokens) && metrics.actual_tokens >= 0 ? metrics.actual_tokens : 0;
  const tokensUsed = found.task.tokens_used + (effectiveSuccess ? reportedTokens : 0);
  const budgetExceeded = effectiveSuccess && commentFailure === void 0 && found.task.max_budget_tokens > 0 && tokensUsed > found.task.max_budget_tokens;
  let workspaceFailure;
  if (found.task.workspace !== "") {
    if (effectiveSuccess && !budgetExceeded && commentFailure === void 0) {
      const merged = mergeWorkspace(found.task.workspace);
      if (!merged.ok) {
        workspaceFailure = merged.conflict ? "Merge conflict" : `Merge failed: ${merged.message}`;
      }
    }
    removeWorkspace(found.task.workspace);
  }
  let next;
  let code;
  let message;
  if (effectiveSuccess && commentFailure !== void 0) {
    next = {
      ...found.task,
      status: "blocked",
      claimed_by: "",
      claimed_at: "",
      completed_at: stamp,
      result,
      tokens_used: tokensUsed,
      failure_reason: commentFailure,
      workspace: ""
    };
    code = "blocked";
    message = `${taskId} blocked \u2014 ${commentFailure}`;
  } else if (effectiveSuccess && budgetExceeded) {
    next = {
      ...found.task,
      status: "blocked",
      claimed_by: "",
      claimed_at: "",
      completed_at: stamp,
      result,
      tokens_used: tokensUsed,
      failure_reason: "Budget exceeded",
      workspace: ""
    };
    code = "blocked";
    message = `${taskId} blocked \u2014 Budget exceeded (${tokensUsed} > ${found.task.max_budget_tokens} tokens)`;
  } else if (effectiveSuccess && workspaceFailure !== void 0) {
    next = {
      ...found.task,
      status: "blocked",
      claimed_by: "",
      claimed_at: "",
      completed_at: stamp,
      result,
      tokens_used: tokensUsed,
      failure_reason: workspaceFailure,
      workspace: ""
    };
    code = "blocked";
    message = `${taskId} blocked \u2014 ${workspaceFailure}`;
  } else if (effectiveSuccess && skipLocalGate) {
    next = {
      ...found.task,
      status: "pending_review",
      claimed_by: "",
      claimed_at: "",
      completed_at: stamp,
      result,
      tokens_used: tokensUsed,
      consecutive_failures: 0,
      workspace: ""
    };
    code = "pending_review";
    message = `${taskId} pending_review (local gate skipped; Lead must run the final gate and finalise it)`;
  } else if (effectiveSuccess) {
    next = {
      ...found.task,
      status: "completed",
      completed_at: stamp,
      result,
      tokens_used: tokensUsed,
      // A success ends the failure streak; the upgrade flag is not cleared by a
      // single good run (it records that the model already needed replacing).
      consecutive_failures: 0,
      workspace: ""
    };
    code = "completed";
    message = `${taskId} ${code}`;
    if (gateRan) {
      message += " (quality gate passed)";
    } else if (gateSkipped) {
      message += " (quality gate skipped: docs/tests only)";
    }
  } else {
    const reason = gateFailure !== void 0 ? `Quality gate failed: ${gateFailure}` : result || "failed without reason";
    const hasModel = found.task.model !== "";
    const streak = hasModel ? found.task.consecutive_failures + 1 : found.task.consecutive_failures;
    const needsUpgrade = hasModel && streak >= 2 ? true : found.task.needs_upgrade;
    const newRetryCount = found.task.retry_count + 1;
    const failureStatus = newRetryCount >= found.task.max_retries ? "blocked" : "failed";
    next = {
      ...found.task,
      status: failureStatus,
      completed_at: stamp,
      result,
      retry_count: newRetryCount,
      failure_reason: reason,
      consecutive_failures: streak,
      needs_upgrade: needsUpgrade,
      workspace: ""
    };
    code = failureStatus;
    message = gateFailure !== void 0 ? `${taskId} ${code} \u2014 quality gate failed (command exited non-zero)` : `${taskId} ${code}`;
  }
  const written = await store.writeExisting(next);
  if (!written.ok) {
    return { ok: false, code: "io_error", message: `${code} not persisted: ${written.error ?? "unknown"}`, degraded: written.degraded };
  }
  if (budgetExceeded || commentFailure !== void 0) removeLock(store.dirPath, taskId);
  const event = commentFailure !== void 0 ? "blocked:comments" : budgetExceeded ? "blocked:budget" : workspaceFailure !== void 0 ? "blocked:merge" : gateFailure !== void 0 ? `${code}:quality-gate` : code;
  await logTransition(store, taskId, event, completedBy);
  await store.recordWorkerOutcome(completedBy, effectiveSuccess, effectiveSuccess ? metrics : void 0);
  return {
    ok: true,
    code,
    message,
    degraded: written.degraded,
    ...gateFailure !== void 0 ? { gate_failed: true } : {}
  };
}
var STALE_WARNING_REASON = "heartbeat stale (grace period)";
async function reapTask(store, staleAfterSec, clock = defaultClock) {
  const all = await store.readAll();
  const reaped = [];
  let degraded;
  const hardReapAfterSec = staleAfterSec + staleAfterSec / 2;
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
        claimed_at: "",
        workspace: ""
      };
      const written = await store.writeExisting(next);
      if (!written.ok) {
        degraded = written.degraded;
        continue;
      }
      if (task.workspace !== "") removeWorkspace(task.workspace);
      removeLock(store.dirPath, task.task_id);
      await logTransition(store, task.task_id, "reap:released", "reaper");
      reaped.push({ task_id: task.task_id, action: "released", message: `${task.task_id} reverted to pending (stale claim)` });
    } else if (task.status === "running" && ageSec <= hardReapAfterSec) {
      if (task.failure_reason === STALE_WARNING_REASON) continue;
      const next = {
        ...task,
        status: "running",
        completed_at: task.completed_at,
        retry_count: task.retry_count,
        failure_reason: STALE_WARNING_REASON
      };
      const written = await store.writeExisting(next);
      if (!written.ok) {
        degraded = written.degraded;
        continue;
      }
      await logTransition(store, task.task_id, "reap:stale", "reaper");
      reaped.push({
        task_id: task.task_id,
        action: "stale",
        message: `${task.task_id} flagged STALE (no heartbeat for ${ageSec}s, grace until ${Math.ceil(hardReapAfterSec)}s); not reaped`
      });
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
          failure_reason: "heartbeat timeout",
          workspace: ""
        };
        action = "blocked";
      } else {
        next = {
          ...task,
          status: "failed",
          completed_at: stamp,
          result: task.result,
          retry_count: newRetryCount,
          failure_reason: "heartbeat timeout",
          workspace: ""
        };
        action = "failed";
      }
      const written = await store.writeExisting(next);
      if (!written.ok) {
        degraded = written.degraded;
        continue;
      }
      if (task.workspace !== "") removeWorkspace(task.workspace);
      await logTransition(store, task.task_id, `reap:${action}`, "reaper");
      reaped.push({ task_id: task.task_id, action, message: `${task.task_id} marked ${action} (heartbeat timeout after grace period, retry ${newRetryCount}/${task.max_retries})` });
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
  const relative2 = `${TASKS_DIR}/${taskId}${LOCK_SUFFIX}`;
  if (store.backend === "service") {
    const fs = store.serviceFs;
    if (fs !== void 0) {
      try {
        const target = await fs.resolve(relative2, { cwd: store.rootPath });
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
    mkdirSync2(store.dirPath, { recursive: true });
    const fd = openSync(join2(store.dirPath, `${taskId}${LOCK_SUFFIX}`), "wx");
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
async function autoReap(store, staleAfterSec, clock) {
  if (!(staleAfterSec > 0)) {
    return { ok: true, reaped: [], logs: [], ready: 0, degraded: store.degraded };
  }
  const outcome = clock === void 0 ? await reapTask(store, staleAfterSec) : await reapTask(store, staleAfterSec, clock);
  const logs = [];
  let reclaimed = 0;
  for (const item of outcome.reaped) {
    if (item.action === "stale") {
      logs.push(`Auto-reap warned: task ${item.task_id} is STALE \u2014 ${item.message}`);
      continue;
    }
    reclaimed += 1;
    logs.push(`Auto-reaped task ${item.task_id} due to lease timeout.`);
  }
  const all = await store.readAll();
  const ready = computeReady(all.tasks, 0).total;
  if (logs.length > 0) {
    for (const line of logs) store.appendAutoReapLog(line);
    if (reclaimed > 0 && ready > 0) store.appendAutoReapLog(`Pool has new ready tasks (${ready}).`);
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

// src/core/inbox.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync3, readFileSync as readFileSync3, renameSync, rmSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join3 } from "path";
var INBOX_DIR = "inbox";
var BUDGET_LIMIT_EXCEEDED_MESSAGE = "[SYSTEM] Budget limit exceeded. Stop working immediately and call swarm_complete with success: false.";
var DISPATCH_MESSAGE_LIMIT = 500;
var DISPATCH_TRUNCATION_NOTICE = "[SYSTEM] Message truncated to save tokens. Instruct the worker to read the task pool for full context.";
function buildDispatchText(message, taskId) {
  const id = taskId?.trim() ?? "";
  const instruction = id.length > 0 ? `\u53BB\u4EFB\u52A1\u6C60\u9886\u53D6\u4EFB\u52A1 ${id}\uFF0C\u81EA\u5DF1\u8BFB description\u3002` : "";
  const body = message.trim();
  const truncated = body.length > DISPATCH_MESSAGE_LIMIT;
  const clipped = truncated ? body.slice(0, DISPATCH_MESSAGE_LIMIT) : body;
  const text2 = [instruction, clipped, truncated ? DISPATCH_TRUNCATION_NOTICE : ""].filter((part) => part.length > 0).join("\n\n");
  return { text: text2, truncated };
}
var ACK_SUFFIX = ".ack";
var WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidWorkerId(workerId) {
  return WORKER_ID_PATTERN.test(workerId) && !workerId.includes("..");
}
function inboxDirOf(store) {
  return join3(store.dirPath, INBOX_DIR);
}
function inboxPathOf(store, workerId) {
  if (!isValidWorkerId(workerId)) return void 0;
  return join3(inboxDirOf(store), `${workerId}.json`);
}
function appendInbox(store, workerId, message, from = "lead") {
  const text2 = message.trim();
  if (text2.length === 0) {
    return { ok: false, path: "", error: "message is empty" };
  }
  const path = inboxPathOf(store, workerId);
  if (path === void 0) {
    return { ok: false, path: "", error: `invalid worker id "${workerId}"` };
  }
  const entry = { ts: (/* @__PURE__ */ new Date()).toISOString(), from: from.trim() || "lead", text: text2 };
  const existing = readEntries(path);
  const entries = [...existing, entry];
  try {
    mkdirSync3(inboxDirOf(store), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync2(temporary, `${JSON.stringify(entries, null, 2)}
`, "utf8");
    renameSync(temporary, path);
    return { ok: true, path, entry };
  } catch (error) {
    return { ok: false, path, entry, error: messageOf2(error) };
  }
}
function readInbox(store, workerId) {
  const path = inboxPathOf(store, workerId);
  if (path === void 0) {
    return { ok: false, entries: [], error: `invalid worker id "${workerId}"` };
  }
  let entries = [];
  if (existsSync3(path)) {
    const acked = `${path}.${process.pid}${ACK_SUFFIX}`;
    try {
      renameSync(path, acked);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return budgetAwareResult(store, workerId, []);
      return { ok: false, entries: [], error: messageOf2(error) };
    }
    entries = readEntries(acked);
    try {
      rmSync(acked, { force: true });
    } catch (error) {
      return { ok: false, entries, error: `inbox drained but not removed: ${messageOf2(error)}` };
    }
  }
  return budgetAwareResult(store, workerId, entries);
}
function overBudgetHeldTaskIds(store, workerId) {
  let names;
  try {
    names = readdirSync3(store.dirPath);
  } catch {
    return [];
  }
  const out = [];
  for (const name2 of names) {
    if (!name2.endsWith(".json") || name2 === "worker_stats.json") continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync3(join3(store.dirPath, name2), "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const task = parsed;
    if (task.claimed_by !== workerId) continue;
    if (task.status !== "claimed" && task.status !== "running") continue;
    const limit = task.max_budget_tokens;
    const used = task.tokens_used;
    if (typeof limit !== "number" || typeof used !== "number") continue;
    if (limit <= 0 || used < limit) continue;
    if (typeof task.task_id === "string" && task.task_id.length > 0) out.push(task.task_id);
  }
  return out;
}
function budgetAwareResult(store, workerId, entries) {
  if (overBudgetHeldTaskIds(store, workerId).length === 0) return { ok: true, entries };
  appendInbox(store, workerId, BUDGET_LIMIT_EXCEEDED_MESSAGE, "system");
  const path = inboxPathOf(store, workerId);
  if (path === void 0) return { ok: true, entries };
  const queued = readEntries(path).filter((entry) => entry.text === BUDGET_LIMIT_EXCEEDED_MESSAGE);
  return { ok: true, entries: queued.length > 0 ? [...entries, queued[0]] : entries };
}
function inboxSize(store, workerId) {
  const path = inboxPathOf(store, workerId);
  if (path === void 0) return 0;
  return readEntries(path).length;
}
function readEntries(path) {
  let raw;
  try {
    raw = readFileSync3(path, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    if (typeof record.text !== "string" || record.text.length === 0) continue;
    out.push({
      ts: typeof record.ts === "string" ? record.ts : "",
      from: typeof record.from === "string" ? record.from : "",
      text: record.text
    });
  }
  return out;
}
function errorCode(error) {
  const code = error.code;
  return typeof code === "string" ? code : void 0;
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/core/recall.ts
var RECALL_FIELD_ORDER = ["anchor", "title", "description", "result"];
var RECALL_LIMIT_DEFAULT = 20;
function recallTasks(tasks, query, limit = RECALL_LIMIT_DEFAULT) {
  const needle = normalize(query);
  if (needle.length === 0) return [];
  const hits = [];
  for (const task of tasks) {
    const matchedIn = fieldsMatching(task, needle);
    if (matchedIn.length === 0) continue;
    hits.push({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      anchors: [...task.anchors],
      matchedIn
    });
  }
  hits.sort((left, right) => {
    const rank = RECALL_FIELD_ORDER.indexOf(left.matchedIn[0] ?? "result") - RECALL_FIELD_ORDER.indexOf(right.matchedIn[0] ?? "result");
    if (rank !== 0) return rank;
    return left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0;
  });
  const budget = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return budget > 0 ? hits.slice(0, budget) : hits;
}
function fieldsMatching(task, needle) {
  const matched = [];
  if (task.anchors.some((anchor) => normalize(anchor).includes(needle))) matched.push("anchor");
  if (normalize(task.title).includes(needle)) matched.push("title");
  if (normalize(task.description).includes(needle)) matched.push("description");
  if (normalize(task.result).includes(needle)) matched.push("result");
  return matched;
}
function normalize(value) {
  return value.toLowerCase();
}

// src/core/similarity.ts
var CACHE_THRESHOLD = 0.9;
function tokenize(text2) {
  const words = text2.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = [];
  for (const word of words) {
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (const character of word) out.push(character);
    } else {
      out.push(word);
    }
  }
  return out;
}
function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
function textSimilarity(a, b) {
  return jaccard(
    tokenize(`${a.title} ${a.description}`),
    tokenize(`${b.title} ${b.description}`)
  );
}
function capabilitySimilarity(a, b) {
  return jaccard(
    a.required_capabilities.map((capability) => capability.trim().toLowerCase()).filter(Boolean),
    b.required_capabilities.map((capability) => capability.trim().toLowerCase()).filter(Boolean)
  );
}
function combinedSimilarity(a, b) {
  return 0.6 * textSimilarity(a, b) + 0.4 * capabilitySimilarity(a, b);
}
function asInput(value) {
  return {
    title: value.title,
    description: value.description,
    required_capabilities: value.required_capabilities
  };
}
function findCachedSolution(completedTasks, candidate, threshold = CACHE_THRESHOLD) {
  const input = asInput(candidate);
  const candidateId = "task_id" in candidate && typeof candidate.task_id === "string" ? candidate.task_id : "";
  let best;
  for (const task of completedTasks) {
    if (task.status !== "completed") continue;
    if (task.result.length === 0) continue;
    if (task.task_id === candidateId) continue;
    const score = combinedSimilarity(input, asInput(task));
    if (score < threshold) continue;
    if (best === void 0 || score > best.score) best = { task, score };
  }
  if (best === void 0) return void 0;
  return {
    task_id: candidateId,
    cached_task_id: best.task.task_id,
    similarity: Math.round(best.score * 1e4) / 1e4,
    result: best.task.result,
    anchors: [...best.task.anchors]
  };
}

// src/tools-file.ts
var text = (value) => [{ type: "text", text: value }];
var MAX_PLAN_TASKS = 200;
var MAX_RESULT_CHARS = 4e3;
var MAX_WHISPER_CHARS = 1e3;
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
function registerFileTools({ ctx, store, staleAssignmentSec, max_workers, worker_tiers, worker_profiles, quality_gate_command, forbid_inline_comments, disposers }) {
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_plan",
    description: "Create the task pool on disk: one JSON file per task under .dsh-tasks/. Call this first, with the whole decomposition. An existing task_id is never overwritten \u2014 it is reported as a conflict so a repeated call cannot silently reset finished work. blocked_by names other task_ids in the same call or already on disk; a task is ready only once every blocker is completed. Each task may also set `priority` (larger claims first; ties are FIFO by creation time) and `required_files` (workspace-relative paths that must exist before the task may be claimed); `required_hashes` pins each of those files to a sha256 digest, so a changed prerequisite refuses the claim with `hash_mismatch`. Routing fields: `complexity`, `required_worker_tier`, `required_capabilities` (worker must declare every tag), `estimated_tokens` (must fit the worker context window) and `max_cost_tokens` (budget ceiling; a worker whose rate would exceed it is refused with `worker_too_expensive`), `max_duration_ms` (per-attempt wall clock, surfaced as [OVERDUE]), `model` (the recorded assignment; empty means inherit), `max_budget_tokens` (task-wide token ceiling; crossing it blocks the task instead of completing it) and `anchors` (2-3 durable file:line/symbol pointers, searchable through swarm_recall). A task whose title/description/capabilities match a completed task at >=90% returns a `cache_hint` carrying that result and its anchors; reuse is advisory, never automatic.",
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
            max_cost_tokens: { type: "number", description: "Budget ceiling for this task cost (rate \xD7 tokens/1000). 0 means no ceiling." },
            max_duration_ms: { type: "number", description: "Wall-clock budget for one attempt in ms; 0 means no limit. When a running task exceeds it, swarm_status marks it [OVERDUE] so the Lead knows to step in. Nothing is killed." },
            model: { type: "string", description: 'Model this task is assigned to, as the scheduler records it (a name, never a provider decision). Empty means "inherit from the worker/session" and swarm_status shows `on inherit`. There is no automatic downgrade: this field is informational unless the Lead changes it.' },
            max_budget_tokens: { type: "number", description: "Token budget for the whole task across attempts; 0 means no ceiling. A successful completion that would push tokens_used past it is recorded as blocked (Budget exceeded), not completed." },
            anchors: { type: "array", description: "2-3 durable anchors: workspace-relative file:line or symbol paths that let a later worker find this work again. Searched by swarm_recall.", items: { type: "string" } }
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
          cache_hints: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string" },
                cached_task_id: { type: "string" },
                similarity: { type: "number" },
                result: { type: "string" },
                anchors: { type: "array", items: { type: "string" } }
              }
            }
          },
          dir: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const created = value.created ?? [];
        const conflicts = value.conflicts ?? [];
        const errors = value.errors ?? [];
        const warnings = value.warnings ?? [];
        const cacheHints = value.cache_hints ?? [];
        const lines = [`pool: ${created.length} created, ${conflicts.length} conflict(s), ${errors.length} error(s)`];
        if (created.length > 0) lines.push(`  created: ${created.join(", ")}`);
        if (conflicts.length > 0) lines.push(`  already present (not overwritten): ${conflicts.join(", ")}`);
        if (cacheHints.length > 0) {
          lines.push(...cacheHints.map(
            (hint) => `  [cache] ${hint.task_id ?? "?"} ~ ${hint.cached_task_id ?? "?"} (${Math.round((hint.similarity ?? 0) * 100)}%): reuse or plan the delta`
          ));
        }
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
      const cacheHints = [];
      const incoming = args.tasks ?? [];
      if (incoming.length > MAX_PLAN_TASKS) {
        return { created, conflicts, errors: [`${incoming.length} tasks exceeds the ${MAX_PLAN_TASKS} limit for one call`], warnings, cache_hints: cacheHints, dir: TASKS_DIR, degraded: "" };
      }
      const ensured = await store.ensureDir();
      if (!ensured.ok) errors.push(`pool directory unavailable: ${ensured.error ?? "unknown"}`);
      const completedTasks = (await store.readAll()).tasks;
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
          max_cost_tokens: Math.max(0, spec.max_cost_tokens ?? 0),
          max_duration_ms: Math.max(0, spec.max_duration_ms ?? 0),
          // v1.4.0: the routing surface. `model` is a recorded assignment, never
          // a dispatch decision — the scheduler has no provider and no fallback.
          model: (spec.model ?? "").trim(),
          max_budget_tokens: Math.max(0, spec.max_budget_tokens ?? 0),
          anchors: (spec.anchors ?? []).map((anchor) => anchor.trim()).filter((anchor) => anchor.length > 0)
        });
        const written = await store.createExclusive(record);
        if (written.ok) {
          created.push(taskId);
          const hint = findCachedSolution(completedTasks, record);
          if (hint !== void 0) cacheHints.push(hint);
        } else if ((written.error ?? "").includes("already exists")) conflicts.push(taskId);
        else errors.push(`${taskId}: ${written.error ?? "write failed"}`);
      }
      return {
        created,
        conflicts,
        errors,
        warnings,
        cache_hints: cacheHints,
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
          code: { type: "string", enum: ["claimed", "already_claimed", "not_found", "invalid_state", "scope_conflict", "missing_dependencies", "hash_mismatch", "worker_too_weak", "worker_lacks_capability", "worker_context_too_small", "worker_too_expensive", "worker_unreliable", "worker_not_preferred", "worker_busy", "isolation_unavailable", "io_error"] },
          message: { type: "string" },
          claimed_by: { type: "string" },
          claimed_at: { type: "string" },
          stale_lock_cleared: { type: "boolean" },
          workspace: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.workspace !== void 0 && value.workspace !== "" ? `
  workspace: ${value.workspace} \u2014 work inside it; swarm_complete merges it back` : "") + (value.stale_lock_cleared === true ? "\n  note: a stale lock left by a dead holder was cleared" : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
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
        // Isolation (v1.4.0): a high-complexity claim happens in a linked git
        // worktree. The path is printed so the worker edits *there* — an edit in
        // the main checkout while a worktree is claimed would be invisible to the
        // merge that completes the task.
        workspace: outcome.workspace ?? after.task?.workspace ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_complete",
    description: "Record that one task finished, with its outcome. Call it yourself when you did the work, or on a worker's behalf when it reported back. The result is the compressed outcome \u2014 paths, decisions, evidence. Use success=false to mark a failure (will retry up to max_retries, then become blocked). On success you may report actual_tokens and duration_ms: they feed the per-worker performance averages shown by swarm_status. Attach 2-3 `anchors` (workspace-relative file:line or symbol paths) when you finish: they are what swarm_recall searches, so they must point at the work, not at a summary. A second completion of the same task is refused rather than silently accepted. If this deployment configured `quality_gate_command`, every success claim runs that command first: a non-zero exit turns the completion into a failure (retry_count + 1), so `success: true` is a claim, not a decision. Set `skip_local_gate: true` to defer that command: the task is recorded as `pending_review` and the Lead runs the final gate once. Pass `reviewed: true` (Lead only) to finalise a `pending_review` task after that global gate.",
    parameters: {
      task_id: { type: "string", required: true, description: "Task that finished" },
      result: { type: "string", required: true, description: "Compressed outcome: files, decisions, evidence" },
      completed_by: { type: "string", required: true, description: "Agent id that did the work" },
      success: { type: "boolean", description: "Whether the task succeeded (default true). False triggers retry logic." },
      actual_tokens: { type: "number", description: "Optional self-report: tokens consumed by this task" },
      duration_ms: { type: "number", description: "Optional self-report: wall time spent on this task, in milliseconds" },
      anchors: { type: "array", description: "2-3 durable pointers (workspace-relative file:line or symbol paths) that let a later worker find this work with swarm_recall.", items: { type: "string" } },
      skip_local_gate: { type: "boolean", description: "Defer the local quality gate (v1.6.0): a successful completion becomes pending_review instead of completed. Default false." },
      reviewed: { type: "boolean", description: "Lead-only (v1.6.0): finalise a pending_review task as completed after the global gate passed." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["completed", "failed", "blocked", "pending_review", "not_found", "invalid_state", "io_error", "result_too_long"] },
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
      const anchors = (args.anchors ?? []).map((anchor) => anchor.trim()).filter((anchor) => anchor.length > 0);
      if (anchors.length > 0) {
        const current = await store.readOne(args.task_id);
        const held = current.task;
        if (held !== void 0 && (held.status === "claimed" || held.status === "running")) {
          await store.writeExisting({ ...held, anchors });
        }
      }
      const gateCommand = quality_gate_command.trim();
      const successClaim = args.success ?? true;
      const skipLocalGate = args.skip_local_gate === true;
      const reviewed = args.reviewed === true;
      const options = {};
      if (gateCommand.length > 0) {
        options.qualityGate = { command: gateCommand };
        options.cwd = store.workspacePath;
      }
      if (skipLocalGate) options.skipLocalGate = true;
      if (reviewed) options.reviewed = true;
      if (forbid_inline_comments && successClaim) {
        const held = (await store.readOne(args.task_id)).task;
        if (held !== void 0) {
          options.commentAudit = {
            repoRoot: store.workspacePath,
            workspace: held.workspace,
            scopes: held.write_scopes
          };
        }
      }
      const outcome = await completeTask(
        store,
        args.task_id,
        args.result,
        args.completed_by,
        void 0,
        successClaim,
        { actual_tokens: args.actual_tokens, duration_ms: args.duration_ms },
        Object.keys(options).length > 0 ? options : void 0
      );
      const gateDowngraded = (args.success ?? true) && outcome.gate_failed === true;
      const note = gateDowngraded ? `Your success claim was not accepted: the deployment's quality gate command (\`${gateCommand}\`) did not pass. The task is recorded as ${outcome.code}, not completed. Fix the workspace so the gate command exits 0, then retry.` : "";
      const silence = outcome.ok && !gateDowngraded ? "Result saved to pool. Do not send_message to Lead. You are now idle." : "";
      const pendingReview = outcome.ok && outcome.code === "pending_review";
      const reviewNote = pendingReview ? "Recorded as pending_review: the Lead runs the final global gate once and finalises it with reviewed: true." : "";
      const parts = [outcome.message, note, reviewNote, silence].filter((part) => part.length > 0);
      const after = outcome.ok ? await store.readOne(args.task_id) : { task: void 0 };
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: parts.join(" | "),
        completed_at: after.task?.completed_at ?? "",
        degraded: outcome.degraded ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_status",
    description: "Report the whole pool in one call: how many tasks exist in each of the seven states (pending, claimed, running, completed, failed, blocked, pending_review), how many are ready to start, how many are still blocked, and a compact line per task. A claim/running older than `staleAssignmentSec` is marked STALE \u2014 a suspicion that its worker died mid-task. Release such a task with swarm_release if you agree it is abandoned; or use swarm_reap to automatically recover stale tasks. Use this to decide whether to plan more, assign more, or stop. Pass include_log=true to see the last 5 log lines per task.",
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
          pending_review: { type: "integer" },
          ready: { type: "integer" },
          stale: { type: "integer" },
          stale_after_sec: { type: "integer" },
          overdue: { type: "integer" },
          big_tasks: { type: "array", items: { type: "string" } },
          tasks: { type: "array", items: { type: "string" } },
          workers: { type: "array", items: { type: "string" } },
          warning: { type: "string" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const tasks = value.tasks ?? [];
        const workers = value.workers ?? [];
        const stale = value.stale ?? 0;
        const head = `pool ${value.dir ?? TASKS_DIR}: total ${value.total ?? 0} \xB7 pending ${value.pending ?? 0} \xB7 claimed ${value.claimed ?? 0} \xB7 running ${value.running ?? 0}${stale > 0 ? ` (${stale} stale)` : ""} \xB7 completed ${value.completed ?? 0} \xB7 failed ${value.failed ?? 0} \xB7 blocked ${value.blocked ?? 0} \xB7 pending_review ${value.pending_review ?? 0} \xB7 ready ${value.ready ?? 0}`;
        const overdue = value.overdue ?? 0;
        const hint = [
          ...stale > 0 ? [`  \u26A0 ${stale} task(s) older than ${value.stale_after_sec ?? 0}s \u2014 release with swarm_release or reap with swarm_reap if abandoned`] : [],
          ...overdue > 0 ? [`  \u23F1 ${overdue} running task(s) past their own max_duration_ms \u2014 check whether the estimate was wrong or the worker is stuck`] : []
        ];
        const workerLines = workers.length > 0 ? ["  workers:", ...workers.map((line) => `    ${line}`)] : [];
        const warningLine = value.warning !== void 0 && value.warning !== "" ? [value.warning] : [];
        return text([
          head,
          ...hint,
          ...tasks.map((line) => `  ${line}`),
          ...workerLines,
          ...value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : [],
          ...warningLine
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
      const pendingReview = views.filter((view) => view.status === "pending_review").length;
      const ready = views.filter((view) => view.ready).length;
      const stale = views.filter((view) => view.stale).length;
      const overdue = views.filter((view) => view.overdue).length;
      const bigTasks = [...new Set(views.map((view) => view.big_task_id).filter((id) => id.length > 0))].sort();
      const taskLines = views.map((view) => {
        let line = `${view.task_id} [${view.status}${view.ready ? ", ready" : ""}]`;
        if (view.claimed_by.length > 0) line += ` by ${view.claimed_by}`;
        if (view.stale) {
          if (view.status === "running") line += ` [STALE, running ${formatAge(view.running_age_sec ?? 0)} ago, heartbeat ${formatAge(view.heartbeat_age_sec ?? 0)} ago]`;
          else line += ` [STALE, claimed ${formatAge(view.claimed_age_sec ?? 0)} ago]`;
        }
        if (view.overdue) {
          line += ` [OVERDUE, running ${formatAge(view.running_age_sec ?? 0)} ago, budget ${formatAge(Math.floor(view.max_duration_ms / 1e3))} \u2014 consider extending, splitting, or interrupting]`;
        }
        if (view.blocked_by_open.length > 0) line += ` waiting on ${view.blocked_by_open.join(",")}`;
        if (view.status === "failed" || view.status === "blocked") {
          line += ` (retry ${view.retry_count}/${view.max_retries}`;
          if (view.failure_reason) line += `, reason: ${view.failure_reason}`;
          line += ")";
        }
        if (view.status === "pending_review") {
          line += " (awaiting final gate: finalise with swarm_complete reviewed:true)";
        }
        line += ` \u2014 ${view.title}`;
        line += ` [ROUTING] Task ${view.task_id} on ${view.model !== "" ? view.model : "inherit"}`;
        if (view.needs_upgrade) line += " \u26A0 needs_upgrade";
        if (view.tokens_used > 0 || view.max_budget_tokens > 0) {
          line += ` [budget: ${formatTokens(view.tokens_used)}/${view.max_budget_tokens > 0 ? formatTokens(view.max_budget_tokens) : "\u221E"}]`;
        }
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
        const health = workerHealth(stats, id);
        const ratePercent = Math.round(health.rate * 100);
        const avg = health.avgMs !== void 0 ? formatAge(health.avgMs / 1e3) : "n/a";
        line += ` [health: ${ratePercent}% \xB7 ${avg}]`;
        const tokenSamples = entry.tokens_sample_count ?? 0;
        const timeSamples = entry.time_sample_count ?? 0;
        if (tokenSamples > 0 || timeSamples > 0) {
          const avgTokens = tokenSamples > 0 ? `${formatTokens(Math.round(entry.total_tokens_consumed / tokenSamples))} tokens` : "n/a tokens";
          const avgSeconds = timeSamples > 0 ? entry.total_task_time_ms / timeSamples / 1e3 : Number.NaN;
          const avgTime = timeSamples > 0 ? `${formatAge(avgSeconds)}/task` : "n/a/\u4EFB\u52A1";
          line += ` | avg ${avgTokens}, ${avgTime}`;
        }
        return line;
      });
      const warning = idlePoolWarning(ready, claimed + running, Object.keys(worker_profiles).length);
      return {
        dir: TASKS_DIR,
        total: views.length,
        pending,
        claimed,
        running,
        completed,
        failed,
        blocked,
        pending_review: pendingReview,
        ready,
        stale,
        stale_after_sec: staleAssignmentSec,
        overdue,
        big_tasks: bigTasks,
        tasks: taskLines,
        workers: workerLines,
        warning: warning ?? "",
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
    description: 'Watchdog: scan claimed/running tasks and recover those past the staleAssignmentSec threshold. - claimed (not running) past threshold: revert to pending, delete lock. - running past threshold but before 1.5x: report "stale" only \u2014 failure_reason flags the silence, status stays running, retry_count and completed_at untouched. - running past 1.5x threshold without a heartbeat: mark failed (heartbeat timeout), increment retry_count; if retry_count >= max_retries, mark blocked. Returns list of reaped tasks and their outcomes. Call periodically from the Lead.',
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
                action: { type: "string", enum: ["released", "failed", "blocked", "stale"] },
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
      const stop = outcome.ok ? "Escalated successfully. The Lead has been notified. Stop working and remain silent." : "";
      return {
        ok: outcome.ok,
        code: outcome.code,
        message: stop.length > 0 ? `${outcome.message} | ${stop}` : outcome.message,
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
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_whisper",
    description: 'Leave a short message in a worker\'s inbox instead of waking it. `send_message` starts a turn \u2014 the right tool for "come back now", the wrong one for "when you next pick up work, start from max-4": a whisper survives a worker that is busy, idle, or not spawned yet, and costs nothing until it asks for work. The worker drains it with `swarm_inbox`. Keep it to one instruction (max 1000 chars); a handoff belongs in the task description or a file, not here.',
    parameters: {
      worker_id: { type: "string", required: true, description: "Agent id that will read it, e.g. worker-code-2" },
      message: { type: "string", required: true, description: "The instruction, one paragraph at most" },
      from: { type: "string", description: "Who is speaking. Default lead." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["written", "invalid_worker", "too_long", "empty_message", "io_error"] },
          message: { type: "string" },
          path: { type: "string" },
          queue_size: { type: "integer" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.message ?? ""}` + (value.ok === true && (value.queue_size ?? 0) > 0 ? `
  ${value.queue_size} whisper(s) now waiting` : "") + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const workerId = args.worker_id.trim();
      const from = (args.from ?? "lead").trim() || "lead";
      if (args.message.trim().length === 0) {
        return {
          ok: false,
          code: "empty_message",
          message: "whisper text is empty",
          path: "",
          queue_size: 0,
          degraded: ""
        };
      }
      if (args.message.length > MAX_WHISPER_CHARS) {
        return {
          ok: false,
          code: "too_long",
          message: `whisper is ${args.message.length} chars; keep it under ${MAX_WHISPER_CHARS} \u2014 put a handoff in the task description or a file`,
          path: "",
          queue_size: 0,
          degraded: ""
        };
      }
      const written = appendInbox(store, workerId, args.message, from);
      if (!written.ok) {
        const invalid = written.error !== void 0 && written.error.startsWith("invalid worker id");
        return {
          ok: false,
          code: invalid ? "invalid_worker" : "io_error",
          message: written.error ?? "whisper not written",
          path: written.path,
          queue_size: 0,
          degraded: store.degraded ?? ""
        };
      }
      const queue = inboxSize(store, workerId);
      return {
        ok: true,
        code: "written",
        message: `whisper delivered to ${workerId} from ${from}`,
        path: written.path,
        queue_size: queue,
        degraded: store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_inbox",
    description: "Drain a worker's inbox: return every whisper waiting for it, and clear the slot. This is an ack \u2014 the same call twice returns the second batch, not the first. Workers should call it every few steps (the dispatch protocol says every 3 steps) so a Lead instruction is not read only after the task is done. The match is by `worker_id`: an id that was never whispered to returns an empty success, not an error. This is also the budget checkpoint (v1.5.1): when the worker holds a task whose `tokens_used` has reached `max_budget_tokens`, the drain appends and returns a [SYSTEM] budget warning telling it to stop.",
    parameters: {
      worker_id: { type: "string", required: true, description: "Agent id whose inbox to drain, e.g. worker-code-2" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["drained", "empty", "invalid_worker", "io_error"] },
          worker_id: { type: "string" },
          count: { type: "integer" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                ts: { type: "string" },
                from: { type: "string" },
                text: { type: "string" }
              }
            }
          },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const entries = value.entries ?? [];
        if (value.ok !== true) {
          return text(`REJECTED ${value.code ?? "?"}: ${value.worker_id ?? ""}` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""));
        }
        if (entries.length === 0) {
          return text(`OK inbox ${value.worker_id ?? ""}: empty`);
        }
        return text([
          `OK inbox ${value.worker_id ?? ""}: ${value.count ?? entries.length} whisper(s)`,
          ...entries.map((entry) => `  [${entry.ts ?? ""}] ${entry.from ?? ""}: ${entry.text ?? ""}`),
          ...value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : []
        ].join("\n"));
      }
    },
    async execute(args) {
      const workerId = args.worker_id.trim();
      const drained = readInbox(store, workerId);
      if (!drained.ok) {
        const invalid = drained.error !== void 0 && drained.error.startsWith("invalid worker id");
        return {
          ok: false,
          code: invalid ? "invalid_worker" : "io_error",
          worker_id: workerId,
          count: 0,
          entries: [],
          degraded: drained.error ?? store.degraded ?? ""
        };
      }
      return {
        ok: true,
        code: drained.entries.length > 0 ? "drained" : "empty",
        worker_id: workerId,
        count: drained.entries.length,
        entries: drained.entries,
        degraded: store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_dispatch",
    description: "Send one worker a short dispatch instruction with the context-stripping red line built in (v1.7.0). The instruction lands in the worker's whisper inbox, never in a long conversation: requirement prose belongs in the pool task `description`, not in the message. A message longer than 500 characters is truncated to 500 and a [SYSTEM] notice tells the worker to read the pool for full context. With `task_id`, a short standard instruction names the task to pull.",
    parameters: {
      worker_id: { type: "string", required: true, description: "Agent id to dispatch to, e.g. worker-code" },
      message: { type: "string", required: true, description: "Short instruction; truncated above 500 chars" },
      task_id: { type: "string", description: "Optional task id to put in the standard claim instruction" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", enum: ["dispatched", "invalid_worker", "io_error"] },
          worker_id: { type: "string" },
          final_text: { type: "string" },
          truncated: { type: "boolean" },
          chars: { type: "integer" },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => text(`${value.ok === true ? "OK" : "REJECTED"} ${value.code ?? "?"}: ${value.worker_id ?? ""} (${value.chars ?? 0} chars${value.truncated === true ? ", truncated" : ""})` + (value.degraded !== void 0 && value.degraded !== "" ? `
  degraded: ${value.degraded}` : ""))
    },
    async execute(args) {
      const workerId = args.worker_id.trim();
      const built = buildDispatchText(args.message, args.task_id);
      const written = appendInbox(store, workerId, built.text, "lead");
      const invalid = written.error !== void 0 && written.error.startsWith("invalid worker id");
      return {
        ok: written.ok,
        code: written.ok ? "dispatched" : invalid ? "invalid_worker" : "io_error",
        worker_id: workerId,
        final_text: built.text,
        truncated: built.truncated,
        chars: built.text.length,
        degraded: written.error ?? store.degraded ?? ""
      };
    }
  })));
  disposers.push(ctx.tools.register(defineTool({
    name: "swarm_recall",
    description: "Find tasks in the pool whose anchors, title, description or result contain `query` (case-insensitive substring). Use it before re-solving something: an anchor such as `src/core/task-store.ts:claimTask` recalls every attempt that touched that code, with the field it matched and each task's status. Anchors rank above titles, which rank above descriptions and results, and ties are ordered by task id, so the same query returns the same shortlist twice. An empty query matches nothing.",
    parameters: {
      query: { type: "string", required: true, description: "Substring to look for, e.g. a path, symbol or decision id" },
      limit: { type: "number", description: `Maximum hits; default ${RECALL_LIMIT_DEFAULT}, 0 means no cap.` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          query: { type: "string" },
          count: { type: "integer" },
          matches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string" },
                title: { type: "string" },
                status: { type: "string" },
                anchors: { type: "array", items: { type: "string" } },
                matchedIn: { type: "array", items: { type: "string" } }
              }
            }
          },
          degraded: { type: "string" }
        }
      },
      render: (_args, value) => {
        const matches = value.matches ?? [];
        if (value.ok !== true) {
          return text(`REJECTED recall: ${value.degraded ?? "pool unreadable"}`);
        }
        if (matches.length === 0) {
          return text(`recall "${value.query ?? ""}": no match`);
        }
        return text([
          `recall "${value.query ?? ""}": ${value.count ?? matches.length} match(es)`,
          ...matches.map((match) => `  ${match.task_id} [${match.status ?? "?"}] ${match.title ?? ""} \u2014 matched in ${(match.matchedIn ?? []).join(",")}`),
          ...value.degraded !== void 0 && value.degraded !== "" ? [`  degraded: ${value.degraded}`] : []
        ].join("\n"));
      }
    },
    async execute(args) {
      const all = await store.readAll();
      const matches = all.io.ok ? recallTasks(all.tasks, args.query, args.limit ?? RECALL_LIMIT_DEFAULT) : [];
      return {
        ok: all.io.ok,
        query: args.query,
        count: matches.length,
        matches,
        degraded: all.io.error ?? all.io.degraded ?? store.degraded ?? ""
      };
    }
  })));
}

// src/utils/math.ts
function add(a, b) {
  return a + b;
}
function subtract(a, b) {
  return a - b;
}

// src/utils/http.ts
var DEFAULT_MAX_CONCURRENT = 2;
var FetchTimeoutError = class extends Error {
  /** The timeout that elapsed, in milliseconds. */
  timeoutMs;
  /** The URL whose request was aborted. */
  url;
  constructor(url, timeoutMs) {
    super(`request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
};
var ConcurrencyLimiter = class {
  #max;
  #active = 0;
  #waiters = [];
  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be a positive integer, got ${String(maxConcurrent)}`);
    }
    this.#max = maxConcurrent;
  }
  /** Requests currently holding a permit. */
  get active() {
    return this.#active;
  }
  /** Callers waiting for a permit. */
  get waiting() {
    return this.#waiters.length;
  }
  /** The configured ceiling. */
  get maxConcurrent() {
    return this.#max;
  }
  /**
   * Run `task` once a permit is available, releasing the permit afterwards.
   *
   * The `finally` is the only release path on purpose: a task that rejects must
   * not shrink the pool, or a few failures would leave the limiter permantently
   * full and every later caller waiting forever.
   */
  async run(task) {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
  /** Take a permit (waiting if needed); resolves with the release function. */
  acquire() {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise((resolve3) => {
      this.#waiters.push(() => resolve3(this.#releaseOnce()));
    });
  }
  /**
   * A release that is idempotent.
   *
   * Double-releasing is the classic semaphore bug: it makes `active` drift below
   * the truth and silently admits an extra request, so the limit stops holding.
   */
  #releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next !== void 0) {
        this.#active += 1;
        next();
      }
    };
  }
};
function withConcurrencyLimit(maxConcurrent, task) {
  return new ConcurrencyLimiter(maxConcurrent).run(task);
}
var sharedLimiters = /* @__PURE__ */ new Map();
function sharedLimiterFor(maxConcurrent) {
  const existing = sharedLimiters.get(maxConcurrent);
  if (existing !== void 0) return existing;
  const created = new ConcurrencyLimiter(maxConcurrent);
  sharedLimiters.set(maxConcurrent, created);
  return created;
}
async function fetchWithTimeout(url, options = {}) {
  const { timeout, maxConcurrent = DEFAULT_MAX_CONCURRENT, init } = options;
  const limiter = sharedLimiterFor(maxConcurrent);
  return limiter.run(async () => {
    const hasDeadline = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0;
    if (!hasDeadline) {
      return fetch(url, init);
    }
    const controller = new AbortController();
    if (init?.signal !== void 0 && init.signal !== null) {
      if (init.signal.aborted) controller.abort(init.signal.reason);
      else init.signal.addEventListener("abort", () => controller.abort(init.signal?.reason), { once: true });
    }
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FetchTimeoutError(url, timeout));
      }, timeout);
    });
    try {
      return await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadline]);
    } catch (caught) {
      if (controller.signal.aborted) throw new FetchTimeoutError(url, timeout);
      throw caught;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  });
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
   "\u53BB swarm_ready \u67E5\u5C31\u7EEA\u4EFB\u52A1\uFF0Cswarm_claim \u81EA\u9886\uFF0Cswarm_start \u5F00\u5DE5\uFF0C\u505A\u5B8C\u7528 swarm_complete \u56DE\u62A5\uFF08\u5931\u8D25\u65F6 success=false\uFF0C\u6210\u529F\u65F6\u53EF\u9644\u5E26 actual_tokens / duration_ms \u4F9B\u6027\u80FD\u7EDF\u8BA1\uFF09\uFF0C\u7136\u540E\u56DE\u5230 swarm_ready \u518D\u62C9\u4E00\u5708\uFF0C\u76F4\u5230 swarm_ready \u8FD4\u56DE 0\u3002\u9884\u8BA1\u8017\u65F6\u8D85\u8FC7 staleAssignmentSec \u4E00\u534A\u7684\u4EFB\u52A1\uFF0Crunning \u671F\u95F4\u6BCF\u9694\u4E00\u6BB5\u65F6\u95F4\u8C03\u4E00\u6B21 swarm_heartbeat \u7EED\u7EA6\u3002\u5982\u679C\u4F60\u53D1\u73B0\u81EA\u5DF1\u641E\u4E0D\u5B9A\uFF08\u7F3A\u5173\u952E\u6587\u4EF6\u3001\u4EE3\u7801\u51B2\u7A81\u65E0\u6CD5\u89E3\u51B3\u3001\u9700\u6C42\u672C\u8EAB\u9700\u8981\u91CD\u65B0\u89C4\u5212\uFF09\uFF0C\u4E0D\u8981\u786C\u5199\u5047\u4EE3\u7801\uFF0C\u8C03\u7528 swarm_escalate \u628A\u4EFB\u52A1\u6302\u8D77\uFF08\u72B6\u6001\u53D8 blocked\uFF0C\u539F\u56E0\u5199\u8FDB failure_reason\uFF09\uFF0C\u8BA9 Lead \u91CD\u65B0\u89C4\u5212\u3002**\u6BCF\u5B8C\u6210\u4E00\u4E2A\u4EFB\u52A1\u5C31\u628A\u7ED3\u679C\u7559\u5728\u6C60\u5B50\u91CC\uFF0C\u4E0D\u8981 send_message \u901A\u77E5 Lead\uFF1B\u53EA\u6709 swarm_escalate \u624D\u662F\u9700\u8981\u53EB\u9192 Lead \u7684\u901A\u9053\u3002**"

4. \u4E0D\u8981\u6307\u5B9A\u5177\u4F53\u4EFB\u52A1\u7ED9 worker\u3002\u8C01\u9886\u5230\u54EA\u4E00\u4E2A\u662F\u539F\u5B50\u7ADE\u4E89\u7684\u7ED3\u679C\u3002

5. \u7528 swarm_status \u67E5\u770B\u6574\u4F53\u8FDB\u5EA6\uFF0C\u5411\u7528\u6237\u6C47\u62A5\u3002

6. **\u3010\u9759\u9ED8\u6267\u884C\u539F\u5219\u3011\u2014\u2014\u8FD9\u6761\u4F18\u5148\u7EA7\u9AD8\u4E8E\u4E0B\u9762\u7684\u6240\u6709\u6C9F\u901A\u89C4\u5219\u3002**
   Worker \u5B8C\u6210\u4E00\u4E2A\u4EFB\u52A1\u540E\uFF0C**\u7EDD\u5BF9\u4E0D\u8981\u7528 send_message \u547C\u53EB Lead**\u3002\u76F4\u63A5\u8C03 swarm_complete \u628A\u7ED3\u679C\u5199\u8FDB\u6587\u4EF6\u6C60\u5C31\u662F\u5168\u90E8\u4EA4\u4ED8\uFF1ALead \u4F1A\u81EA\u5DF1\u6309\u8282\u594F\u67E5\u6C60\u5B50\uFF0C\u90A3\u6761\u6D88\u606F\u53EA\u4F1A\u628A\u5DF2\u7ECF\u7ED3\u675F\u7684 Lead \u8F6E\u6B21\u5F3A\u884C\u5524\u9192\uFF0C\u6362\u4E0D\u6765\u4EFB\u4F55\u65B0\u51B3\u7B56\uFF0C\u7EAF\u70E7 Token\u3002
   \u7ED9 Worker \u7684\u6D3E\u53D1\u6D88\u606F\u91CC\u4E5F**\u4E0D\u8981**\u8981\u6C42\u300C\u6BCF\u5B8C\u6210\u4E00\u6761\u5C31\u5411 Lead \u7B80\u62A5\u300D\u2014\u2014\u90A3\u662F\u5728\u6559\u5B83\u5236\u9020\u8BC8\u5C38\u3002
   \u53EA\u6709\u4E24\u79CD\u60C5\u51B5 Worker \u624D\u8BE5\u4E3B\u52A8\u53EB Lead\uFF1A
   - \u5B83**\u641E\u4E0D\u5B9A**\uFF08\u7F3A\u5173\u952E\u6587\u4EF6\u3001\u51B2\u7A81\u65E0\u6CD5\u89E3\u51B3\u3001\u9700\u6C42\u8981\u91CD\u65B0\u89C4\u5212\uFF09\u2192 \u8C03 swarm_escalate\uFF0C\u4EFB\u52A1\u53D8 blocked\uFF0C\u8FD9\u662F\u552F\u4E00\u7684\u300C\u547C\u6551\u300D\u901A\u9053\uFF1B
   - Lead \u660E\u786E\u8981\u6C42\u5B83\u505A\u4E00\u4EF6\u5FC5\u987B\u56DE\u62A5\u7684\u4E8B\uFF08\u4F8B\u5982\u4EE3\u4E3A\u9A8C\u6536\uFF09\u3002
   Lead \u8FD9\u4E00\u4FA7\u540C\u7406\uFF1A**\u53EA\u6709\u5F53\u6574\u4E2A\u6C60\u5B50\u8DD1\u5B8C\uFF08\u6CA1\u6709 pending/claimed/running \u4E86\uFF09\uFF0C\u6216\u8005\u51FA\u73B0 blocked \u4EFB\u52A1\u65F6\uFF0C\u624D\u9700\u8981\u505A\u603B\u7ED3\u5E76\u5411\u7528\u6237\u6C47\u62A5**\uFF1B\u4E2D\u95F4\u6BCF\u5B8C\u6210\u4E00\u4E2A\u4EFB\u52A1\u90FD\u4E0D\u8BE5\u9192\u6765\u3002

7. \u5982\u679C worker \u5728\u6267\u884C\u4E2D\u649E\u5230\u4F9D\u8D56\u51B2\u7A81\uFF08\u6BD4\u5982\u4E24\u4E2A\u4EFB\u52A1\u8981\u6539\u540C\u4E00\u4E2A\u6587\u4EF6\u3001\u6216\u8005\u4E32\u884C\u94FE\u5728\u89C4\u5212\u671F\u6CA1\u58F0\u660E\uFF09\uFF0C\u5B83\u4F1A\u901A\u8FC7 send_message \u62A5\u544A\u4F60\u3002\u4F60\u6536\u5230\u62A5\u544A\u540E\uFF0C\u7528 swarm_set_deps \u8C03\u6574\u4EFB\u52A1\u7684 blocked_by\uFF0C\u628A\u51B2\u7A81\u7684\u4EFB\u52A1\u4E32\u884C\u5316\u3002\u4F9D\u8D56\u8C03\u6574\u53EA\u7531\u4F60\u505A\uFF0C\u4E0D\u8981\u8BA9 worker \u81EA\u5DF1\u6539\u3002
   \u5982\u679C\u6536\u5230 worker \u7684\u547C\u6551\uFF08swarm_escalate\uFF09\uFF0C\u4EFB\u52A1\u4F1A\u4EE5 blocked \u72B6\u6001\u51FA\u73B0\u5E76\u5728 failure_reason \u91CC\u5199\u660E\u539F\u56E0\uFF1B\u7528 swarm_status \u67E5\u770B\uFF0C\u518D\u51B3\u5B9A\u6539\u9700\u6C42\u3001\u8865\u4F9D\u8D56\u6216\u91CD\u65B0\u62C6\u89E3\u3002\u9700\u8981\u4ECE\u67D0\u4E2A Worker \u624B\u91CC\u5F3A\u884C\u6536\u56DE\u4EFB\u52A1\u65F6\uFF0C\u7528 swarm_escalate(force: true)\u3002
   \u6CE8\u610F\uFF1A\u5931\u8D25\u7387\u8FC7\u9AD8\uFF08\u5931\u8D25\u6B21\u6570 > 3 \u4E14\u5931\u8D25\u7387 > 50%\uFF09\u7684 Worker \u4F1A\u88AB\u62D2\u7EDD\u9886\u53D6 complexity=high \u7684\u4EFB\u52A1\uFF08worker_unreliable\uFF09\uFF0C\u4F46 low/medium \u4ECD\u5BF9\u5B83\u5F00\u653E\u2014\u2014\u8FD9\u662F\u6709\u610F\u7684\u300C\u7EC3\u624B\u4E0E\u7FFB\u8EAB\u300D\u901A\u9053\u3002

8. \u770B\u5230 failed \u7684\u4EFB\u52A1\u65F6\uFF0C\u5224\u65AD\u662F\u5426\u91CD\u8BD5\uFF1A\u53EF\u4EE5\u518D\u53D1\u4E00\u6761 send_message \u8BA9 worker \u91CD\u65B0 swarm_start \u8BE5\u4EFB\u52A1\uFF08failed \u4EFB\u52A1\u53EF\u76F4\u63A5 start\uFF09\uFF0C\u6216\u7528 swarm_release \u628A\u5B83\u653E\u56DE pending \u8BA9\u522B\u4EBA\u91CD\u9886\u3002retry_count \u8FBE\u5230 max_retries \u540E\u4F1A\u53D8\u6210 blocked\uFF0C\u6B64\u65F6\u9700\u8981\u4EBA\u5DE5\u4ECB\u5165\u6216\u8C03\u6574\u62C6\u89E3\u3002

9. \u5B9A\u671F\u7528 swarm_status \u67E5\u770B\u8FDB\u5EA6\u3002\u5982\u679C\u67D0\u4E2A\u4EFB\u52A1\u88AB\u6807\u4E3A STALE\uFF08claimed/running \u8D85\u8FC7\u9608\u503C\uFF0C\u53EF\u80FD worker \u5361\u6B7B\u6216\u6D88\u5931\uFF09\uFF0C\u5148\u786E\u8BA4 worker \u662F\u5426\u8FD8\u80FD\u7EED\u7EA6\uFF1B\u786E\u5B9E\u65E0\u54CD\u5E94\u518D\u7528 swarm_reap \u81EA\u52A8\u56DE\u6536\uFF08claimed \u56DE pending\u3001running \u6807 failed \u8D70\u91CD\u8BD5\uFF09\uFF0C\u6216\u6309\u9700\u7528 swarm_release \u91CA\u653E\u4E2A\u522B\u4EFB\u52A1\u3002\u6B63\u5728\u8DD1\u957F\u4EFB\u52A1\u7684 worker \u5E94\u4E3B\u52A8\u8C03 swarm_heartbeat\uFF0C\u907F\u514D\u88AB\u8BEF\u56DE\u6536\u3002

10. \u5E76\u53D1\u4E0A\u9650\u7531 max_workers \u63A7\u5236\uFF08\u9ED8\u8BA4 3\uFF09\u3002swarm_ready \u5728 claimed+running \u8FBE\u5230\u4E0A\u9650\u65F6\u8FD4\u56DE 0\uFF0C\u8FD9\u662F\u6B63\u5E38\u73B0\u8C61\uFF0C\u7B49\u5DF2\u6709\u4EFB\u52A1\u5B8C\u6210\u540E\u518D\u62C9\u3002

11. **\u8D28\u91CF\u95E8\u7981\uFF08\u82E5\u90E8\u7F72\u914D\u7F6E\u4E86 quality_gate_command\uFF09**\uFF1AWorker \u4EA4\u4ED8\u7684\u4EE3\u7801\u5FC5\u987B\u5728\u63D0\u4EA4\u524D\u5C31\u80FD\u901A\u8FC7\u8BE5\u547D\u4EE4\uFF0C\u5426\u5219\u5373\u4F7F swarm_complete \u4F20\u4E86 success:true \u4E5F\u4F1A\u88AB\u81EA\u52A8\u6253\u56DE\u4E3A failed\uFF08retry_count + 1\uFF09\uFF0C\u5E76\u5728 failure_reason \u91CC\u5E26\u4E0A\u547D\u4EE4\u8F93\u51FA\u7684\u524D 500 \u5B57\u7B26\u3002\u56E0\u6B64\uFF1A
    - \u5728**\u4EFB\u52A1\u63CF\u8FF0\u91CC\u628A\u9A8C\u6536\u547D\u4EE4\u5199\u6E05\u695A**\uFF08\u4F8B\u5982\u300C\u9A8C\u6536\uFF1Anpm test \u4E0E npx tsc --noEmit \u5747\u901A\u8FC7\u300D\uFF09\uFF0C\u8BA9 Worker \u77E5\u9053\u95E8\u7981\u4F1A\u8DD1\u4EC0\u4E48\u3002
    - \u4E0D\u8981\u628A\u4E00\u4E2A\u6539\u52A8\u8303\u56F4\u4F1A\u5BFC\u81F4\u5DE5\u4F5C\u533A\u65E0\u6CD5\u6784\u5EFA\u6216\u6D4B\u8BD5\u53D8\u7EA2\u7684\u5C0F\u4EFB\u52A1\u5E76\u884C\u6D3E\u51FA\u53BB\u2014\u2014\u95E8\u7981\u662F\u6309\u6574\u5757\u5DE5\u4F5C\u533A\u5224\u5B9A\u7684\uFF0C\u522B\u4EBA\u7684\u7EA2\u4E5F\u4F1A\u8BB0\u5728\u4F60\u7684\u4EFB\u52A1\u4E0A\u3002
    - Worker \u6536\u5230 failed \u4E0D\u662F\u300Cresult \u88AB\u4E22\u4E86\u300D\uFF0C\u800C\u662F\u300C\u5DE5\u4F5C\u533A\u6CA1\u901A\u8FC7\u300D\uFF1B\u8BA9\u5B83\u4FEE\u597D\u5DE5\u4F5C\u533A\u540E\u91CD\u8BD5\uFF0C\u4E0D\u8981\u9760\u6539\u5199 result \u7ED5\u8FC7\u3002
    - **\u5206\u7EA7\u95E8\u7981\uFF08v1.6.0\uFF09**\uFF1A\u53EA\u6539 .md/.mdx \u6216 test/\u3001tests/\u3001docs/ \u4E0B\u7684\u6587\u4EF6\u65F6\uFF0C\u672C\u5730\u95E8\u7981\u81EA\u52A8\u8DF3\u8FC7\uFF1B\u9700\u8981\u628A\u591A\u6B21\u672C\u5730\u95E8\u7981\u5408\u5E76\u6210\u4E00\u6B21\u5168\u5C40\u68C0\u67E5\u65F6\uFF0CWorker \u53EF\u4F20 skip_local_gate:true\uFF0C\u4EFB\u52A1\u8FDB\u5165 pending_review\uFF08\u7B2C\u4E03\u72B6\u6001\uFF0C\u4E0D\u53EF\u8BA4\u9886\uFF09\u3002\u5168\u90E8\u4EFB\u52A1\u5B8C\u6210\u540E\u7531 Lead \u5728\u4E3B\u5DE5\u4F5C\u533A\u8DD1\u4E00\u6B21\u6700\u4E25\u683C\u7684\u5168\u5C40\u95E8\u7981\uFF0C\u518D\u5BF9\u6BCF\u4E2A pending_review \u4EFB\u52A1\u8C03 swarm_complete(..., reviewed:true) \u843D\u4E3A completed\u3002
    - **\u5EFA\u6C60\u5148\u770B\u7F13\u5B58\uFF08v1.6.0\uFF09**\uFF1Aswarm_plan \u8FD4\u56DE\u7684 cache_hints \u643A\u5E26\u5386\u53F2\u5B8C\u6210\u4EFB\u52A1\u7684 result \u4E0E anchors\uFF08\u76F8\u4F3C\u5EA6 >=90%\uFF09\u3002\u80FD\u590D\u7528\u5C31\u76F4\u63A5\u590D\u7528\uFF0C\u6216\u53EA\u6D3E\u589E\u91CF\u4EFB\u52A1\uFF0C\u4E0D\u8981\u91CD\u590D\u9020\u8F6E\u5B50\u3002

12. **\u3010\u52A8\u6001\u62C6\u5206\u4E0E\u9632\u963B\u585E\u534F\u8BAE\u3011\u2014\u2014Worker \u7684\u81EA\u6211\u8BC4\u4F30\u547C\u6551 + Lead \u7684\u5F3A\u5236\u62C6\u5206\u3002**
    \u8C03\u5EA6\u5668\u6700\u6015\u7684\u4E0D\u662F\u4EFB\u52A1\u5931\u8D25\uFF0C\u800C\u662F**\u4E00\u4E2A\u4EFB\u52A1\u95F7\u5934\u5360\u7740 slot \u628A\u6574\u6761\u4F9D\u8D56\u94FE\u62D6\u6B7B**\u3002\u89E3\u8026\u529E\u6CD5\u662F\u8BA9 Worker \u81EA\u5DF1\u8BA4\u8F93\uFF0C\u8BA9 Lead \u88AB\u8FEB\u91CD\u62C6\u3002

    **\u5BF9 Worker \u7684\u5F3A\u5236\u7EA6\u675F\uFF08\u5199\u8FDB\u6D3E\u53D1\u6D88\u606F\uFF09\uFF1A**
    \u8C03\u7528 swarm_start \u4E4B\u540E\uFF0C\u4E00\u65E6\u53D1\u73B0\u4E0B\u9762\u4EFB\u610F\u4E00\u6761\uFF0C**\u4E25\u7981\u6B7B\u78D5**\uFF1A
    - \u9700\u8981\u4FEE\u6539\u7684\u6587\u4EF6\u8D85\u8FC7 3 \u4E2A\uFF1B
    - \u9884\u8BA1\u4EE3\u7801\u903B\u8F91\u8D85\u8FC7 200 \u884C\uFF1B
    - \u8FDE\u7EED\u4FEE\u590D\u7F16\u8BD1\u9519\u8BEF\u6216\u6D4B\u8BD5\u5931\u8D25\u8FBE\u5230 2 \u6B21\u4ECD\u7136\u4E0D\u8FC7\u3002
    \u6B64\u65F6\u7ACB\u523B\u8C03\u7528 swarm_escalate\uFF08\u53C2\u6570 task_id / agent_id / reason\uFF09\uFF0Creason \u5199\u6210 "Task too large, needs decomposition" \u5E76\u9644\u4E0A\u5F53\u524D\u62A5\u9519\u539F\u6587\uFF0C\u7136\u540E**\u505C\u6B62\u5DE5\u4F5C\u3001\u4FDD\u6301\u9759\u9ED8**\u2014\u2014\u4E0D\u8981\u518D\u6539\u6587\u4EF6\u3001\u4E0D\u8981 send_message\u3001\u4E0D\u8981\u8BD5\u56FE\u300C\u518D\u8BD5\u6700\u540E\u4E00\u6B21\u300D\u3002

    **\u5BF9 Lead \u7684\u5F3A\u5236\u7EA6\u675F\uFF1A**
    \u5728 swarm_status \u91CC\u770B\u5230 blocked \u4E14 reason \u542B "Task too large" \u7684\u4EFB\u52A1\u65F6\uFF0C**\u7981\u6B62\u539F\u6837\u91CD\u6D3E**\uFF08\u91CD\u65B0 swarm_start \u6216 release \u8BA9\u5B83\u88AB\u539F\u6837\u9886\u8D70\u90FD\u7B97\u8FDD\u89C4\uFF09\u3002\u5FC5\u987B\uFF1A
    - \u7528 swarm_plan \u628A\u5B83\u62C6\u6210 **2-4 \u4E2A\u66F4\u5C0F\u7684\u4EFB\u52A1**\uFF08\u6BCF\u4E2A\u90FD\u80FD\u72EC\u7ACB\u9A8C\u6536\u3001\u5199\u8303\u56F4\u4E92\u4E0D\u91CD\u53E0\uFF09\uFF1B
    - \u7528 blocked_by \u628A\u62C6\u51FA\u6765\u7684\u4EFB\u52A1\u4E0E\u539F\u4EFB\u52A1\u7684\u524D\u7F6E\u4F9D\u8D56\u63A5\u597D\uFF1B
    - \u539F\u4EFB\u52A1\u6807\u8BB0\u4E3A\u4E0D\u518D\u4F7F\u7528\uFF08\u6216\u4F5C\u4E3A\u6C47\u603B\u8282\u70B9\uFF09\uFF0C\u518D\u5524\u9192\u7A7A\u95F2 Worker \u53BB\u9886\u65B0\u4EFB\u52A1\u3002
    \u62C6\u5206\u65F6\u6CE8\u610F\uFF1A\u65B0\u4EFB\u52A1\u5404\u81EA\u7684 write_scopes \u5FC5\u987B\u4E92\u4E0D\u91CD\u53E0\uFF0C\u5426\u5219\u5B83\u4EEC\u4F1A\u4E92\u76F8 scope_conflict\u3002

    **\u914D\u5957\u7684\u8D85\u65F6\u9AD8\u4EAE**\uFF1Aswarm_plan \u652F\u6301\u7ED9\u4EFB\u52A1\u8BBE max_duration_ms\uFF08\u6BEB\u79D2\uFF0C0 = \u4E0D\u9650\uFF09\u3002swarm_status \u4F1A\u5BF9\u8FD0\u884C\u8D85\u8FC7\u8BE5\u9884\u7B97\u7684 running \u4EFB\u52A1\u5728\u884C\u5C3E\u6807 [OVERDUE]\u3002OVERDUE \u4E0E STALE \u4E0D\u540C\u2014\u2014STALE \u95EE\u300C\u4EBA\u8FD8\u5728\u5417\u300D\uFF0COVERDUE \u95EE\u300C\u662F\u4E0D\u662F\u6BD4\u9884\u671F\u4E45\u592A\u591A\u4E86\u300D\uFF0C\u5FC3\u8DF3\u6B63\u5E38\u7684\u4EFB\u52A1\u4E5F\u53EF\u80FD OVERDUE\u3002\u770B\u5230 OVERDUE \u8BF4\u660E\u8BE5\u62C6\u3001\u8BE5\u5EF6\u957F\u9884\u7B97\u3001\u6216\u8BE5\u6253\u65AD\uFF0C\u800C\u4E0D\u662F\u7B49\u5B83\u81EA\u5DF1\u7ED3\u675F\u3002

13. **\u3010\u8D1F\u8F7D\u5747\u8861\u4E0E\u5F3A\u5236\u5524\u9192\u94C1\u5F8B\u3011\u3002**
    \u8FD9\u662F Lead \u7684\u5355\u70B9\u6545\u969C\u9632\u7EBF\uFF1A\u591A Agent \u5E76\u884C\u7684\u610F\u4E49\u662F**\u5E76\u884C**\uFF1B\u628A\u4E00\u4E2A Worker \u585E\u6EE1\u3001\u8BA9\u5176\u4ED6 Worker \u5168\u7A0B inactive\uFF0C\u7B49\u4E8E\u628A\u8C03\u5EA6\u5668\u9000\u5316\u56DE\u5355\u7EBF\u7A0B\u3002
    1. \u4F5C\u4E3A Lead\uFF0C\u5728\u901A\u8FC7 swarm_plan \u5EFA\u6C60\u540E\uFF0C\u6216\u8005\u6C60\u5B50\u4E2D\u6709\u65B0\u7684 ready \u4EFB\u52A1\u65F6\uFF0C\u4F60\u4E25\u7981\u76F4\u63A5\u653E\u4EFB\u4E0D\u7BA1\u3002
    2. \u5FC5\u987B\u8C03\u7528 list_agents \u68C0\u67E5\u5F53\u524D\u6240\u6709 Worker \u7684\u72B6\u6001\u3002
    3. \u53EA\u8981\u6709\u5904\u4E8E inactive \u72B6\u6001\u7684 Worker\uFF0C\u4E14\u6C60\u4E2D\u6709 ready \u4EFB\u52A1\uFF0C\u4F60**\u5FC5\u987B\u7ACB\u523B\u8C03\u7528 send_message \u5524\u9192\u5B83\u4EEC**\uFF0C\u8BA9\u5B83\u4EEC\u53BB swarm_ready \u9886\u4EFB\u52A1\u3002
    4. \u4E25\u7981\u5C06\u591A\u4E2A\u4EFB\u52A1\u8FDE\u7EED\u6D3E\u7ED9\u540C\u4E00\u4E2A Worker\u3002\u5982\u679C\u4E00\u4E2A Worker \u6B63\u5728 running\uFF0C\u800C\u6C60\u5B50\u91CC\u8FD8\u6709 ready \u4EFB\u52A1\uFF0C\u4F60\u5FC5\u987B\u628A\u5B83\u6D3E\u7ED9\u4E0B\u4E00\u4E2A inactive \u7684 Worker\u3002
    5. \u5982\u679C\u4F60\u53D1\u73B0\u5524\u9192\u4E86 Worker\uFF0C\u4F46\u5B83\u4EEC\u6CA1\u6709\u9886\u5230\u4EFB\u52A1\uFF08\u56E0\u4E3A\u80FD\u529B\u4E0D\u5339\u914D\u88AB\u62D2\uFF09\uFF0C\u8BF7\u7ACB\u523B\u68C0\u67E5 worker_profiles \u914D\u7F6E\uFF0C\u6216\u8005\u8C03\u6574\u4EFB\u52A1\u7684 required_capabilities\u3002

14. **\u3010Whisper \u4FE1\u7BB1\u3011\u2014\u2014\u4E0D\u6253\u65AD\u7684\u8C03\u5EA6\u901A\u9053\u3002**
    - \u60F3\u7ED9\u67D0\u4E2A Worker \u8FFD\u52A0\u6307\u793A\u3001\u53C8\u4E0D\u60F3\u6253\u65AD\u5B83\u5F53\u524D\u8F6E\u6B21\u65F6\uFF0C\u7528 swarm_whisper(worker_id, message, from) \u628A\u8BDD\u5199\u8FDB\u6C60\u5B50\u7684 inbox/<worker_id>.json\uFF0C\u800C\u4E0D\u662F send_message\u3002\u4E00\u6761 whisper \u2264 1000 \u5B57\u7B26\uFF1A\u5B83\u662F\u300C\u4E0B\u6B21\u5F00\u5DE5\u5148\u770B\u4E00\u773C\u300D\uFF0C\u4E0D\u662F\u7B2C\u4E8C\u4EFD\u4EFB\u52A1\u4E66\u3002
    - Worker **\u6BCF 3 \u6B65\uFF08\u4EE5\u53CA\u6BCF\u4E2A\u4EFB\u52A1\u5F00\u59CB\u524D\u540E\uFF09\u8C03\u4E00\u6B21 swarm_inbox(worker_id)** \u68C0\u67E5\u4FE1\u7BB1\u3002\u5B83\u662F **ack \u8BED\u4E49**\uFF1A\u8BFB\u4E00\u6B21\u5373\u6E05\u7A7A\uFF0C\u7B2C\u4E8C\u6B21\u8BFB\u53EA\u4F1A\u8FD4\u56DE\u65B0\u5199\u5165\u7684\u90A3\u6279\uFF1B\u4E0D\u8981\u628A\u91CD\u590D\u8BFB\u53D6\u5F53\u6210\u786E\u8BA4\u3002
    - \u9700\u8981**\u7ACB\u523B\u5524\u9192\u3001\u6539\u6D3E\u6216\u4E2D\u65AD**\uFF0C\u4ECD\u7136\u7528 send_message\uFF1Bwhisper \u53EA\u5728\u300C\u4E0D\u8BE5\u53EB\u9192\u7684\u65F6\u5019\u300D\u4F7F\u7528\u3002

15. **\u3010\u63D0\u4EA4\u89C4\u8303\u3011\u2014\u2014\u4EA7\u7269\u843D\u76D8\uFF0C\u6458\u8981 10 \u5B57\u3002**
    - **\u4E25\u7981\u7528 send_message \u53D1\u9001\u957F\u4EE3\u7801\u6216\u957F\u62A5\u544A**\uFF1A\u4EE3\u7801\u548C\u6587\u6863\u5199\u8FDB\u4ED3\u5E93\u6587\u4EF6\uFF0C\u7ED3\u8BBA\u5199\u8FDB swarm_complete(result=...)\uFF0C\u22644000 \u5B57\u7B26\uFF0C\u7406\u60F3\u662F 10 \u5B57\u5DE6\u53F3\u7684\u4E00\u53E5\u8BDD + \u5173\u952E\u8DEF\u5F84\u3002
    - \u8C03\u7528 swarm_complete \u65F6\u9644 **2-3 \u4E2A anchors**\uFF08\u4F8B\u5982 dsh-swarm-scheduler/src/core/task-store.ts:claimTask\uFF09\uFF1A\u951A\u70B9\u5FC5\u987B\u662F\u80FD\u88AB swarm_recall \u547D\u4E2D\u7684\u6301\u4E45\u5B9A\u4F4D\u7B26\uFF0C\u4E0D\u80FD\u662F\u300C\u5DF2\u5B8C\u6210\u300D\u8FD9\u7C7B\u63CF\u8FF0\u3002\u5199\u4EFB\u52A1\u524D\u5148 swarm_recall(\u951A\u70B9/\u5173\u952E\u8BCD)\uFF0C\u522B\u91CD\u590D\u89E3\u51B3\u522B\u4EBA\u5DF2\u7ECF\u89E3\u51B3\u8FC7\u7684\u95EE\u9898\u3002
    - \u957F\u4EA4\u63A5\uFF08\u8868\u683C\u3001\u6743\u8861\u3001\u88AB\u5426\u6389\u7684\u65B9\u6848\uFF09\u653E\u8FDB\u4ED3\u5E93\u91CC\u7684 handoff \u6587\u4EF6\uFF0C\u5E76\u5728 result \u91CC\u5199\u5B83\u7684\u8DEF\u5F84\u3002

16. **\u3010\u6D3E\u53D1\u4E0E\u77E5\u8BC6\u8FB9\u754C\u3011\u3002**
    - \u6D3E\u53D1\u6D88\u606F**\u4E0D\u5E26\u4E3B\u4F1A\u8BDD\u5386\u53F2**\uFF1AWorker \u770B\u4E0D\u5230\u4F60\u8FD9\u4E00\u8F6E\u7684\u4E0A\u4E0B\u6587\uFF0C\u6240\u4EE5\u6D88\u606F\u5FC5\u987B\u81EA\u5305\u542B\uFF08\u4EFB\u52A1 id\u3001\u5199\u8303\u56F4\u3001\u9A8C\u6536\u547D\u4EE4\u3001\u4F9D\u8D56\u5173\u7CFB\uFF09\u3002
    - Worker \u4E0D\u786E\u5B9A\u67D0\u4E2A API/\u5B57\u6BB5\u5B58\u4E0D\u5B58\u5728\u65F6\uFF0C**\u76F4\u63A5\u8BFB\u6E90\u7801**\uFF08src/core/*.ts \u4E0E\u5DE5\u5177\u5B9A\u4E49\uFF09\uFF0C\u4E0D\u8981\u731C\uFF1B\u731C\u51FA\u6765\u7684\u5B57\u6BB5\u4F1A\u8BA9 tsc \u6216\u6D4B\u8BD5\u53D8\u7EA2\u3002
    - **\u4E0D\u5B58\u5728\u4EFB\u4F55\u81EA\u52A8\u6A21\u578B\u964D\u7EA7/\u81EA\u52A8\u6362\u6A21\u578B**\uFF1A\u8C03\u5EA6\u5668\u4E0D\u8BA4\u8BC6 provider\uFF0C\u4E5F\u4E0D\u4F1A\u81EA\u4F5C\u4E3B\u5F20\u6362\u6A21\u578B\u3002swarm_status \u884C\u5C3E\u7684 [ROUTING] Task X on <model|inherit> \u53EA\u662F**\u8BB0\u5F55**\uFF1B\u540C\u4E00\u4EFB\u52A1\u8FDE\u7EED\u5931\u8D25\u4E24\u6B21\u4F1A\u7F6E needs_upgrade=true\uFF0C\u800C\u300C\u6362\u6210\u4E00\u4E2A\u66F4\u5F3A\u7684\u6A21\u578B/Worker\u300D\u662F **Lead \u552F\u4E00\u5141\u8BB8\u7684\u66FF\u6362\u52A8\u4F5C**\uFF0C\u5FC5\u987B\u7531\u4F60\u663E\u5F0F\u6267\u884C\u2014\u2014\u5B83\u7EDD\u4E0D\u4F1A\u81EA\u52A8\u53D1\u751F\u3002

17. **\u3010\u4EE3\u7801\u6D01\u51C0\u4E0E\u65E0\u6CE8\u91CA\u7EA2\u7EBF\u3011\u3002**
    \u8FD9\u662F\u786C\u95E8\u7981\uFF08\u914D\u7F6E\u9879 forbid_inline_comments\uFF0C\u9ED8\u8BA4\u5F00\u542F\uFF09\uFF1A\u6BCF\u6B21\u6210\u529F\u5B8C\u6210\u4F1A\u5BA1\u8BA1 write_scopes \u5185**\u65B0\u589E**\u7684\u884C\uFF0C\u65B0\u589E\u884C\u5185\u6CE8\u91CA\u8FBE\u5230 2 \u884C\u5373\u6253\u56DE blocked\u3002
    - \u4E25\u7981\u89E3\u91CA\u6027/\u8FA9\u89E3\u6027\u884C\u5185\u6CE8\u91CA\uFF1A\u300C// TODO\u300D\u300C// \u6682\u65F6\u8FD9\u6837\u300D\u300C// \u8FD9\u91CC\u53EF\u80FD\u6709\u95EE\u9898\u300D\u4E00\u5F8B\u4E0D\u5141\u8BB8\u3002\u6CE8\u91CA\u65E0\u6CD5\u88AB\u6267\u884C\uFF0C\u56E0\u6B64\u65E0\u6CD5\u88AB\u9A8C\u8BC1\u2014\u2014**\u65E0\u6CD5\u88AB\u6267\u884C\u7684\u6CE8\u91CA\uFF0C\u5C31\u662F\u672A\u88AB\u9A8C\u8BC1\u7684\u8C0E\u8A00\u3002**
    - \u4EE3\u7801\u5FC5\u987B\u81EA\u89E3\u91CA\uFF1A\u547D\u540D\u4E0E\u7ED3\u6784\u80FD\u8868\u8FBE\u6E05\u695A\u7684\uFF0C\u5C31\u4E0D\u8981\u5199\u6CE8\u91CA\uFF1B\u8BBE\u8BA1\u610F\u56FE\u5FC5\u987B\u5199\u8FDB swarm_complete \u7684 anchors\uFF0C\u4E0D\u5F97\u5199\u8FDB\u4EE3\u7801\u6587\u4EF6\u3002
    - \u53EA\u5141\u8BB8\u51FD\u6570\u7EA7\u6807\u51C6 JSDoc \u7B7E\u540D\uFF08/** ... */\uFF09\uFF0C\u4E0D\u5F97\u7528\u5B83\u5199\u5B9E\u73B0\u8BF4\u660E\u3001\u53D8\u66F4\u65E5\u5FD7\u6216\u8FA9\u89E3\u3002
    - \u5982\u679C\u4F60\u53D1\u73B0\u9700\u8981\u957F\u6CE8\u91CA\u624D\u80FD\u770B\u61C2\uFF0C\u8BF4\u660E\u4EFB\u52A1\u8FC7\u5927\u6216\u62C6\u89E3\u4E0D\u5F7B\u5E95\uFF1A\u7ACB\u5373 swarm_escalate \u9000\u56DE\u5E76\u8BF4\u660E\u539F\u56E0\uFF0C\u4E0D\u8981\u7528\u6CE8\u91CA\u63A9\u76D6\u590D\u6742\u5EA6\u3002

18. **\u3010\u8D1F\u8F7D\u5747\u8861\u94C1\u5F8B\u3011\uFF08v1.7.0\uFF09\u3002**
    - **\u4E00\u4E2A Worker \u540C\u65F6\u53EA\u80FD\u8DD1\u4E00\u4E2A\u4EFB\u52A1**\uFF1A\u540C\u4E00 worker \u5DF2\u6709 running \u4EFB\u52A1\u65F6\uFF0Cswarm_claim \u4F1A\u62D2\u7EDD\uFF08worker_busy\uFF09\uFF1Bclaimed \u53EA\u662F\u9884\u5360\uFF0C\u4E0D\u7B97\u5FD9\u3002\u8981\u5E76\u884C\u66F4\u591A\u4EFB\u52A1\uFF0C\u5C31\u5524\u9192\u66F4\u591A Worker\uFF0C\u800C\u4E0D\u662F\u628A\u4EFB\u52A1\u5806\u7ED9\u4E00\u4E2A Worker\u3002
    - **\u6709 ready \u4E14\u6709\u53EF\u7528 Worker \u5FC5\u987B\u5524\u9192**\uFF1Aswarm_status \u672B\u5C3E\u51FA\u73B0 [WARNING] Idle workers available \u65F6\uFF0C\u8BF4\u660E\u6C60\u5B50\u91CC\u6709\u5C31\u7EEA\u4EFB\u52A1\u5374\u65E0\u4EBA\u5DE5\u4F5C\u2014\u2014\u7ACB\u523B list_agents \u5E76\u7528 swarm_dispatch \u5524\u9192\u7A7A\u95F2 Worker\u3002
    - **low \u4F18\u5148 standard**\uFF1A\u4F4E\u590D\u6742\u5EA6\u4EFB\u52A1\u4F18\u5148\u6D3E\u7ED9\u6807\u51C6\u7684\u5FEB\u901F Worker\uFF1Bpremium Worker \u53EA\u6709\u5728\u6CA1\u6709\u5177\u5907\u53EF\u7528\u8BB0\u5F55\u7684 standard Worker \u65F6\u624D\u4F1A\u9886\u5230 low \u4EFB\u52A1\u3002\u9AD8\u590D\u6742\u5EA6\u4EFB\u52A1\u53CD\u8FC7\u6765\u4F18\u5148\u6210\u529F\u7387\u6700\u9AD8\u7684 Worker\u3002

19. **\u3010\u4E0A\u4E0B\u6587\u5265\u79BB\u7EA2\u7EBF\u3011\uFF08v1.7.0\uFF09\u3002**
    - **\u4E25\u7981\u628A\u9700\u6C42\u957F\u6587\u585E\u7ED9 Worker**\uFF1A\u9700\u6C42\u3001\u9A8C\u6536\u6807\u51C6\u3001\u80CC\u666F\u5168\u90E8\u5199\u8FDB swarm_plan \u7684 description\uFF1B\u6D3E\u53D1\u6D88\u606F\u53EA\u5199\u300C\u505A\u4EC0\u4E48 + \u53BB\u54EA\u91CC\u8BFB\u300D\u3002
    - **\u6D3E\u53D1\u53EA\u8D70 swarm_dispatch**\uFF1A\u5B83\u628A\u6D88\u606F\u5199\u8FDB Worker \u4FE1\u7BB1\uFF0C\u8D85\u8FC7 500 \u5B57\u7B26\u81EA\u52A8\u622A\u65AD\u5E76\u8FFD\u52A0 [SYSTEM] \u622A\u65AD\u63D0\u793A\uFF0CWorker \u5FC5\u987B\u56DE\u4EFB\u52A1\u6C60\u8BFB description \u83B7\u5F97\u5B8C\u6574\u4E0A\u4E0B\u6587\u3002\u4E0D\u8981\u7528 send_message \u53D1\u9001\u957F\u9700\u6C42\u3002
    - **\u4E0A\u4E0B\u6587\u5C31\u662F\u6210\u672C**\uFF1A\u540C\u4E00\u4EFD\u9700\u6C42\u51FA\u73B0\u5728 Lead \u4F1A\u8BDD\u3001\u6D3E\u53D1\u6D88\u606F\u548C Worker \u4E0A\u4E0B\u6587\u91CC\u4E09\u904D\uFF0C\u5C31\u662F\u4E09\u500D Token\uFF1B\u7269\u7406\u9694\u79BB\uFF08\u4FE1\u7BB1 + \u4EFB\u52A1\u6C60\uFF09\u53EA\u8BA9\u9700\u6C42\u5B58\u5728\u4E00\u4EFD\u3002

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
      quality_gate_command: config.quality_gate_command ?? "",
      forbid_inline_comments: config.forbid_inline_comments ?? true,
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
  ConcurrencyLimiter,
  Config,
  DEFAULT_MAX_CONCURRENT,
  FetchTimeoutError,
  add,
  apply,
  fetchWithTimeout,
  inject,
  name,
  sharedLimiterFor,
  subtract,
  withConcurrencyLimit
};
//# sourceMappingURL=index.js.map