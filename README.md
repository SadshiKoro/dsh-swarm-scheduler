# dsh-swarm-scheduler

A production-ready, event-driven parallel coding scheduler for DSH.

[![CI](https://img.shields.io/badge/CI-passing-brightgreen)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
[![Tests](https://img.shields.io/badge/Tests-193%20passing-brightgreen)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
[![Version](https://img.shields.io/badge/Version-1.4.0-blue)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
[![License](https://img.shields.io/badge/License-MIT-blue)](https://github.com/SadshiKoro/dsh-swarm-scheduler)

## Overview

`dsh-swarm-scheduler` turns a single-threaded DSH agent into a multi-session parallel coding
operation. A Lead session decomposes a large request into a task pool on disk, and multiple Worker
sessions pull work from that pool concurrently.

Three properties make the parallelism safe rather than merely fast:

- **Work finds workers.** Workers poll a ready list instead of being hand-assigned, so a slow
  session never becomes a bottleneck and a failed assignment never orphans a task.
- **Conflicts are refused, not negotiated.** Declared write scopes are compared on claim; two tasks
  that would edit the same directory cannot both be held.
- **The pool heals itself.** Abandoned claims are released, silent workers are flagged before they
  are killed, and a worker that cannot finish escalates instead of writing code it knows is wrong.

Version 1.4.0 is the current production release: the six-state lifecycle, routing gates, watchdog,
conflict checks, and the quality gate are covered by 193 automated tests, including a 400-claim
concurrency stress with zero observed double-claims. v1.1.0 added the **quality gate** — a deployment
can make "done" a checked fact rather than a worker's claim — and a reproducible **benchmark** that
measures capability routing against blind round-robin; v1.2.0 added the anti-blockage protocol.
**v1.4.0 adds the isolation and knowledge layer**: high-complexity work runs in a linked git worktree
whose merge conflict blocks the task instead of damaging the main checkout, a task token budget that
trips a circuit breaker, `needs_upgrade` escalation when a recorded model keeps failing, a
non-interrupting **whisper inbox**, and **anchor recall** for finding earlier work. It also states,
explicitly, the property the feature set was built to keep: **there is no hidden model downgrade —
model control belongs to the developer.**

## What's new in 1.4.0

- **Worktree isolation and blocked merges.** A `high`-complexity claim creates a detached linked
  worktree under `<tasksRoot>/.dsh-tasks/workspaces/<task_id>` and records its path in the task. Work happens
  there; `swarm_complete` commits it on a temporary branch and merges it back with `git merge --no-ff`.
  A conflict aborts the merge in the **main** worktree and records the task as `blocked` (`Merge
  conflict`) — the main checkout's HEAD is left exactly where it was, and "completed" is never a lie.
  Releases, escalations, reaps and failed claims all remove the checkout they abandon.
- **Budget circuit breaker.** `max_budget_tokens` caps a task's tokens **across attempts**
  (`tokens_used`). A success that would push the total past the ceiling is recorded as `blocked`
  (`Budget exceeded`) rather than completed. Exactly at the ceiling is allowed — the comparison is
  strictly greater. A failed attempt keeps its own retry accounting and is never rewritten as a
  budget block.
- **`needs_upgrade` escalation.** A task may record the `model` assigned to it. Two consecutive
  failures on a task that has a model set `needs_upgrade: true`; a success resets the streak but does
  **not** clear the flag. The flag is advisory: it tells the Lead the assignment should be replaced.
  It never changes the six-state machine and it never swaps a model by itself.
- **Whisper inbox.** `swarm_whisper` writes one short instruction (≤ 1000 chars) into
  `.dsh-tasks/inbox/<worker_id>.json`; the worker drains it with `swarm_inbox`, ideally every three
  steps and around each task. Delivery is durable — a whisper survives a busy, idle, or not-yet-spawned
  worker — and reading is an **ack**: the file is renamed away first, so a second call returns only the
  next batch, and a concurrent append is not lost. Use `send_message` when you need a turn to start;
  use a whisper when you do not.
- **Anchors and recall.** `swarm_plan` accepts `anchors` and `swarm_complete` attaches them; an anchor
  is a durable pointer such as `src/core/task-store.ts:claimTask`, not a summary. `swarm_recall`
  searches anchors, titles, descriptions and results (case-insensitive substring), ranks anchor hits
  above title, description and result hits, breaks ties by task id, and reports which field matched.
- **No hidden model downgrade.** The scheduler has no provider and no fallback. `model` is a recorded
  assignment; `swarm_status` renders it as `[ROUTING] Task … on <model|inherit>` and will not choose,
  swap, or silently downgrade one. "Model control belongs to the developer" is a guarantee enforced by
  the absence of such a code path, not by configuration.

## Core Features

- **Six-state lifecycle** — `pending → claimed → running → completed`, with `failed` (retryable) and
  `blocked` (needs a human or re-plan). A task is ready only when every `blocked_by` entry is
  `completed`; readiness is re-derived from disk on every query, so no bookkeeping can drift.
- **Event-driven self-healing** — an `agent/status` transition to `idle` schedules a debounced
  (2-second) background sweep that reaps abandoned work. A two-phase STALE grace window flags a
  silent worker first and only fails it after an additional half-window, so a long read never kills
  a healthy task. `auto_reap: false` restores manual-only reaping.
- **Multi-dimensional worker routing** — hard gates on `tier` (`standard` / `premium`),
  `capabilities` tags, context window (`estimated_tokens` vs `max_context_tokens`), and cost budget
  (`max_cost_tokens`); each refusal carries its own error code. `cost_per_1k_tokens` is a soft
  scheduling reference only.
- **Dynamic reliability gating** — measured success/failure history from `worker_stats.json` refuses
  `high`-complexity tasks to workers with more than 3 failures and a failure rate above 50%. Low and
  medium tasks stay claimable, so a struggling worker can recover its record.
- **Strong conflict isolation** — `write_scopes` overlap (equal or ancestor paths) refuses a claim
  with `scope_conflict`; `required_hashes` pins prerequisite files to sha256 digests and refuses a
  stale one with `hash_mismatch`.
- **Escalation protocol** — `swarm_escalate` hands a task back as `blocked` with a reason instead of
  waiting for a timeout or shipping known-bad code. The tool replies with an explicit stop instruction,
  so a worker that has just given up does not keep going. Since 1.4.0 there is a second, quieter
  channel: a **whisper** into a worker's inbox steers it without starting a turn.
- **Worktree isolation, with the main tree protected** — a `high`-complexity claim gets its own
  detached git worktree, and the merge back is `--no-ff`. A conflict aborts in the main worktree and
  blocks the task; the main HEAD is never left mid-merge. Isolation is best-effort: outside a git
  repository the claim still succeeds and simply keeps `workspace: ''`, which is the pre-1.4.0
  behaviour.
- **Task-level token budget** — `max_budget_tokens` (0 = unlimited) is checked against `tokens_used`,
  which accumulates across attempts. Crossing it on an otherwise-successful attempt records `blocked`
  with `Budget exceeded` instead of `completed`; the claim lock is dropped with it.
- **`needs_upgrade` from repeated failure** — two consecutive failed completions on a task with a
  recorded `model` set the advisory flag; a success resets the streak, and the flag itself stays until
  a person replaces the assignment. Nothing in the scheduler chooses or downgrades a model.
- **Anchors and recall** — anchors are durable `file:line`/symbol pointers recorded at plan or
  completion time; `swarm_recall` finds earlier work by anchor, title, description or result, with a
  deterministic ranking (anchor > title > description > result, ties by task id).
- **Anti-blockage: self-assessment and forced re-splitting** — the failure mode a scheduler fears is not
  a failed task but a task that quietly holds a slot and stalls its whole dependency chain. Workers are
  instructed to give up early — more than 3 files to touch, more than ~200 lines of logic, or two
  consecutive failed attempts at making build/tests pass — and escalate with
  `Task too large, needs decomposition` instead of grinding. A `blocked` task carrying that reason may
  **not** be re-dispatched as-is: the Lead must split it into 2–4 smaller tasks with dependencies wired
  before waking anyone.
- **Deadline highlighting** — a task may declare `max_duration_ms`. `swarm_status` marks a `running`
  task `[OVERDUE]` once it exceeds that budget. This is deliberately *not* a kill: nothing is
  reclaimed. `STALE` asks "is anyone alive?", `OVERDUE` asks "is this taking longer than planned?" — a
  perfectly heartbeating worker can be overdue, and only the Lead can decide whether to extend, split,
  or interrupt.
- **Quality gate** — a deployment may set `quality_gate_command`; every `success: true` completion then
  runs that command, and a **non-zero exit turns the completion into a failure** (`retry_count + 1`,
  with the command's output quoted into `failure_reason`). A worker saying "done" is a claim, not a
  decision. Off by default: an empty command changes nothing.
- **Explicit non-feature: no model control** — the scheduler knows nothing about providers and has no
  code path that selects, swaps, or downgrades a model. `model` is a recorded assignment, `needs_upgrade`
  is a signal, and replacing either is an explicit Lead action. Model control belongs to the developer.
- **Test coverage** — 193 automated tests, including a claim-lock stress suite of 400 concurrent
  claims (10 workers × 2 cases × 20 rounds) that produced zero double-claims, a cross-process
  case where two real OS processes race one lock file, and six real-git worktree cases covering
  create/merge/conflict/remove.

## Installation

### 1. Mount the Agent Teams profile bundle

The `agentTeams` service comes from `@deepseek-ai/dsh-experimental-agent-team-profile`. It is **not
part of any default profile bundle**, so it must be added explicitly to your profile's
`dsh.profile.bundles` list. Add the following entry alongside the existing bundles:

    "@deepseek-ai/dsh-experimental-agent-team-profile"

**Do not add it to `dependencies`.** These packages ship inside the application bundle (`app.asar`),
exactly like the official `@deepseek-ai/dsh-base`, and are not resolvable from npm — listing them as
dependencies makes `pnpm install` fail. The bundle list is the correct and only place for it.

**Side effect (expect it).** This bundle disables the built-in subagent tool family — `subagent`,
`subagent_fork`, `list_agents`, and `interrupt_agent` — and replaces it with the Team versions
(`spawn_teammate`, `send_message`, `team_task_*`, …). Any workflow built on the native subagent tools
must be revisited.

**Rolling back** requires removing the bundle from the profile's bundle list and restarting DSH.
Removing this plugin alone does **not** restore the native subagent tools: the bundle performs the
swap, and it is independent of the plugin.

### 2. Install the plugin

    dsh plugin --profile <your-profile> add link:/path/to/dsh-swarm-scheduler

A `file:` or `link:` entry in the profile's `dependencies`, plus the package name in
`dsh.profile.bundles`, is equivalent and supported.

### 3. Configure `tasksRoot` (required)

`tasksRoot` is where the task pool lives, and an **empty value is refused at activation**. In DSH
Desktop `process.cwd()` is the profile directory rather than the workspace being scheduled, so the
plugin no longer falls back to it: activation throws, the fiber reports `failed`, and the error names
the setting, the consequence, and the line to add. Nothing is written until `tasksRoot` resolves.

Give the plugin's entry a `config` block in the profile's `cordis.patch.yml`:

    - id: swarm-scheduler
      config:
        tasksRoot: 'C:/your/workspace/absolute/path'
        # optional: refuse a completion unless this command exits 0
        quality_gate_command: 'npm test && npx tsc --noEmit'

Use an **absolute path with forward slashes**. The pool is created as
`<tasksRoot>/.dsh-tasks/<task_id>.json`.

**`quality_gate_command` (optional, default off).** Leave it out and nothing changes. Set it and every
`success: true` completion first runs that command **in the workspace** (the directory containing the
pool, *not* `.dsh-tasks/`, and *not* the profile directory). A non-zero exit records the task as
`failed` — with `retry_count + 1` and the first 500 characters of the command's output in
`failure_reason` — exactly as if the worker had reported failure. Two consequences worth planning for:

- The gate judges the **whole workspace**, so a task can be failed by someone else's breakage. Run
  builds and tests locally before completing, and say which command you ran in your result.
- `success: false` never runs the gate: a worker that already admits failure does not need to be told.

Other settings, all optional: `staleAssignmentSec` (default 600, also the `swarm_status` STALE
threshold), `max_workers` (default 3 concurrent claimed + running tasks), `auto_reap` (default true),
`worker_tiers` (legacy id → tier map), and `worker_profiles` (per-worker capabilities, context window,
and cost rate).

### 4. Restart DSH

**There is no hot reload. Editing the config without restarting changes nothing.**

All four installation steps — bundle list, plugin install, `config`, and any later change to them —
require a full DSH restart to take effect. This is not a stylistic preference; it was established by
measurement. When `quality_gate_command` was removed from a running profile, the plugin kept *running
the deleted command* through every reload path available: re-creating the plugin fiber, unloading the
entry, and reinstalling the package all reported success while the old value stayed in memory. A task
that should have passed was still rejected by a gate command that no longer existed in any file on
disk. The value only changed after DSH itself restarted.

The same applies to `worker_profiles`. A capability change does not reach a teammate that is already
running — its profile is a snapshot taken when the session started. If a worker is refused with
`worker_lacks_capability` after you edited its profile, the fix is a restart, not another retry.

So: **edit `cordis.patch.yml`, then restart DSH.** Treat a config edit that has not been followed by a
restart as not applied.

## Quick Start

The minimal loop is three steps.

1. **Build the pool.** Call `swarm_plan` once with the whole decomposition. Four fields are required
   per task, and all four are plain strings: `task_id` (unique within the pool; convention is
   `<block>/<index>`, e.g. `big-1/small-2`), `big_task_id` (the block it belongs to — a label, not a
   foreign key), `title`, and `description` (state inputs, outputs and acceptance criteria so the
   worker does not have to guess). Dependencies are declared with `blocked_by`, a list of `task_id`s
   that must be `completed` before the task becomes ready. All other fields are optional:
   `write_scopes` (declare it whenever tasks could touch the same directory — see the conflict note
   below), the routing fields `complexity`, `required_worker_tier`, `required_capabilities`,
   `estimated_tokens`, `max_cost_tokens`, plus `max_duration_ms` (marks the task `[OVERDUE]` in
   `swarm_status` once a run exceeds it — a nudge, not a kill), `model` (the recorded assignment;
   informational, never a dispatch decision), `max_budget_tokens` (the task-wide token ceiling),
   `anchors` (2–3 durable `file:line`/symbol pointers for `swarm_recall`), `priority`, `required_files`
   and `required_hashes`. An existing `task_id` is never overwritten: a repeat plan reports it as a
   conflict, so re-running `swarm_plan` cannot silently reset finished work.
2. **Wake the workers.** Spawn teammates with `spawn_teammate`, or reuse idle ones with
   `send_message`, and point them at the pool. A worker's loop is `swarm_ready` → `swarm_claim` →
   `swarm_start` → execute → `swarm_complete`, repeated until `swarm_ready` returns zero. You never
   assign a specific task to a specific worker: which block each one gets is the outcome of an atomic
   claim race.
3. **Watch progress.** `swarm_status` reports the whole pool in a single call: per-state counts, how
   many tasks are ready, how many are still blocked, and one compact line per task.

### Automatic Dispatch

This plugin also installs a scheduling protocol as a **prompt section**. A Lead agent that receives a
large, multi-file request switches to dispatch mode on its own: it decomposes, plans the pool, wakes
workers, and reports progress, without being told to do so. The protocol coexists with normal work —
small tasks are executed directly.

## Tools Reference

| Tool | Purpose | Core parameters |
|---|---|---|
| `swarm_plan` | Create the task pool; one JSON file per task | `tasks[]`: `task_id`, `big_task_id`, `title`, `description`, `write_scopes`, `blocked_by`, `priority`, `complexity`, `required_worker_tier`, `required_capabilities`, `estimated_tokens`, `max_cost_tokens`, `max_duration_ms`, `model`, `max_budget_tokens`, `anchors`, `required_files`, `required_hashes` |
| `swarm_ready` | List tasks a worker can start right now | `big_task_id` (optional filter) |
| `swarm_claim` | Atomically claim one task for one worker; a `high`-complexity claim also returns an isolated `workspace` path | `task_id`, `claimed_by` |
| `swarm_start` | `claimed → running`; records start time and first heartbeat | `task_id`, `started_by` |
| `swarm_heartbeat` | Renew the lease on a held task | `task_id`, `agent_id` |
| `swarm_complete` | Record the outcome; `success=false` triggers retry logic; a configured quality gate can downgrade a success; a workspace merge conflict or an exceeded budget blocks it | `task_id`, `result`, `completed_by`, `success`, `actual_tokens`, `duration_ms`, `anchors` |
| `swarm_release` | Return a claimed task to the pool, clearing its lock and its worktree | `task_id`, `released_by` |
| `swarm_reap` | Watchdog sweep: release, flag STALE, or fail stale tasks (and remove their worktrees) | none |
| `swarm_escalate` | Hand a task back as `blocked` with a reason (Lead may force); replies with an explicit stop instruction | `task_id`, `agent_id`, `reason`, `force` |
| `swarm_set_deps` | Lead-only: replace a task's `blocked_by` list | `task_id`, `blocked_by[]`, `updated_by` |
| `swarm_status` | Report the whole pool and per-worker performance, with `[ROUTING]` and `[budget]` annotations | `include_log` |
| `swarm_whisper` | Leave an instruction in a worker's inbox without starting its turn (≤ 1000 chars) | `worker_id`, `message`, `from` |
| `swarm_inbox` | Drain a worker's inbox (ack semantics: reading clears the slot) | `worker_id` |
| `swarm_recall` | Find tasks by anchor, title, description or result (case-insensitive substring) | `query`, `limit` |

For refusal codes, routing gates, and transition rules in full, see `DESIGN.md`.

## Architecture

The codebase is split along one line: the core knows nothing about DSH, and exactly one file knows
about everything else.

- **`src/core/`** — the pure layer. It depends only on Node built-ins: the state machine, scope
  comparison, the atomic claim lock, the reaper, dependency resolution, hash verification, git
  worktree isolation (`workspace.ts`), the whisper inbox (`inbox.ts`), and anchor recall (`recall.ts`).
  It takes a filesystem slice as a parameter rather than reaching for a Cordis context, which is what
  makes it testable in a plain `node --test` process with no host and no temporary host state.
- **`src/tools-file.ts`** — the host adapter and the only module that knows about Cordis. It
  registers the fourteen tools and translates between tool arguments and core calls.
- **Storage** — a plain file pool at `.dsh-tasks/<task_id>.json`, guarded by an atomic lock per task.
  Per-worker whispers live in `.dsh-tasks/inbox/<worker_id>.json`, and isolated checkouts under
  `<tasksRoot>/.dsh-tasks/workspaces/`. There is no database, no daemon, and no in-memory state that can diverge
  from disk: a restart resumes from exactly what is on disk.

## Known Limitations

1. **Write-conflict detection is file/directory level, not AST level.** Two tasks that both declare
   `src/` are refused at claim time even if one edits `src/a.ts` and the other `src/b.ts`. There is no
   function-level analysis and no write interception — deliberately, because a false admission would
   silently overwrite a file. Declare the narrowest scope that is correct (`src/api/routes.ts`).
2. **Members cannot be deleted.** DSH's `agentTeams` exposes no delete API, so the roster only grows;
   it is cleared only when the Lead session ends. The protocol therefore prefers **reusing idle
   workers** over spawning new ones, and a long dispatch run can accumulate teammates.
3. **A Worker not listed in `worker_profiles` can never claim a task that requires capabilities.**
   Profiles are resolved **by agent id**. An unregistered id falls back to the default profile, whose
   capability list is empty — so every task carrying `required_capabilities` refuses that worker.
   Since 1.0.0 the refusal states the actual cause rather than a misleading "missing [x]": it reports
   that the worker is not registered in `worker_profiles` and has no default capabilities. **Register
   every Worker's id and capability tags before relying on capability routing**, or that entire class of
   work becomes unclaimable by anyone.
4. **Capability declarations are static and unverified.** `capabilities`, `max_context_tokens`, and
   `cost_per_1k_tokens` are hand-written deployment declarations. DSH provides no cross-session
   verification, so the plugin cannot check that a worker really has the skill it claims.
5. **Filesystem access degrades to `node:fs`.** When `ctx.fs` is refused by the sandbox, the plugin
   continues through `node:fs` and reports the degradation on later results. Lock semantics remain
   correct in stress testing, but the degraded path is the one with the least production mileage.
6. **Worktree isolation is git-only and best-effort.** It applies to `high`-complexity claims only
   (medium and low work runs in the main checkout). Outside a git repository, or when `git worktree
   add` fails, the claim still succeeds with `workspace: ''` — the pre-1.4.0 behaviour — so isolation
   is a safety improvement, not a hard guarantee. A merge conflict blocks the task and removes the
   checkout; resolving it needs a person or a fresh, smaller task, because the isolated attempt's
   changes are deliberately not forced onto the main tree.
7. **The budget breaker only fires at completion time.** `max_budget_tokens` cannot stop a run
   mid-flight: it is evaluated when `swarm_complete` arrives, so an attempt can overshoot the ceiling
   and only then be recorded as `blocked` (`Budget exceeded`). It is a checkpoint, not a kill switch.
8. **Whisper and recall are advisory file channels.** A whisper is not a task description: the
   inbox is capped at 1000 characters per message and drained on the worker's schedule, so a critical
   instruction still belongs in `send_message`. Recall is case-insensitive substring matching with no
   tokenizer or fuzzy distance — a deliberate refusal to guess — so imprecise anchors return nothing.
9. **`model` is recorded, never applied.** The scheduler cannot verify that a named model exists,
   cannot select one, and has no fallback path. Recording `model` affects only the `[ROUTING]`
   annotation; `needs_upgrade` only advises. Any actual substitution is an explicit action by the
   developer or the Lead.

## Testing

    npm test

`npm test` runs Node's built-in runner over `test/**/*.test.ts` and **already includes
`--test-isolation=none`**, which keeps it sandbox-safe: a per-file child process cannot capture piped
stdio in a confined environment and fails with `spawn EPERM`. Single-process execution avoids that
entirely. `npm run test:sandbox` is a retained alias for the same command.

The suite contains **193 tests** covering the six-state lifecycle, retry and blocked transitions,
scope admission, hash verification, routing refusals, the two-phase STALE window, the quality gate,
the token budget and `needs_upgrade` accounting, worktree create/merge/conflict/remove, the whisper
inbox and its ack semantics, anchor recall, and concurrent races. Six cases deserve note:

- `test/core/stress.test.ts` runs 10 workers against 50 tasks over 10 scopes and asserts every task
  is claimed exactly once and that no two overlapping scopes were ever held simultaneously.
- `test/core/stress-lock.test.ts` is the claim-lock evidence: 10 workers claiming the same task, and
  10 workers claiming ten different tasks that share one identical scope, 20 rounds each — asserting
  exactly one winner per round and zero double-claims overall.
- `test/core/concurrency.test.ts` adds the **cross-process** case: two real OS processes race one
  `openSync(path, 'wx')` lock file, five rounds, exactly one winner and one `EEXIST` each time — plus
  a later third process that must lose to the already-held lock.
- `test/core/workspace.test.ts` drives **real `git`** in temporary repositories: a detached linked
  worktree is created, edits are merged back with `--no-ff`, an unchanged workspace is a clean no-op,
  a conflict is reported while the main HEAD stays untouched, and removal is idempotent.
- `test/core/inbox.test.ts` pins delivery semantics: append keeps both whispers, drain is an ack (the
  second read returns the second batch), a concurrent append during a drain survives, an invalid or
  path-traversal worker id is refused, and a corrupt inbox file is consumed as empty rather than
  blocking the worker.
- `test/core/recall.test.ts` pins the ranking and the refusal to guess: anchor hits outrank title,
  title outranks description and result, ties are stable by task id, the limit is honoured, an empty
  query matches nothing, and matching is case-insensitive substring only.

Stress cases use a **wider clock budget on Windows** than on Linux/CI, because local filesystem
latency dominates their wall time. Every functional assertion is identical on all platforms; only the
time budget differs.

## Benchmark

Does capability routing actually pay for itself? [`benchmark/run.ts`](benchmark/run.ts) measures it
instead of asserting it: one fixed population, run twice — once with blind round-robin assignment,
once through the **production** `profileRefusal` gate. Every number below comes from
[`benchmark/RESULT.md`](benchmark/RESULT.md), which the script itself writes on each run.

The population is **20 tasks** (15 requiring `code`, 5 requiring `docs`) and **5 workers** (3 declaring
`code`, 2 declaring `docs`), with the task order shuffled by a fixed seed (`20261031`) so a run is
reproducible.

| Metric | Baseline (round-robin) | With routing |
|---|---:|---:|
| Tasks assigned | 20 | 20 |
| Successful | 11 | 20 |
| Wasted assignments | 9 | 0 |
| Success rate | **55.0%** | **100.0%** |
| Wasted rate | **45.0%** | **0%** |

Round-robin assigns by position, not by capability, so 45% of the pool lands on a worker that cannot
serve it — in a real run that costs a claim and a retry cycle each time. Routing sends none.

Run it yourself (no new dependency; Node strips the types):

    node --experimental-strip-types benchmark/run.ts

Two honest caveats, both recorded in `RESULT.md`:

- **100% is a property of this population, not a promise.** 3 code workers cover 15 code tasks and 2
  docs workers cover 5 docs tasks. A capability with no declaring worker yields `unassignable` tasks,
  which the script reports explicitly rather than counting as success.
- **Routing is invariant across seeds; baseline is not.** Re-running with
  `BENCH_SEED ∈ {1, 2, 7, 42, 20261031, 999999}` kept routing at 100% every time while baseline swung
  between 35% and 65%. That asymmetry is the point: routing converges, polling depends on luck.

### What this benchmark does *not* prove

The gate that produces 100% answers one question — *may this worker take this task?* It has no notion
of current load, so in the routing column the first accepting worker takes everything:
`worker-code-0` received all 15 code tasks while the other two code workers received **none**, and
`worker-docs-0` took all 5 docs tasks while `worker-docs-1` idled. Correctness and balance are two
different gains, and only the first is measured here:

| Gain | Proven | Source |
|---|---|---|
| **Correctness** — no task lands on a worker that cannot serve it | Yes (100% vs 55%) | `profileRefusal` capability gate |
| **Balance** — work spread evenly across idle workers | **No** — 15/0/0 and 5/0 | Not implemented |

In practice workers **pull** rather than being pushed, so whoever finishes first claims the next ready
task and the pool tends to level out on its own. But even distribution is *not* something the routing
gate provides; do not read the 100% as if it were.

## Contributing & License

Issues and pull requests are welcome. Before opening a PR:

- Run `npm test` and `npx tsc -p tsconfig.json --noEmit`; both must pass.
- Keep the core/host split intact: `src/core/` must not import `@deepseek-ai/*`.
- Add a test for every behaviour change. A fix without a failing-first test is a regression waiting
  to happen.
- Match the repository's TypeScript style: `strict`, `noUncheckedIndexedAccess`, NodeNext module
  resolution, and `.ts` extensions on relative imports.

Design rationale, refusal-code reference, and measured evidence live in `DESIGN.md`.

Released under the **MIT License**.
