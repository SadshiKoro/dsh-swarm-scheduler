# dsh-swarm-scheduler (beta)

> **实验性插件（beta，0.x）**
>
> 对于下载并尝试安装此插件的朋友，先作声明：这是一个实验性插件，处在 0.x 阶段，建立在 DeepSeek
> Harness（DSH）的 **Agent Teams** 之上——它依赖的 `@deepseek-ai/dsh-experimental-agent-team-profile`
> 本身带 `experimental` 标记，且必须手动挂载，仍有许多不稳定性。欢迎改进这个插件；如果它让谁的工作
> 受了损失，我深表歉意，也希望你把意见或改进方向提给我。
>
> **English** — Before installing: this is an experimental (beta, 0.x) plugin built on DeepSeek
> Harness's Agent Teams layer. That layer comes from `@deepseek-ai/dsh-experimental-agent-team-profile`,
> a package marked experimental by its own label that must be mounted by hand. Expect instability.
> Improvements and bug reports are welcome. If this plugin cost you work, I am sorry — please tell me
> what broke or what should change.

A multi-session parallel coding scheduler plugin for **DeepSeek Harness**. Its core claim is
**"work finds the worker"** (活找人): the Lead only decomposes and wakes; workers pull work out of a
shared on-disk pool by atomic claim.

---

## 1. What problem it solves

A normal Agent is single-threaded. It reads, edits, runs commands and reasons **one step at a time**,
so a request touching a dozen files is a long serial chain. This plugin turns that Agent into a
**dispatcher**: it splits the request into independent blocks, writes them into a task pool, wakes a
few workers, and each worker claims blocks and executes them **in parallel** — while the Lead never
writes a line of the product code itself.

The important asymmetry is *who initiates the hand-off*. The common design is "the Lead assigns a
task to a named worker" (a person finds work). This one is the opposite: **a block sits in the pool
and workers compete for it** — whoever is free picks it up. That is what makes it scale without the
Lead having to track who is idle.

---

## 2. Core concepts

### Two-layer decomposition

| Layer | Meaning | Stored as |
|---|---|---|
| **Big task block (swimlane)** | A cohesive area of the request, e.g. "data layer", "HTTP layer", "integration" | `big_task_id` |
| **Small task block** | The scheduling unit: one worker, one context window, one deliverable | one task record |

### Hard constraints on a small block

Every small block must be independently executable by a fresh session that has **only the task
description**:

1. Explicit **inputs, outputs and acceptance criteria**.
2. **No write conflicts** with any other ready block — the smallest unit is one function, one file,
   one configuration item, or one independently verifiable behaviour.
3. Real dependencies declared with `blocked_by`. Do not serialise "just to be safe": that collapses
   parallelism to 1.
4. Files touched are declared in `write_scopes`. As of v0.2.6 this is **enforced at claim time**: a
   task whose scopes overlap an already-claimed task is refused with `scope_conflict` instead of being
   admitted, so declare the narrowest scope that is still honest. Overlap is judged at **directory**
   granularity — see the `write_scopes` entry in §9.

### Roles

| Role | Identity | May do | Must not do |
|---|---|---|---|
| **Lead** | the current session | decompose (`swarm_plan`), adjust dependencies (`swarm_set_deps`), wake workers, report progress | **claim tasks, or write product code** |
| **Worker** | a teammate created by the Lead | `swarm_ready` → `swarm_claim` → execute → `swarm_complete` | touch another worker's task, or edit dependencies |

---

## 3. How it works

```
Lead receives a large coding request
  │
  ├─ swarm_plan(...)                     ← decompose into two layers, write the file pool
  │     └─ .dsh-tasks/<task_id>.json per block (blocked_by forms a DAG)
  │
  ├─ list_agents                         ← reuse idle teammates if any exist
  │     ├─ idle workers found → send_message (wake them, method only, no task ids)
  │     └─ none              → spawn_teammate ×2-3
  │
  └─ swarm_status                        ← watch progress, report to the user

Worker (each, independently, in parallel)
  ├─ swarm_ready        → what is ready right now
  ├─ swarm_claim        → atomic claim (exclusive file creation)
  │     └─ lost the race? `already_claimed` is a NORMAL result — take another block
  ├─ execute the task
  └─ swarm_complete     → report the compressed outcome
        └─ back to swarm_ready for another round, until it returns 0

Lead, on a conflict report from a worker
  └─ swarm_set_deps     → serialise the conflicting blocks after the fact
```

