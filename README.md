# dsh-swarm-scheduler

A production-ready, event-driven parallel coding scheduler for DSH.

[![CI](https://img.shields.io/badge/CI-passing-brightgreen)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
[![Tests](https://img.shields.io/badge/Tests-237%20passing-brightgreen)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
[![Version](https://img.shields.io/badge/Version-1.7.0-blue)](https://github.com/SadshiKoro/dsh-swarm-scheduler)
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

Version 1.7.0 is the current production release: the seven-state lifecycle, routing gates, watchdog,
conflict checks, the quality gate and the inline-comment red line are covered by 237 automated tests,
including a 400-claim concurrency stress with zero observed double-claims. v1.1.0 added the **quality
gate** — a deployment can make "done" a checked fact rather than a worker's claim — and a reproducible
**benchmark** that measures capability routing against blind round-robin; v1.2.0 added the anti-blockage
protocol.
**v1.4.0 adds the isolation and knowledge layer**: high-complexity work runs in a linked git worktree
whose merge conflict blocks the task instead of damaging the main checkout, a task token budget that
trips a circuit breaker, `needs_upgrade` escalation when a recorded model keeps failing, a
non-interrupting **whisper inbox**, and **anchor recall** for finding earlier work. It also states,
explicitly, the property the feature set was built to keep: **there is no hidden model downgrade —
model control belongs to the developer.**
**v1.5.0 adds the comment red line**: a completion that adds two or more inline comment lines is
blocked, because *无法被执行的注释，就是未被验证的谎言。* (a comment that cannot be executed is a lie
that was never verified). Design intent belongs in `anchors`, where `swarm_recall` can find it.
**v1.5.1 refines two edges**: write-scope overlap is now three-case (directory↔file is allowed, and
`src/` no longer matches `src2/`), and `swarm_inbox` delivers a `[SYSTEM]` budget warning the moment a
worker's held task is already over `max_budget_tokens`.
**v1.6.0 is the speed release**: a **task-result cache** turns completed work into advisory reuse hints,
**health-based routing** keeps proven-weak workers off high-complexity tasks, and **tiered gates**
(skip docs-only changes, defer the local gate with `pending_review` and run one global gate at the end)
remove the repeated CPU and waiting that dominated completion time. The safety mechanisms are
unchanged; the wins come from caching, routing and batching.
**v1.7.0 is the dispatch release**: one worker can hold only **one running task** (`worker_busy`),
`swarm_status` warns when the pool has ready work but nobody is running, low-complexity work prefers a
proven standard worker over premium, and the new **`swarm_dispatch`** tool physically isolates dispatch
context — long messages are clipped at 500 characters and the worker is told to read the task pool.
> **安全是为了保障交付，效率是调度器的生命线。** Security is what protects delivery; efficiency is
> the scheduler's lifeblood. Caching, routing and tiered gates buy throughput *without* lowering the
> bar.

## What's new in 1.7.0

- **One running task per worker (`worker_busy`).** `swarm_claim` scans the pool first: if the claiming
  worker already has a task with `status === 'running'`, the claim is refused with
  `worker_busy` and the task stays pending. A `claimed` reservation does **not** block — the guard is
  about execution, not booking. Parallelism comes from waking more workers, not from stacking tasks on
  one.
- **Idle-pool watermark.** When `swarm_status` sees `ready > 0` with zero claimed/running tasks and a
  non-empty `worker_profiles`, it appends the exact line
  `[WARNING] Idle workers available. Please send_message to wake them up.` The plugin cannot read DSH
  teammate state, so this is an approximation derived from the pool and the configured profiles — it
  is a prompt to dispatch, not telemetry.
- **Low-tier routing.** A `premium` worker claiming `low`-complexity work is refused
  (`worker_not_preferred`) when a configured standard worker has at least one recorded attempt and a
  success rate ≥ 50%; without such a candidate the premium worker keeps the job, so capacity is never
  stranded. High-complexity routing keeps its v1.6.0 health preference.
- **`swarm_dispatch(worker_id, message, task_id?)`.** The context-stripping red line made physical:
  the instruction is written to the worker's whisper inbox instead of a long conversation, requirement
  prose stays in the pool `description`, and a message past 500 characters is clipped with the exact
  `[SYSTEM] Message truncated to save tokens. Instruct the worker to read the task pool for full
  context.` notice. Passing `task_id` prepends the short standard instruction naming the task to pull.

## What's new in 1.6.0

- **Task-result cache (advisory).** `swarm_plan` compares each incoming task's title/description and
  `required_capabilities` against completed tasks (`0.6 × text Jaccard + 0.4 × capability Jaccard`)
  and reports a `cache_hint` — the earlier `result` and its `anchors` — at ≥ 90% similarity. The cache
  never reuses anything automatically: the Lead decides to reuse the result or dispatch only the
  delta. This is the cheapest token saving in the plugin: the work is not re-thought and not
  re-written.
- **Health-based routing.** `workerHealth` derives `{attempts, rate, avgMs}` from `worker_stats.json`.
  A worker with ≥ 3 attempts and a success rate below 50% is refused **high-complexity** claims when
  another worker has ≥ 2 attempts and a rate above 70% (`worker_not_preferred`, naming the healthier
  candidate) — retrying bad work costs more than choosing the better worker. Low/medium work stays
  open to that worker so it can recover, and `swarm_status` shows
  `[health: <rate>% · <avg>]` per worker.
- **Tiered gates.** A change confined to `.md`/`.mdx` files or the `test/`, `tests/`, `docs/` trees no
  longer runs the heavy quality gate (`gateNeededFor`). With `swarm_complete(..., skip_local_gate:
  true)` the local gate is deferred entirely: the task parks in the new `pending_review` state
  (seventh state — not claimable, not counted as done, does not satisfy dependencies), and the Lead
  runs the strict global gate once in the main workspace before finalising each task with
  `swarm_complete(..., reviewed: true)`.

## What's new in 1.5.1

- **Three-case scope overlap.** `scopesOverlap` decides by kind, not by string prefix: file↔file
  conflicts only on the identical normalized path, directory↔directory conflicts on the same or an
  ancestor directory (segment-aware, so `src/` never matches `src2/`), and directory↔file is allowed
  in either direction. Normalization still treats `src\api` and `./src/api/` as one scope. Residual
  risk: a directory task may still edit the file a file task holds — the claim is admitted, so
  granularity remains a promise, not an enforced lock.
- **Budget warning at inbox time.** `swarm_inbox` now looks for tasks held by that worker
  (`claimed`/`running`) whose `tokens_used` has reached `max_budget_tokens` and appends the exact
  system line `[SYSTEM] Budget limit exceeded. Stop working immediately and call swarm_complete with
  success: false.` The append happens before the read, so the warning is returned by the same drain.
  Residual risk: `tokens_used` accrues only when a completion is recorded, so this is a cross-attempt
  reminder, not live metering — the completion-time breaker remains the enforcement point.
- **Load-balancing clause in the dispatch protocol.** A new section right after the anti-blockage
  rules makes the Lead check `list_agents` after `swarm_plan` (and whenever new `ready` work appears),
  wake every `inactive` Worker with `send_message` while `ready` tasks exist, and stop piling tasks
  onto a single running Worker. When a woken Worker is refused for capability reasons, the fix is
  `worker_profiles` or the task's `required_capabilities`, not another retry.

## What's new in 1.5.0

- **Inline-comment red line (`forbid_inline_comments`, default on).** `swarm_complete` audits the
  task's declared `write_scopes` on every success claim: it diffs the isolated workspace against
  `HEAD` (`git diff --unified=0`), counts **only the added lines** that are inline comments (a line
  starting with `//`, or a trailing ` // ` not part of a `://` scheme), exempts JSDoc/block-comment
  lines, and counts untracked files in full. Two or more added comment lines block the task with
  `Too many inline comments. Code must be self-explanatory. Move your design intent to anchors, or
  escalate if the task is too complex.` The audit runs after the quality gate and before the budget
  check, while the isolated worktree still exists. Set `forbid_inline_comments: false` to opt out.
- **Design rationale, stated in the protocol.** The dispatch protocol now carries a four-part
  「代码洁净与无注释红线」 clause: no explanatory/defensive inline comments, self-explanatory code,
  design intent in `anchors` instead of source prose, JSDoc signatures only, and escalate rather than
  hide complexity behind a wall of comments.

## What's new in 1.4.1

- **A high-complexity claim without a worktree is now refused, not silently downgraded.**
  v1.4.0 treated a failed `git worktree add` as a warning and ran the task in the main checkout with
  `workspace: ''`. That made isolation a *best-effort* promise while the whole point is a hard one.
  `swarm_claim` now answers `REJECTED isolation_unavailable: Cannot claim high-complexity task.
  tasksRoot is not a git repository, Worktree isolation is unavailable.` and the task stays `pending`.
  Consequence for operators: to run `high` tasks, `tasksRoot` must be the git repository the work
  belongs to; point it at a parent directory and those claims will be refused by design.
- **No more phantom quality-gate note.** Blocked outcomes used to append "the quality gate command
  (`` ) did not pass" because any non-completed result was read as a gate failure. `completeTask`
  now returns `gate_failed`, and the note appears only when a gate actually ran and failed. Budget
  blocks and merge conflicts report their own reason and nothing else.

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
  blocks the task; the main HEAD is never left mid-merge. Since 1.4.1 isolation is **mandatory** for
  `high` work: if the worktree cannot be created (for example because `tasksRoot` is not a git
  repository), the claim is refused with `isolation_unavailable` and the task stays pending.
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
- **Load balancing and forced wake-up** — the protocol forbids serialising the pool through one Worker.
  After planning, and whenever new `ready` work appears, the Lead must call `list_agents`; any
  `inactive` Worker plus a `ready` task means an immediate `send_message` telling it to claim from
  `swarm_ready`. Tasks are not piled onto a Worker that is already running while another sits idle, and
  a capability refusal after a wake-up sends the Lead to `worker_profiles` / `required_capabilities`
  instead of a retry loop.
- **Task-result cache (v1.6.0)** — `swarm_plan` scores each new task against completed results
  (`0.6 × text Jaccard + 0.4 × capability Jaccard`) and emits a `cache_hint` (result + anchors) at
  ≥ 90% similarity. Reuse stays a Lead decision; the plugin never substitutes a cached result for the
  task record.
- **Health-based routing (v1.6.0)** — `workerHealth` records success rate and mean attempt duration.
  A proven-weak worker (≥ 3 attempts, rate < 50%) cannot claim `high` work while a proven-stronger
  worker exists (`worker_not_preferred`, naming the candidate); low/medium work remains open so the
  worker can recover. `swarm_status` renders `[health: <rate>% · <avg>]`.
- **Tiered gates (v1.6.0)** — documentation/test-only changes skip the heavy quality gate, and
  `skip_local_gate: true` parks a success in `pending_review` for one strict global gate at the end,
  finalised by `swarm_complete(..., reviewed: true)`. That removes repeated per-task CPU and model
  waiting without removing the check.
- **One running task per worker (v1.7.0)** — `worker_busy` refuses a second running claim for the same
  worker; `claimed` reservations do not block. Parallelism means waking more workers, not stacking
  tasks on one, and `swarm_status` warns when ready work sits beside an idle pool.
- **Low-tier routing (v1.7.0)** — premium workers are refused `low` work only when a configured
  standard worker has a proven record (≥ 1 attempt, ≥ 50% success); otherwise the job is allowed.
- **Context-stripping dispatch (v1.7.0)** — `swarm_dispatch` writes instructions to the worker inbox,
  clips messages past 500 characters with a `[SYSTEM]` notice, and keeps requirement prose in the pool
  `description` instead of duplicating it into the conversation.
- **Deadline highlighting** — a task may declare `max_duration_ms`. `swarm_status` marks a `running`
  task `[OVERDUE]` once it exceeds that budget. This is deliberately *not* a kill: nothing is
  reclaimed. `STALE` asks "is anyone alive?", `OVERDUE` asks "is this taking longer than planned?" — a
  perfectly heartbeating worker can be overdue, and only the Lead can decide whether to extend, split,
  or interrupt.
- **Quality gate** — a deployment may set `quality_gate_command`; every `success: true` completion then
  runs that command, and a **non-zero exit turns the completion into a failure** (`retry_count + 1`,
  with the command's output quoted into `failure_reason`). A worker saying "done" is a claim, not a
  decision. Off by default: an empty command changes nothing.
- **Inline-comment red line** — `forbid_inline_comments` (default on) audits the lines the worker added
  in its declared scopes: two or more new inline comment lines block the completion (`Too many inline
  comments…`) instead of completing it. JSDoc/block comments are exempt, untouched comments are not
  counted, and design intent belongs in `anchors` — a comment cannot be executed, so nothing can verify
  it is still true.
- **Explicit non-feature: no model control** — the scheduler knows nothing about providers and has no
  code path that selects, swaps, or downgrades a model. `model` is a recorded assignment, `needs_upgrade`
  is a signal, and replacing either is an explicit Lead action. Model control belongs to the developer.
- **Test coverage** — 203 automated tests, including a claim-lock stress suite of 400 concurrent
  claims (10 workers × 2 cases × 20 rounds) that produced zero double-claims, a cross-process
  case where two real OS processes race one lock file, six real-git worktree cases covering
  create/merge/conflict/remove, and the v1.5.0 comment-audit cases (diff, JSDoc exemption, untracked
  files, directory scopes).

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
        # optional: the inline-comment red line (default true)
        forbid_inline_comments: true

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

**`forbid_inline_comments` (optional, default on).** The v1.5.0 red line. Every `success: true`
completion audits the task's `write_scopes` for lines the worker **added**: a line starting with `//`,
or a trailing ` // ` (a `://` scheme is excluded), while JSDoc/block-comment lines are exempt. Two or
more added comment lines block the task; untracked files are counted in full. The audit reads the
isolated worktree before any merge, so it judges exactly the worker's own diff. Why the rule exists:
**无法被执行的注释，就是未被验证的谎言。** A comment cannot be executed, so nothing can catch it when it
becomes false. Put design intent in `anchors`, where `swarm_recall` can find it, not in the source.
Set `forbid_inline_comments: false` only for a repository whose style genuinely needs prose in code.

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

The protocol carries a **load-balancing and forced wake-up rule** (placed right after the anti-blockage
rules): after `swarm_plan`, and whenever new `ready` work appears, the Lead must call `list_agents`. If
any Worker is `inactive` while the pool has `ready` tasks, it **must** `send_message` that Worker and
have it claim from `swarm_ready`. Piling several tasks onto one running Worker while others sit idle is
forbidden — the next ready task goes to the next `inactive` Worker. If a woken Worker is then refused
for capability reasons, the Lead fixes `worker_profiles` (or the task's `required_capabilities`)
instead of retrying the same assignment.

## Tools Reference

| Tool | Purpose | Core parameters |
|---|---|---|
| `swarm_plan` | Create the task pool; one JSON file per task; returns advisory `cache_hints` (completed result + anchors) for ≥90% similar work | `tasks[]`: `task_id`, `big_task_id`, `title`, `description`, `write_scopes`, `blocked_by`, `priority`, `complexity`, `required_worker_tier`, `required_capabilities`, `estimated_tokens`, `max_cost_tokens`, `max_duration_ms`, `model`, `max_budget_tokens`, `anchors`, `required_files`, `required_hashes` |
| `swarm_ready` | List tasks a worker can start right now | `big_task_id` (optional filter) |
| `swarm_claim` | Atomically claim one task for one worker; a `high`-complexity claim also returns an isolated `workspace` path; refuses `worker_not_preferred` (health/low-tier routing) and `worker_busy` when the worker already has a running task | `task_id`, `claimed_by` |
| `swarm_start` | `claimed → running`; records start time and first heartbeat | `task_id`, `started_by` |
| `swarm_heartbeat` | Renew the lease on a held task | `task_id`, `agent_id` |
| `swarm_complete` | Record the outcome; `success=false` triggers retry logic; a configured quality gate can downgrade a success; merge conflicts/budget blocks apply; `skip_local_gate: true` parks a success in `pending_review`; `reviewed: true` finalises it | `task_id`, `result`, `completed_by`, `success`, `actual_tokens`, `duration_ms`, `anchors`, `skip_local_gate`, `reviewed` |
| `swarm_release` | Return a claimed task to the pool, clearing its lock and its worktree | `task_id`, `released_by` |
| `swarm_reap` | Watchdog sweep: release, flag STALE, or fail stale tasks (and remove their worktrees) | none |
| `swarm_escalate` | Hand a task back as `blocked` with a reason (Lead may force); replies with an explicit stop instruction | `task_id`, `agent_id`, `reason`, `force` |
| `swarm_set_deps` | Lead-only: replace a task's `blocked_by` list | `task_id`, `blocked_by[]`, `updated_by` |
| `swarm_status` | Report the whole pool and per-worker performance (seven states incl. `pending_review`), with `[ROUTING]`, `[budget]` and `[health: rate% · avg]` annotations; appends the idle-pool `[WARNING]` when ready work exists with no active workers | `include_log` |
| `swarm_whisper` | Leave an instruction in a worker's inbox without starting its turn (≤ 1000 chars) | `worker_id`, `message`, `from` |
| `swarm_inbox` | Drain a worker's inbox (ack semantics: reading clears the slot); appends a `[SYSTEM]` budget warning when a held task has spent its ceiling | `worker_id` |
| `swarm_dispatch` | Send a short instruction into a worker's inbox (context-stripping red line): messages > 500 chars are clipped with a `[SYSTEM]` notice; `task_id` adds the standard pull instruction | `worker_id`, `message`, `task_id?` |
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

1. **Write-conflict detection is three-case at the path level, not AST level (optimized in 1.5.1).**
   File↔file conflicts only on the identical normalized path; directory↔directory still conflicts on
   the same or an ancestor directory (segment-aware, so `src/` never matches `src2/`); directory↔file
   is allowed in either direction. **Residual risk:** a directory task may still edit the very file a
   file task holds — the claim is admitted, so granularity remains a promise the workers keep rather
   than an enforced lock. Declare the narrowest file scopes wherever two tasks really can collide
   (`src/api/routes.ts`).
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
6. **Worktree isolation is git-only and now mandatory for `high` work.** It applies to
   `high`-complexity claims only (medium and low work runs in the main checkout). If the worktree
   cannot be created — `tasksRoot` is not a git repository, or `git worktree add` fails — the claim
   is refused with `isolation_unavailable` and the task stays pending; there is no fallback to the main
   checkout. A merge conflict blocks the task and removes the checkout; resolving it needs a person or a
   fresh, smaller task, because the isolated attempt's changes are deliberately not forced onto the main
   tree.
7. **The budget warning is quasi-real-time and cross-attempt, not a kill switch (optimized in
   1.5.1).** `swarm_inbox` looks for tasks held by that worker whose `tokens_used` has reached
   `max_budget_tokens` and appends a `[SYSTEM]` message telling it to stop and call
   `swarm_complete` with `success: false`. **Residual risk:** `tokens_used` only advances when a
   completion is recorded, so the warning reflects the previous attempt's accounting and cannot see
   the current attempt's spend; nothing kills a run mid-flight, and the completion-time breaker
   (`Budget exceeded`) remains the enforcement point.
8. **Whisper and recall are advisory file channels.** A whisper is not a task description: the
   inbox is capped at 1000 characters per message and drained on the worker's schedule, so a critical
   instruction still belongs in `send_message`. Recall is case-insensitive substring matching with no
   tokenizer or fuzzy distance — a deliberate refusal to guess — so imprecise anchors return nothing.
9. **`model` is recorded, never applied.** The scheduler cannot verify that a named model exists,
   cannot select one, and has no fallback path. Recording `model` affects only the `[ROUTING]`
   annotation; `needs_upgrade` only advises. Any actual substitution is an explicit action by the
   developer or the Lead.
10. **The idle-pool warning is an approximation, not teammate telemetry (v1.7.0).** The plugin cannot
    read DSH's live teammate state, so `swarm_status` infers a stalled dispatch from the pool: `ready >
    0`, zero claimed/running tasks, and a non-empty `worker_profiles`. A pool that is quiet because
    every worker is busy *outside* this scheduler is indistinguishable from a pool nobody woke; the
    `[WARNING]` is a prompt to check `list_agents`, not a claim about reality.

## Testing

    npm test

`npm test` runs Node's built-in runner over `test/**/*.test.ts` and **already includes
`--test-isolation=none`**, which keeps it sandbox-safe: a per-file child process cannot capture piped
stdio in a confined environment and fails with `spawn EPERM`. Single-process execution avoids that
entirely. `npm run test:sandbox` is a retained alias for the same command.

The suite contains **237 tests** covering the seven-state lifecycle, retry and blocked transitions,
scope admission, hash verification, routing refusals, the two-phase STALE window, the quality gate,
the token budget and `needs_upgrade` accounting, worktree create/merge/conflict/remove, the
inline-comment audit, the whisper inbox and its ack semantics (including the budget warning), anchor
recall, the v1.6.0 task cache/health routing/tiered gates, the v1.7.0 worker-busy guard/idle
watermark/dispatch truncation/low routing, and concurrent races. Nine cases deserve note:

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
  path-traversal worker id is refused, a corrupt inbox file is consumed as empty rather than
  blocking the worker, and an over-budget task held by the worker appends and returns the exact
  `[SYSTEM]` budget warning while under-budget or unheld tasks do not.
- `test/core/scope.test.ts` pins the v1.5.1 three-case rule: directory↔directory still conflicts on
  the same or an ancestor directory (segment-aware, `src/` never matches `src2/`), file↔file only on
  the identical normalized path, directory↔file is admitted, and slash/dot variants normalize to one
  scope.
- `test/core/recall.test.ts` pins the ranking and the refusal to guess: anchor hits outrank title,
  title outranks description and result, ties are stable by task id, the limit is honoured, an empty
  query matches nothing, and matching is case-insensitive substring only.
- `test/core/similarity.test.ts` pins the v1.6.0 cache contract: identical work scores 1 and returns
  the historical result/anchors, the same prose with a different capability set is not a hit,
  pending/unresolved tasks are never reused, and CJK tokenization keeps Jaccard meaningful.
- `test/core/inbox.test.ts` and `test/core/task-store.test.ts` pin the v1.7.0 rules: the dispatch
  builder clips at exactly 500 characters and appends the `[SYSTEM]` notice, a worker with a running
  task is refused (`worker_busy`) while a claimed one is not, the idle watermark fires only for
  ready-work-with-no-active-workers-and-configured-profiles, and low work yields to a proven standard
  worker but not to an unproven one.

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
