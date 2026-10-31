# dsh-swarm-scheduler (beta)

[![test](https://github.com/SadshiKoro/dsh-swarm-scheduler/actions/workflows/test.yml/badge.svg)](https://github.com/SadshiKoro/dsh-swarm-scheduler/actions/workflows/test.yml)

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

Licensed under the **MIT License** and provided **"as is", without warranty of any kind**. The notice
above is a courtesy, not a substitute for the terms in `LICENSE`: no warranty is given, and the author
is not liable for any loss arising from use of this plugin.

A multi-session parallel coding scheduler plugin for **DeepSeek Harness**. Its core claim is
**"work finds the worker"** (活找人): the Lead only decomposes and wakes; workers pull work out of a
shared on-disk pool by atomic claim.

**0.3.0 起**，任务生命周期从两态扩展为六态（pending / claimed / running / completed / failed /
blocked），支持失败重试、并发上限（`max_workers`）、scope 冲突硬拒绝、看门狗自动回收（`swarm_reap`）
和任务级日志。核心调度逻辑已与 DSH 宿主解耦（`src/core/`），有 102 个测试覆盖（含 10-Worker 并发压测）。

版本脉络：**v0.2.6** 把 `write_scopes` 从提示升级为 claim 时的硬拒绝 → **v0.2.7** 空 `tasksRoot`
在激活时直接拒绝（不再静默落到 `process.cwd()`）→ **v0.3.0** 六态生命周期、`max_workers` 上限、
`swarm_reap` watchdog、任务日志、core/adapter 分离 → **v0.3.1** 上限命中时在 `swarm_ready` 里显示
`degraded: max_workers limit (N) reached` → **v0.3.2** 认领优先级、`required_files` / `required_hashes`
预检 → **v0.4.0** 心跳续约 `swarm_heartbeat`、内容 hash 版本校验、npm 打包与 CI → **v0.4.1** STALE
标记与 lease 语义一致 → **v0.5.0** 异构路由（`complexity` / `required_worker_tier` / `worker_tiers`）
与 50 任务 / 10 scope / 10 Worker 压测 → **v0.6.0** 多维 Worker 画像
（`worker_profiles`：capabilities / 上下文 / 成本）与能力、上下文硬路由 → **v0.7.0** 成本预算硬拦截
（`max_cost_tokens`）与 Worker 可靠性统计（`worker_stats.json`，仅记录） → **v0.8.0** 动态可靠性
拦截（high 任务、失败 >3 且 >50%）、性能反馈（tokens/耗时均值）与呼救协议 `swarm_escalate` →
**v0.9.0** 事件驱动自动回收（`agent/status` idle → 防抖 2s → `autoReap`，`auto_reap` 默认开）。

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
  ├─ swarm_ready        → what is ready right now (0 when max_workers is reached)
  ├─ swarm_claim        → atomic claim (exclusive file creation)
  │     └─ lost the race? `already_claimed` is a NORMAL result — take another block
  ├─ swarm_start        → claimed → running, heartbeat recorded
  ├─ execute the task
  ├─ swarm_complete     → report the compressed outcome (`success:false` on failure)
  │     └─ failed: retry via swarm_start until max_retries, then blocked
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
dsh plugin --profile <your-profile> add link:/path/to/dsh-swarm-scheduler-beta
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

### 4.6 安装（npm，发布后）

包已准备好发布到 npm（`publishConfig.access: public`、`prepublishOnly` 会先跑测试与构建）。发布后可直接从 registry 安装：

```bash
dsh plugin --profile <your-profile> add dsh-swarm-scheduler-beta
```

与源码安装一样，仍需：

1. 在 profile 的 `dsh.profile.bundles` 里加入 `dsh-swarm-scheduler-beta`；
2. 挂载 `@deepseek-ai/dsh-experimental-agent-team-profile`（见 4.1）；
3. 配 `tasksRoot`（见 4.3）；
4. 重启 DSH。

维护者发布流程：

```bash
npm publish        # prepublishOnly: npm test && tsc --noEmit && tsup
```

---

## 5. Usage

### You do not have to invoke the tools by hand

The plugin publishes a **dispatch protocol** as a prompt section (`order: 590`, sitting in the policy
band just before the kernel's own Team policy). When you ask the Agent for something large — several
files, several modules, several steps — it **switches to scheduling mode by itself**: it calls
`swarm_plan`, wakes or creates workers, and then reports progress instead of writing the code itself.

The eleven tools remain directly callable for explicit control.

### Explicit instruction example

```
Use the swarm scheduler for this:
1. swarm_plan — decompose the request into swimlanes and small blocks, with blocked_by and write_scopes.
2. list_agents — if there are idle teammates, wake them with send_message; otherwise spawn 2-3.
3. Wake message (method only, no task ids):
   "Check swarm_ready for ready tasks, claim one with swarm_claim, start it with swarm_start,
    execute it, report with swarm_complete (success=false on failure), then loop back to
    swarm_ready until it returns 0."
4. Never assign a specific task to a specific worker — which worker gets which block is the result
   of an atomic race.
5. Report progress with swarm_status.
```

---

## 6. The eleven tools

| Tool | Purpose | Main parameters |
|---|---|---|
| `swarm_plan` | Submit the decomposition; write it into the task pool | `tasks[]` (`task_id`, `big_task_id`, `title`, `description`, `blocked_by`, `write_scopes`, `priority`, `required_files`, `required_hashes`, `complexity`, `required_worker_tier`, `required_capabilities`, `estimated_tokens`, `max_cost_tokens`) |
| `swarm_ready` | List the tasks a worker may start right now (0 when `max_workers` is reached) | optional `big_task_id` filter |
| `swarm_claim` | Atomically claim one task (`pending` → `claimed`) | `task_id` / `claimed_by` |
| `swarm_start` | Start work (`claimed` → `running`), recording the heartbeat | `task_id` / `started_by` |
| `swarm_heartbeat` | Renew the lease on a task you hold (`claimed`/`running`) | `task_id` / `agent_id` |
| `swarm_escalate` | Hand a task back to the Lead as `blocked`, with a reason (holder only; Lead may `force`) | `task_id` / `agent_id` / `reason` / optional `force` |
| `swarm_complete` | Finish a task; `success=false` marks it failed and drives retry/block | `task_id` / `result` / `completed_by` / `success` / optional `actual_tokens` / `duration_ms` |
| `swarm_status` | Whole-pool status across all six states | optional `include_log` |
| `swarm_release` | Return a stuck task to the pool (`claimed`/`running`/`failed` → `pending`) | `task_id` / `released_by` |
| `swarm_reap` | Watchdog: recover claims/runs older than `staleAssignmentSec` | none |
| `swarm_set_deps` | Replace a task's `blocked_by` list (**Lead only**) | `task_id` / `blocked_by` / `updated_by` |

All scheduling state lives in `<workspace>/.dsh-tasks/<task_id>.json`, and each task's transitions are
appended to `<task_id>.log`. There is no database and no background daemon.

### 6.1 The six-state machine

```
pending ──claim──▶ claimed ──start──▶ running ──complete(success=true)──▶ completed
   ▲                  │                   │
   │                  │                   └──complete(success=false)──▶ failed ──retry▶ (start again)
   │                  │                                                   │
   └──release─────────┴───────────────────────────────────────────────────┤
                                                                           └─retry_count >= max_retries──▶ blocked
```

| State | Meaning | Left by |
|---|---|---|
| `pending` | Ready or blocked, nobody holds it | `swarm_plan`, `swarm_release`, `swarm_reap` (stale claim) |
| `claimed` | Taken by a worker, not yet started | `swarm_claim` |
| `running` | Worker reported it started; `heartbeat_at` recorded | `swarm_start` |
| `completed` | Finished successfully | `swarm_complete(success=true)` |
| `failed` | Attempt failed; `retry_count` incremented; can be started again | `swarm_complete(success=false)`, `swarm_reap` (heartbeat timeout) |
| `blocked` | Retry budget exhausted (`retry_count >= max_retries`) | `swarm_complete(success=false)`, `swarm_reap` |

`max_retries` defaults to 3 per task. `swarm_reap` reverts a stale **claimed** task to `pending` and
turns a stale **running** task into `failed` (reason `heartbeat timeout`), which then follows the same
retry path. Since v0.4.0 the lease age is not just the claim: a **claimed** task is stale only when
both `claimed_at` and `heartbeat_at` are old (the later one wins), and a **running** task is judged by
`heartbeat_at` alone. `swarm_status` uses the **same lease reference** for its `[STALE]` marker and the
`(N stale)` count (v0.4.1), so "status says STALE" and "reap reclaims it" cannot disagree. It also
reports `retry_count` and the last failure reason for failed/blocked tasks, and counts all six states in
its summary line.

### 6.2 Concurrency ceiling

`max_workers` (default **3**) counts `claimed` + `running` tasks. At the ceiling, `swarm_ready` returns
`ready: 0` instead of handing out more work — that is a normal "wait for a slot" answer, not an empty
pool. Set it in the profile's `cordis.patch.yml`:

```yaml
- id: swarm-scheduler
  config:
    max_workers: 3
    staleAssignmentSec: 600
    auto_reap: true
    # legacy tier map (still supported)
    worker_tiers:
      worker-cheap: standard
      worker-strong: premium
    # multidimensional profile (takes precedence over worker_tiers)
    worker_profiles:
      worker-strong:
        tier: premium
        capabilities: [code, test, sql]
        max_context_tokens: 128000
        cost_per_1k_tokens: 0.01
      worker-docs:
        tier: standard
        capabilities: [docs]
        max_context_tokens: 32000
        cost_per_1k_tokens: 0.002
```

`worker_tiers` is the legacy strength map used by routing (§6.5). `worker_profiles` is the
multidimensional picture (§6.6) and wins when both name the same agent. Unlisted workers are
`standard` with no extra capabilities, a 32k context window and a 0.01 cost reference; the scheduler
never knows model names, only these declarations.

### 6.3 调度智能化（v0.3.2）

**`priority`（越大越优先领）**

- `swarm_plan` 的每个任务可带 `priority`（number，默认 `0`）；
- `swarm_ready` 返回的列表**已经排好序**，不再按文件遍历顺序：
  1. `priority` 降序；
  2. 同优先级内，`created_at` 升序（等得越久越优先，FIFO）；
  3. 二者都无法区分时（`created_at` 缺失或同毫秒），按 `task_id` 字母序兜底，保证每轮返回稳定。
- `created_at` 由 `createExclusive` 在任务文件写入时打戳，所有创建路径一致。

**`required_files`（领取前上下文完整性预检）**

- `swarm_plan` 的每个任务可带 `required_files`（string[]，默认空），路径相对 **workspace 根**
  （即 `tasksRoot`），也接受绝对路径；
- `swarm_claim` 在真正置为 `claimed` 之前检查这些文件是否存在；缺任何一个就拒绝，返回
  `missing_dependencies`，消息里列出**每一个**缺失路径（例如
  `missing required file(s): src/a.ts, package.json`），任务保持 `pending`；
- `swarm_status` 对 `pending` 任务在行尾标出 `[blocked: missing X, Y]`，即使它在 DAG 语义上
  `ready` ——「ready 但领不了」是可见的，而不是等到 claim 才失败。

**`required_hashes`（内容版本校验，v0.4.0）**

- 可选的 `{ 文件路径: sha256 hex }`，在 `required_files` 的存在性检查**之后**执行：文件缺失仍先报
  `missing_dependencies`；文件存在但内容 hash 不符，则拒绝并返回 `hash_mismatch`，消息给出
  `声明值 vs 实际值`；
- `swarm_status` 对 `pending` 任务追加 `[blocked: hash mismatch on X]`；
- 这是**内容 hash**（对文件字节做 sha256），不是 git hash、不是版本号；只覆盖 `required_hashes` 里
  声明的文件，未声明的文件变化不影响领取。

### 6.4 心跳续约（v0.4.0）

长任务在 `running` 状态下如果预计耗时超过 `staleAssignmentSec` 的一半，worker 应**定期调用**
`swarm_heartbeat(task_id, agent_id)` 续约，否则 `swarm_reap` 会把仍然活着的 worker 当成死掉：

| 状态 | `swarm_reap` / `swarm_status` 判定依据 |
|---|---|
| `claimed` | `claimed_at` 与 `heartbeat_at` 取**较晚者**，超时才算过期 |
| `running` | 只看 `heartbeat_at`，超时标 `failed`（`heartbeat timeout`）并消耗一次重试 |

`swarm_status` 的 `[STALE]` 与 `(N stale)` 使用**同一 lease 基准**（v0.4.1 起），不会再出现
「reap 不回收、status 却标 STALE」的矛盾。

`swarm_heartbeat` 只接受 `claimed` / `running` 的任务，且 `agent_id` 必须等于 `claimed_by`：
状态不符返回 `invalid_state`，非持有者返回 `not_owner`。日志会追加一条 `heartbeat by <agent>`。

```text
worker: swarm_claim(t) → swarm_start(t)
loop:   每 staleAssignmentSec/2 调一次 swarm_heartbeat(t, me)
        swarm_complete(t, success=…)
```

### 6.5 智能路由：complexity 与 required_worker_tier（v0.5.0）

任务可声明两件事，用于把活分给“够强”的 Worker：

| 字段 | 取值 | 默认 | 含义 |
|---|---|---|---|
| `complexity` | `low` / `medium` / `high` | `medium` | 难度估计，仅用于路由展示与判定，**不绑定任何具体模型** |
| `required_worker_tier` | `any` / `standard` / `premium` | `any` | 允许领取该任务的最低 Worker 等级；`any` 表示不设限 |

Worker 等级来自 profile 配置的 `worker_tiers`（§6.2），未配置的 Worker 视为 `standard`。
`swarm_claim` 在取锁前判定，失败返回 `worker_too_weak`：

1. `required_worker_tier: 'premium'` → 只有 `premium` 能领；
2. `complexity: 'high'` 且声明了非 `any` 的等级 → `standard` 不能领（高难度 + 明确等级要求，不交给弱 Worker）；
3. `any` → 一律放行，路由按任务 opt-in。

`swarm_status` 对非默认配置的行追加 `[complexity: high, req: premium]`。Lead 拆解时应给每个小块评估
complexity，并对高风险块标 `premium`；具体用哪个 provider/model 由 Lead 在 spawn 时决定，调度层只认等级。

**压力测试**：`test/core/stress.test.ts` 模拟 10 个 Worker 对 50 个任务（10 个 scope）并发抢占，并模拟
5 个 Worker 领取后消失、由 `swarm_reap` 一轮回收。它曾在 v0.5.0 开发中抓到一个真实并发缺陷：失败的
claim 会删掉成功 claim 的进程内互斥标记，导致第三次 claim 清掉活锁并双双写入；修复为按任务引用计数。

### 6.6 多维能力调度：capabilities 与 estimated_tokens（v0.6.0）

v0.5.0 的 tier 只回答“够不够强”；v0.6.0 增加两个更精确的硬路由条件：

| 任务字段 | 默认 | 含义 |
|---|---|---|
| `required_capabilities` | `[]` | Worker 必须**声明拥有全部**这些标签（如 `code` / `test` / `docs` / `sql`）；缺任一即拒 |
| `estimated_tokens` | `0` | 任务输入规模估计；`> 0` 时若超过 Worker 的 `max_context_tokens` 即拒；`0` 表示不评估 |
| `max_cost_tokens` | `0` | 成本上限；`> 0` 时按 `worker.cost_per_1k_tokens × estimated_tokens / 1000` 估算，超出即拒；`0` 表示不限 |

Worker 画像来自 profile 的 `worker_profiles`（§6.2 示例）；未配置的 Worker 使用默认画像
`{ tier: 'standard', capabilities: [], max_context_tokens: 32000, cost_per_1k_tokens: 0.01 }`。
`worker_profiles` 与旧 `worker_tiers` 同时配置时，**profile 优先**。

`swarm_claim` 的硬路由顺序（都在取锁前，失败不改任务状态）：

1. tier：`worker_too_weak`（§6.5 的既有规则）；
2. 能力：缺标签 → `worker_lacks_capability`，消息列出缺失标签与 Worker 已声明标签；
3. 上下文：`estimated_tokens > max_context_tokens` → `worker_context_too_small`，消息列出两边数值；
4. 成本：声明了 `max_cost_tokens` 且 Worker 预估成本超出 → `worker_too_expensive`，消息列出预估成本与上限。

**成本默认仍不是拦截条件**：只有任务显式声明 `max_cost_tokens > 0` 时才做硬拦截；未声明时
`cost_per_1k_tokens` 只是 Lead 调度的软参考。`swarm_status` 会展示 `[caps: code,test]`、
`[est: 50k tokens]`，并在末尾列出各 Worker 的统计。

### 6.7 动态可靠性、性能反馈与呼救协议（v0.8.0）

**可靠性拦截（只针对 high）**：`swarm_complete` 的成功/失败会累计到 `.dsh-tasks/worker_stats.json`。
当某 Worker **失败次数 > 3** 且 **失败率 > 50%** 时，它领取 `complexity: high` 的任务会被拒：

```
REJECTED worker_unreliable: t-hard is high complexity and worker-bad has a 80% failure rate
(4/5 attempts); low and medium tasks remain claimable
```

`low` / `medium` 任务**永远不因可靠性被拒**——这是有意的翻身通道；阈值与拒绝码都在取锁前判定，
被拒任务保持 `pending`。

**性能反馈（可选自报）**：`swarm_complete` 成功时可带 `actual_tokens` 与 `duration_ms`，累加到
`total_tokens_consumed` / `total_task_time_ms`。`swarm_status` 据此算出平均值：

```
  workers:
    worker-a: 5 success, 1 failed | avg 1.2k tokens, 45s/task
```

失败尝试不累加 token/耗时（失败花的钱说明的是阻塞原因，不是 Worker 的常态）。平均值只在
`success_count > 0` 时展示。

**呼救协议 `swarm_escalate`**：Worker 遇到自己搞不定的问题（缺关键文件、冲突无法解决、需求要重规划）时，
不要硬写假代码，调用：

```
swarm_escalate(task_id, agent_id, reason)
```

任务变为 `blocked`，`claimed_by` 清空，`reason` 写入 `failure_reason`，日志追加 `escalated by <agent>: <reason>`。
`swarm_status` 会显示 `[blocked]` 与原因。只有任务持有者能呼救（否则 `not_owner`）；Lead 可用
`force: true` 从任何 Worker 手里强制收回。与 `failed` 的区别：`failed` 消耗重试并读作「做坏了」，
`blocked` 读作「等 Lead 决策」，不会被重试逻辑自动重跑。

### 6.8 看门狗：手动与自动（v0.9.0）

死锁回收现在有两条入口，共用**同一套 lease 规则**（`claimed` 取 `claimed_at`/`heartbeat_at` 较晚者，
`running` 只看 `heartbeat_at`）：

| 方式 | 触发 | 配置 |
|---|---|---|
| 手动 `swarm_reap` | Lead 主动调用 | 无 |
| 自动 | 运行时进入 `idle`（DSH `agent/status` 事件），防抖 **2 秒**后后台执行 | `auto_reap: true`（默认） |

自动回收的行为与手动完全一致：超时的 `claimed` → `pending`（释放锁），超时的 `running` → `failed`
（`heartbeat timeout`，走重试）。每次自动回收会写一行到 `.dsh-tasks/auto-reap.log`：

```
Auto-reaped task big-1/small-2 due to lease timeout.
```

并附带 `Pool has new ready tasks (N).`（当回收后确有就绪任务）。`auto_reap: false` 恢复 v0.8.0 的
「只有手动调用才回收」行为。`staleAssignmentSec <= 0` 表示不判定，自动看门狗也不会动手。

设计要点（详见 DESIGN §12.10）：只在 `idle` 触发（`running` 是常见转换，回收会和新工作抢资源）；
防抖把多个 agent 的 idle 合并成一次扫描；回收在后台执行，监听器立即返回，失败只记日志不抛进事件。

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

The pool lives on disk, and its eleven tools are the **only** scheduling interface. The kernel's Team
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

**Core vs adapter (v0.3.0).** The scheduling rules live in `src/core/` — state machine, scopes, store —
and import **nothing** from `@deepseek-ai/*`; they are tested with plain Node (55 cases). The DSH-facing
shell is `src/index.ts` (activation, config) and `src/tools-file.ts` (tool schemas, argument mapping,
rendered output). That split is what lets the state machine be reasoned about and regression-tested
without booting a host; see [DESIGN.md §12.3](./DESIGN.md).

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
5. **Dead workers are recoverable, and reaped both manually and automatically.** A worker that disappears
   would otherwise leave its task `claimed`/`running` forever, and everything blocked by it unreachable.
   `swarm_release` returns such a task to the pool (deleting its `.lock`), and `swarm_claim` clears a
   **residual lock** left mid-claim. **`swarm_reap`** scans `claimed`/`running` tasks, reverts stale claims
   to `pending`, and turns stale runs into `failed` with reason `heartbeat timeout` — which then follows
   the retry path. Since v0.9.0 the same scan also runs **automatically**: when the runtime goes `idle`
   (the `agent/status` event), a two-second debounced background reap runs unless `auto_reap: false`.
   Every automatic reclaim is appended to `.dsh-tasks/auto-reap.log`. The manual tool remains for
   on-demand control; the two paths share one lease rule, so they cannot disagree.
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
   not one of these tools.) **Be aware of the
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
9. **Concurrency correctness has both unit and stress coverage — 102 automated tests.** The suite
   covers the six-state lifecycle (`claim`/`start`/`complete`/`release`/`reap`/`set_dependencies`),
   retry and blocked transitions, the `write_scopes` admission check, residual-lock cleanup,
   readiness/staleness, the `max_workers` ceiling, routing refusals, and concurrent races (same-task
   double claim, overlapping-scope claim, stale-lock claim). `test/core/stress.test.ts` additionally runs
   10 workers against 50 tasks / 10 scopes and checks that the 50 claims are exactly-once and that no two
   overlapping scopes were ever held simultaneously, plus a vanish-and-reap round. Run them with
   `npm test` (Node's built-in runner, no extra dependency; it runs the `.ts` sources directly, which
   needs Node 22.18+, or 22.6+ with `--experimental-strip-types`). The stress case's 3-second budget is a
   Linux/CI budget; on Windows the local filesystem makes a 50-file scan ~40ms, so the test allows a
   wider clock there while keeping every functional assertion identical. If your shell forbids a child
   process from capturing piped stdio — a sandboxed DSH session is the case this was measured in — the
   runner cannot spawn its per-file worker and fails with `spawn EPERM`; run `npm run test:sandbox`
   instead, which runs the same cases in a single process (`--test-isolation=none`). What is still
   measured manually is the *concurrent* behaviour in a real DSH host (multiple live teammates). If you
   intend to use this in production, repeat them in your own scenario.
10. **Symbol-level parallelism is still unsolved.** `write_scopes` is enforced at **directory**
    granularity: two tasks that both declare `src/` are refused at claim time even if one edits
    `src/a.ts` and the other `src/b.ts`. There is no AST-level analysis and no write interception —
    deliberately not attempted, because a false admission silently overwrites a file. v0.3.0 adds
    **heartbeat timeout recovery** (`swarm_reap`) so a hung worker no longer pins a slot forever, but
    it does not make file-level concurrency safe. Declare narrower scopes (`src/api/routes.ts`) when
    you need finer resolution.
11. **能力画像是静态配置；可靠性只拦 high 任务，且阈值很保守。** `worker_profiles` 里的
    `capabilities`、`max_context_tokens`、`cost_per_1k_tokens` 都是**部署时手写的声明**，DSH 不提供
    跨会话记忆，插件也无法验证 Worker 的真实能力。v0.7.0 起把每次 `swarm_complete` 的成功/失败记到
    `.dsh-tasks/worker_stats.json`；v0.8.0 起该记录只对 `complexity: high` 生效（失败次数 > 3 且
    失败率 > 50% 才拒），low/medium 永远放行。原因：一两次失败说明不了问题，而把失败简单归因给
    Worker 可能惩罚的是任务拆解本身；统计仍主要作为证据与性能参考（平均 tokens/耗时），没有自动降级
    或自动重排班。呼救（`swarm_escalate`）把「做不了」显式交给 Lead，避免 Worker 硬写假代码。

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