**The pool does not flow by itself.** Nothing in the kernel pushes work to an idle worker; the Lead
wakes them, and after the first wake a worker keeps pulling until the pool is empty. If a worker
disappears mid-task, the Lead can return the block to the pool with `swarm_release`.

---

## 4. Installation

### 4.1 Prerequisite: mount the Agent Teams profile bundle

The `agentTeams` service comes from the **experimental** package
`@deepseek-ai/dsh-experimental-agent-team-profile`. It is **NOT** in any default profile bundle, so
the service is never provided and must be mounted explicitly. Add it to your profile's
`dsh.profile.bundles`:

```diff
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
+        "@deepseek-ai/dsh-experimental-agent-team-profile",
         ...
       ]
     }
   }
```

> ⚠️ **Do not add it to `dependencies`.** These packages ship inside the application bundle
> (`app.asar`), exactly like the official `@deepseek-ai/dsh-base`; they are not resolvable from npm.
> Adding them to `dependencies` makes `pnpm install` fail.

> ⚠️ **Side effect.** This bundle disables the built-in subagent tools
> (`subagent`, `subagent_fork`, `list_agents` (native), `interrupt_agent` (native)) and replaces them
> with the Team versions (`spawn_teammate`, `send_message`, `team_task_*`, …). Expect those tools to
> change. Roll back by removing the bundle line and restarting.

> **Rolling back.** To undo the side effect you must **remove
> `@deepseek-ai/dsh-experimental-agent-team-profile` from the profile's bundle list and then restart
> DSH**. Removing only the plugin does **not** restore the native subagent tools — the bundle is what
> swapped them, and the bundle is independent of this plugin.

### 4.2 Install the plugin

```bash
dsh plugin --profile <your-profile> add link:/path/to/dsh-swarm-scheduler
```

(Or add a `file:`/`link:` entry to the profile's `dependencies` and the package name to
`dsh.profile.bundles`.)

### 4.3 `tasksRoot` is required — and an empty value is refused

**You must fill in an absolute path.** The default is empty, and in DSH Desktop `process.cwd()` is the
**profile directory, not the session workspace** — so leaving it unset used to create every task file
in the wrong place.

Since **v0.2.7** the plugin no longer falls back silently: activation throws, the fiber reports
`failed`, and the message names the setting and the line to add:

```
tasksRoot is empty. Refusing to place the task pool under process.cwd() (<cwd>) — in this deployment
that is the profile directory, not the workspace being scheduled, so every task would land where you
never look. Set it where this plugin is configured, e.g.
  tasksRoot: 'C:/path/to/the/workspace/being/scheduled'
```

That error means the plugin is mounted but not configured: add the `config` block below and restart.
Nothing is written until `tasksRoot` resolves.

Give the `swarm-scheduler` entry a `config` block in the profile's `cordis.patch.yml`:

```yaml
- id: swarm-scheduler
  config:
    tasksRoot: 'C:/your/workspace/absolute/path'
```

Use forward slashes and an absolute path. The pool is created as
`<tasksRoot>/.dsh-tasks/<task_id>.json`.

### 4.4 If the plugin does not load

Set the environment variable `DSH_SWARM_SCHEDULER_MODULE_PROBE` to a file path. When the module is
imported it appends one line, `MODULE EVALUATED pid=<pid>`:

- **the file is not created** → the module was never imported, so the problem is the **assembly path**
  (patch row, bundle list, package resolution);
- **the file is created but there is no `APPLY OK`** → the module was imported but `apply` did not
  complete, so the problem is **inside activation**.

This works because the probe runs at module scope, before `apply` is reached — which is the only way
to tell those two failure domains apart, since the loader never awaits `apply()` and reports
`fiberPhase: active` even when activation never ran.

`APPLY OK` / `APPLY FAILED` lines are separate: they are written only when the plugin's
`debugLogPath` config value is set (empty by default = no log at all).

### 4.5 Restart

**You must restart DSH.** Tools, the prompt section, the bundle list and `tasksRoot` are all applied
at startup. There is no hot reload.

---

## 5. Usage

### You do not have to invoke the tools by hand

The plugin publishes a **dispatch protocol** as a prompt section (`order: 590`, sitting in the policy
band just before the kernel's own Team policy). When you ask the Agent for something large — several
files, several modules, several steps — it **switches to scheduling mode by itself**: it calls
`swarm_plan`, wakes or creates workers, and then reports progress instead of writing the code itself.

The seven tools remain directly callable for explicit control.

### Explicit instruction example

```
Use the swarm scheduler for this:
1. swarm_plan — decompose the request into swimlanes and small blocks, with blocked_by and write_scopes.
2. list_agents — if there are idle teammates, wake them with send_message; otherwise spawn 2-3.
3. Wake message (method only, no task ids):
   "Check swarm_ready for ready tasks, claim one with swarm_claim, execute it, report with
    swarm_complete, then loop back to swarm_ready until it returns 0."
4. Never assign a specific task to a specific worker — which worker gets which block is the result
   of an atomic race.
5. Report progress with swarm_status.
```

---

## 6. The seven tools

| Tool | Purpose | Main parameters |
|---|---|---|
| `swarm_plan` | Submit the decomposition; write it into the task pool | `tasks[]` (`task_id`, `big_task_id`, `title`, `description`, `blocked_by`, `write_scopes`) |
| `swarm_ready` | List the tasks a worker may start right now | optional `big_task_id` filter |
| `swarm_claim` | Atomically claim one task | `task_id` / `claimed_by` |
| `swarm_complete` | Mark a task finished and store its outcome | `task_id` / `result` / `completed_by` |
| `swarm_status` | Whole-pool status in one call | none |
| `swarm_release` | Return a stuck task to the pool (`claimed` → `pending`) | `task_id` / `released_by` |
| `swarm_set_deps` | Replace a task's `blocked_by` list (**Lead only**) | `task_id` / `blocked_by` / `updated_by` |

All scheduling state lives in `<workspace>/.dsh-tasks/<task_id>.json`. There is no database and no
background daemon.

---

## 7. Two-layer validation on `swarm_set_deps`

Dependencies could originally only be declared at plan time, which made a serialisation mistake
unfixable mid-run. `swarm_set_deps` closes that, and validates two things a dependency graph needs:

| Check | Return code | Why |
|---|---|---|
| Every referenced id exists | `invalid_dependency` | A dangling blocker would make the task **permanently unready** — a missing task never counts as completed. |
| The new edges close no cycle | `cycle_detected` | Detected by walking the graph downward from the proposed blockers; if the walk reaches the task itself, it is refused. A self-reference is just the shortest cycle. |

**Both refusals happen before anything is written** — a rejected task is left exactly as it was, with
no half-written state. `swarm_set_deps` is **Lead-only on purpose**: `blocked_by` is one shared graph,
so concurrent edits by several workers could interleave into the very cycle the check exists to
prevent. Serialising the decision on a single writer is what makes the cycle check meaningful.

---

## 8. Architecture: route B (the file pool is the source of truth)

The pool lives on disk, and its seven tools are the **only** scheduling interface. The kernel's Team
task board is used for nothing but waking workers.

**Why route B.** The goal is "work finds the worker". The file pool's three primitives are exactly that
chain — `swarm_ready` (who may work), `swarm_claim` (the work lands in a worker's hands),
`swarm_complete` (the result returns to the pool). The team board's `reassign` runs the other
direction: a Lead *assigns* work to a person. Two different goals, not two implementations of one.

Route B also dissolves three defects that route A suffered from — all measured, see
[DESIGN.md §12.1](./DESIGN.md#121-three-architectural-defects-found-by-measurement-recorded-after-the-v015-concurrency-verification):

| Defect under route A | Why it disappears under route B |
|---|---|
| `reassign` and `claim` fight over the same state slot | The Lead never calls `reassign`; nothing claims on the board |
| The two stores have no mutual exclusion, so one task could be half-claimed by two workers | The board does not participate in scheduling at all |
| Blocked tasks could not be mirrored | Readiness is decided entirely by the file pool's `blocked_by` |

**Rejected — route A (team board as the source of truth):** dispatching is driven by the Lead's
`reassign`, so workers are passive. Workable, but it turns "work finds the worker" back into "the Lead
finds the worker", which contradicts the goal.

**Rejected — route C (drop the file pool, use only the board):** would discard the atomic self-claim
chain that is the whole point, and would tie the plugin to the experimental `agentTeams` service for
*scheduling* rather than merely for waking.

---

## 9. Known limitations

1. **No visualisation panel.** The header panel was removed in v0.2.0. Its data route
   (`/api/swarm/board`) needed `ctx.webServer`, which is **not reliably resolvable** from this
   plugin's fiber (measured: one `ROUTE REGISTERED`, the rest `ROUTE SKIPPED webServer not mounted`).
   A button opening a "board unavailable" panel was worse than no button. See
   [DESIGN.md §5](./DESIGN.md#5-visualization-active-session-management-area).
2. **No memory isolation.** The plugin contract exposes no memory service. Context passes between
   blocks as **files**, not through memory.
3. **`ctx.fs` sandbox degradation.** Writes through `ctx.fs` need a per-call sandbox policy; when the
   deployment refuses them, the plugin falls back to `node:fs` and **labels every result with
   `degraded`**. It is never silent — but the fallback does bypass `ctx.fs`'s version observation.
4. **Members cannot be removed.** `agentTeams` has **no member-deletion API** — not `remove`,
   `dismiss`, `release` or `evict`. `interrupt` only stops the current turn. The roster only grows and
   is cleared when the Lead session ends. The protocol therefore prefers **reusing idle workers** over
   creating new ones.
5. **Claims had no reclamation** — *fixed*: a worker that disappears leaves its task `claimed`
   forever, and everything blocked by it becomes unreachable. `swarm_release` (v0.1.9) returns such a
   task to the pool, and as of v0.2.6 it also **deletes the task's `.lock` file**. `swarm_claim`
   clears a **residual lock** (one present while the task still reads `pending`, i.e. left by a holder
   that died mid-claim) before claiming. So neither a dead worker's task nor its stale lock blocks the
   pool permanently.
6. **`swarm_set_deps` cannot be enforced at runtime.** It is Lead-only by description and protocol,
   not by a permission check — checking would require `agentTeams.membership`, i.e. reintroducing the
   service route B deliberately removed.
7. **`write_scopes` is checked at claim time, and the check is directory-granular.** If a task's
   scopes overlap those of a task that is **already claimed**, the claim is refused with
   `scope_conflict`, naming the conflicting task and the overlapping scope. This upgraded a purely
   advisory *posture* into a hard refusal (v0.2.6) — and to be exact about what changed: **this pool
   never emitted an overlap warning of its own.** The soft, early view is `swarm_ready`, which lists
   each task's declared `scope:`; the hard view is the refusal, at the moment of admission.
   (`writeScopeWarnings` is the *kernel*'s rule for the team board — see the appendix in DESIGN.md —
   not one of these seven tools.) **Be aware of the
   granularity**: two tasks that both declare `src/` are refused even when they would edit different
   files in it. When you need finer resolution, declare narrower scopes — `src/api/routes.ts` rather
   than `src/`.
8. **This plugin depends on an experimental package.** It needs
   `@deepseek-ai/dsh-experimental-agent-team-profile`, which is **not in any DSH default bundle** and
   must be mounted by hand. That has three consequences:
   - installing the plugin takes one extra configuration step (mounting the bundle) before it works
     at all;
   - the bundle **may change with a DSH update**, and this plugin does **not** guarantee long-term
     compatibility with it. `experimental` is the package's own label, not a note of caution added
     here;
   - if DSH promotes that package into a default bundle, or removes it, **the installation steps in
     §4 will change** and this README may be out of date.
9. **Concurrency correctness is verified by hand; the core logic now has regression tests.** Unit
   tests cover `task-store.ts` — `claim` / `release` / `complete` / `setDependencies`, the
   `write_scopes` admission check, residual-lock cleanup, and readiness/staleness — run them with
   `npm test` (Node's built-in runner, no extra dependency; it runs the `.ts` sources directly, which
   needs Node 22.18+, or 22.6+ with `--experimental-strip-types`). If your shell forbids a child process
   from capturing piped stdio — a sandboxed DSH session is the case this was measured in — the test
   runner cannot spawn its per-file worker and fails with `spawn EPERM`; run
   `npm run test:sandbox` instead, which runs the same cases in a single process
   (`--test-isolation=none`). What is still measured manually is the
   *concurrent* behaviour: the single-task closed loop, a 3-worker run with atomic claiming, and the
   route-B closed loop. So the logic has regression protection; the claim that it is safe under real
   concurrency still rests on those manual runs. If you intend to use this in production, repeat them
   in your own scenario.

---

## 10. Pitfalls found the hard way

These cost real debugging time. They are recorded because each one **fails silently** — no error, no
log, nothing that looks wrong.

1. **`cordis.patch.yml` entries are materialised only once.** After the loader first sees an entry,
   changing its `name`, its `id`, or restarting the app will not re-materialise it. Do not iterate on
   probes through a patch mount.
2. **`dsh-super-injector` does not work on Desktop.** `activeEntry=none`, no failure reason recorded,
   `stats.json` reason always empty. Use the official bundle assembly instead.
3. **`ctx.<service>` is gated by `inject`.** Property access on an undeclared service throws
   `cannot get property "X" without inject` — so probing by *removing* `inject` and then reading the
   property is a self-fulfilling test. The correct probe is **`ctx.get('X')`**, which queries the
   global store and distinguishes "service absent" from "service not visible here".
4. **The `agentTeams` service needs an explicitly mounted bundle.** It comes from an experimental
   package that is in no default bundle. Declaring it in `inject` while nothing provides it parks the
   fiber at `pending` forever — waiting for a service that will never appear.
5. **pnpm ignores a changed `file:` + `.tgz` specifier.** If the path and version are unchanged, it
   reports "Already up to date" and reuses the stale tarball. Bump the version (or the filename).
6. **`pnpm install` is purely lockfile-driven.** It does not repair a `node_modules` entry that has
   disappeared from disk, and it will not re-resolve a local package whose own dependencies changed.
   `--lockfile-only` rebuilds the lockfile; delete the stale entry if it must be re-resolved.
7. **`process.cwd()` is not the session workspace.** In this deployment it is the profile directory,
   so a pool at a relative path lands in the wrong place. The root is therefore an explicit config
   value (`tasksRoot`), and since v0.2.7 an empty value is **refused at activation** rather than
   silently resolved against `process.cwd()`.
8. **`ctx.fs` writes are refused by the sandbox.** `dsh-fs-sandbox` fences every mutation by a
   per-call policy and falls back to the deployment default; the plugin does not fabricate that
   policy, so writes can be denied even when the target directory exists. Hence the labelled
   `node:fs` fallback.
9. **`Get-Content` line counts are untrustworthy.** Windows PowerShell decodes UTF-8 as GBK by
   default, swallowing LF bytes — a measured 1,045-line file reported as 786. Use
   `-Encoding UTF8` or count `0x0A` bytes.
10. **Read-only snapshots go stale.** A task description that asserts an expected value ("this file
    should be 31033 bytes") expires the moment the artifact is rebuilt. Prefer "report the measured
    value" over "check that it equals X".

---

## 11. License

MIT License — see [LICENSE](./LICENSE).

## 12. Contributing

Issues and pull requests are welcome. If you are changing the scheduler itself, please read
[`DESIGN.md`](./DESIGN.md) first: [§12.1](./DESIGN.md#121-three-architectural-defects-found-by-measurement-recorded-after-the-v015-concurrency-verification)
records the defects that shaped the current design, and [§12.2](./DESIGN.md#122-architectural-decision-route-b-file-pool-as-authority)
the architecture decision (route B) that the rest of the code assumes.
