import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import { Config, resolveTasksRoot, type Config as SwarmConfig } from './config.js'
import { TaskStore, TASKS_DIR, type FsLike } from './core/task-store.js'
import { autoReap } from './core/auto-reap.js'
import { registerFileTools } from './tools-file.js'

export const name = 'dsh-swarm-scheduler-beta'
export { Config }

/**
 * Re-export the arithmetic fixtures.
 *
 * `src/utils/math.ts` depends on no `@deepseek-ai/*` package and no Node
 * built-in, which is what lets its consumers — and `test/math.test.ts` — run
 * under plain `node --test` without a runtime. Re-exporting it here means a
 * caller of the package can reach `add`/`subtract` without a deep `lib/`
 * import, and it costs activation nothing: `export *` is a binding, not a
 * side effect, so the module probe above still measures the same thing.
 */
export * from './utils/math.js'

/**
 * Re-export the HTTP helpers (`fetchWithTimeout`, the concurrency limiter and
 * its error type).
 *
 * Same reason as `math.ts` — no `@deepseek-ai/*` import, so it survives a bare
 * `node --test` — plus one that only shows up at packaging time: `tsup` bundles
 * from this entry, so a module nothing here reaches is compiled by `tsc` and
 * then silently left out of `lib/`. Leaving it unreferenced made the helpers
 * exist in the repository but not in the published package.
 */
export * from './utils/http.js'

/**
 * Module-evaluation probe, driven by an environment variable.
 *
 * This runs at MODULE SCOPE — after the imports, before anything else — and that
 * placement is the entire point. The loader never awaits `apply()`, so an
 * activation that never ran is indistinguishable from one that ran fine: both
 * report `fiberPhase: active`. A line written here, before `apply` is reached,
 * is the only signal that separates two different failure domains:
 *
 *   - file absent           → the module was never imported at all → the problem
 *                             is the assembly path (patch row, bundle list, …)
 *   - file present, no APPLY OK → the module evaluated but `apply` did not
 *                             complete → the problem is inside activation
 *
 * It deliberately does NOT consult Config: a module-scope statement runs before
 * any Config exists, so a config-driven probe could only ever be written from
 * `apply` — which would defeat the purpose of distinguishing "never imported".
 * The environment variable is therefore the only correct control here, and it
 * defaults to "write nothing": an unset variable performs no I/O at all.
 *
 * Enable it with, for example:
 *   DSH_SWARM_SCHEDULER_MODULE_PROBE=/tmp/swarm-probe.log
 */
const MODULE_PROBE = process.env.DSH_SWARM_SCHEDULER_MODULE_PROBE
if (MODULE_PROBE && MODULE_PROBE.trim().length > 0) {
  try {
    appendFileSync(MODULE_PROBE, `${new Date().toISOString()} MODULE EVALUATED pid=${process.pid}\n`, 'utf8')
  } catch {
    // A probe that throws would recreate the very silence it exists to remove.
  }
}

/**
 * Activation diagnostics, written only when the deployment asks for them.
 *
 * A module-scope file path used to be hard-coded here, which embedded one
 * developer's home directory in source that ships to other people and only
 * worked on the machine it was written on — everywhere else the write failed and
 * the diagnostic silently became a no-op.
 *
 * So in-`apply` logging is opt-in through `Config.debugLogPath`. Empty (the
 * default) means nothing is written. This is deliberately a SECOND, independent
 * mechanism from the module probe above: that one is controlled by an
 * environment variable and fires before activation, this one is controlled by
 * Config and fires during it.
 */
function debugLog(configured: string, line: string): void {
  const target = configured.trim()
  if (target.length === 0) return
  try {
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Diagnostics must never be the reason activation fails.
  }
}

/**
 * Service dependencies — deliberately minimal.
 *
 * This plugin used to inject `agentTeams`, `subagents`, `webServer`, `timer`
 * and `connection`. Every one of those proved unreachable from this fiber: the
 * probes recorded `cannot get property "X" without inject` on repeated boots,
 * under both a patch insert and a bundle install, which parked the fiber at
 * `pending` while they were declared.
 *
 * That reading was WRONG, and the correction matters: Cordis has no service
 * scope isolation, and the old probe removed the `inject` declaration before
 * testing `ctx.agentTeams`, so `cannot get property "agentTeams" without inject`
 * was guaranteed — a self-fulfilling test. The real cause was that nothing ever
 * provided the service: `agentTeams` comes from
 * `@deepseek-ai/dsh-experimental-agent-team-profile`, which IS registered in the
 * profile's bundle list as of this build, so the service now exists.
 *
 * Declared dependencies — **route B only** (see DESIGN.md §12.2):
 *   - `tools`        — the registry the five tools are published to.
 *   - `fs`           — every task read and write goes through it, so the sandbox
 *                      and observation policies apply (see `task-store.ts`).
 *   - `systemPrompt` — the registry used to publish the dispatch protocol below,
 *                      so the Lead reaches for the pool without being told to.
 *
 * `agentTeams` and `agents` used to be declared here and are now **removed**:
 * the file pool is the single source of truth for scheduling, so this plugin
 * must not depend on the team board at all. Keeping a service in `inject` that
 * no line of code reads is exactly the "worker will use reassign" assumption
 * that route B rejects — a dependency that exists only in a declaration.
 *
 * `subagents` was never declared: the agent-team profile layer disables four
 * subagent tool entries, so whether that service is provided is unverified.
 */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Debounce for the idle-triggered watchdog: bursts collapse into one scan. */
const AUTO_REAP_DEBOUNCE_MS = 2000

/**
 * The dispatch protocol, published as a prompt section.
 *
 * Section placement is deliberate and documented rather than incidental:
 *   - `order: 590` places it in the POLICY band, right after `PLAN_POLICY` (500)
 *     and immediately before `TEAM_POLICY` (600). The previous value, 100_000,
 *     was larger than every shipped section (the repository's own maximum is
 *     `DEPLOYMENT_PERSONA_SUFFIX: 10200`), so the protocol rendered last in the
 *     whole prompt — the weakest position for a behavioural instruction that
 *     asks the model to switch modes, and measurably so: it landed after the
 *     persona suffix.
 *     The band matters because this section answers "should I switch to
 *     dispatch mode at all", which is the same kind of question `PLAN_POLICY`
 *     answers; `TEAM_POLICY` then describes the tools it points at. 590 is in
 *     use by nothing, so it reorders no existing section.
 *   - `name` is the uniqueness key: a scoped section shadows a global one with
 *     the same name, and duplicates inside one layer throw. The name is
 *     plugin-prefixed so it cannot collide with a shipped section.
 *   - `text` is a constant string, so it carries no per-assembly cost and
 *     cannot fail by referencing an undefined variable.
 */
const PROTOCOL_SECTION = 'swarm-scheduler-dispatch-protocol'
const PROTOCOL_ORDER = 590
const PROTOCOL_TEXT = `当用户提出一个较大的编码需求（涉及多个文件、多个模块、或需要多步完成）时，不要自己一件一件做。改用多会话并行调度：

1. 先用 swarm_plan 把需求拆成两层任务写进任务池。
   - 大任务块之间尽量独立，允许少量前后依赖。
   - 每个大任务块拆成若干完整的小任务块。
   - 每个小任务块要有明确的输入、输出、验收标准，一个子会话拿到就能独立做完。
   - 小任务块之间互不干扰，不会因为写同一个文件、改同一个配置而冲突。
   - 需要依赖其他小任务块的，用 blocked_by 标明。
   - 拆解的最小粒度：一个函数、一个文件、一个独立配置项、一个可独立验证的行为。
   - **评估复杂度**：给每个小块标 complexity（low / medium / high）；标 high 的块要说明理由（跨模块、需要设计判断、易错）。
   - **决定 Worker 等级**：高复杂或高风险的块设 required_worker_tier: 'premium'，其余可留 'any'。这是抽象等级，不要写具体模型名。
   - **评估能力需求**：如果块需要特定技能（test / docs / sql / 前端等），在 required_capabilities 里列出；Worker 必须声明拥有**全部**这些标签才能领取，缺一个即被拒（worker_lacks_capability）。
   - **估算上下文**：复杂或大输入块给出粗略 estimated_tokens；超过 Worker 的 max_context_tokens 会被拒（worker_context_too_small）。0 表示不评估。
   - **成本敏感任务**：若该块有预算上限，请声明 max_cost_tokens（预估 tokens × 单价上限）；Worker 的预估成本超过它会被拒（worker_too_expensive）。未声明时成本只是软参考。
   - **能力声明要准确**：capabilities 是你按模型能力配置的静态声明，DSH 不提供跨会话验证；请如实配置，避免把重活派给弱 Worker。

2. 用 list_agents 查看有没有空闲的 teammate（status 为 inactive 的）。
   有空闲的 → 直接 send_message 唤醒它们，不要新建。
   没有空闲的 → 用 spawn_teammate 创建 2-3 个。
   需要 premium 级 Worker 时，创建/复用一个能力更强的 teammate，并在部署的 worker_tiers 或 worker_profiles 配置里标成 premium（provider/model 由你按可用性分配，调度层不认识具体模型名）。

3. 给每个 worker 发一条 send_message，消息里只说：
   "去 swarm_ready 查就绪任务，swarm_claim 自领，swarm_start 开工，做完用 swarm_complete 回报（失败时 success=false，成功时可附带 actual_tokens / duration_ms 供性能统计），然后回到 swarm_ready 再拉一圈，直到 swarm_ready 返回 0。预计耗时超过 staleAssignmentSec 一半的任务，running 期间每隔一段时间调一次 swarm_heartbeat 续约。如果你发现自己搞不定（缺关键文件、代码冲突无法解决、需求本身需要重新规划），不要硬写假代码，调用 swarm_escalate 把任务挂起（状态变 blocked，原因写进 failure_reason），让 Lead 重新规划。**每完成一个任务就把结果留在池子里，不要 send_message 通知 Lead；只有 swarm_escalate 才是需要叫醒 Lead 的通道。**"

4. 不要指定具体任务给 worker。谁领到哪一个是原子竞争的结果。

5. 用 swarm_status 查看整体进度，向用户汇报。

6. **【静默执行原则】——这条优先级高于下面的所有沟通规则。**
   Worker 完成一个任务后，**绝对不要用 send_message 呼叫 Lead**。直接调 swarm_complete 把结果写进文件池就是全部交付：Lead 会自己按节奏查池子，那条消息只会把已经结束的 Lead 轮次强行唤醒，换不来任何新决策，纯烧 Token。
   给 Worker 的派发消息里也**不要**要求「每完成一条就向 Lead 简报」——那是在教它制造诈尸。
   只有两种情况 Worker 才该主动叫 Lead：
   - 它**搞不定**（缺关键文件、冲突无法解决、需求要重新规划）→ 调 swarm_escalate，任务变 blocked，这是唯一的「呼救」通道；
   - Lead 明确要求它做一件必须回报的事（例如代为验收）。
   Lead 这一侧同理：**只有当整个池子跑完（没有 pending/claimed/running 了），或者出现 blocked 任务时，才需要做总结并向用户汇报**；中间每完成一个任务都不该醒来。

7. 如果 worker 在执行中撞到依赖冲突（比如两个任务要改同一个文件、或者串行链在规划期没声明），它会通过 send_message 报告你。你收到报告后，用 swarm_set_deps 调整任务的 blocked_by，把冲突的任务串行化。依赖调整只由你做，不要让 worker 自己改。
   如果收到 worker 的呼救（swarm_escalate），任务会以 blocked 状态出现并在 failure_reason 里写明原因；用 swarm_status 查看，再决定改需求、补依赖或重新拆解。需要从某个 Worker 手里强行收回任务时，用 swarm_escalate(force: true)。
   注意：失败率过高（失败次数 > 3 且失败率 > 50%）的 Worker 会被拒绝领取 complexity=high 的任务（worker_unreliable），但 low/medium 仍对它开放——这是有意的「练手与翻身」通道。

8. 看到 failed 的任务时，判断是否重试：可以再发一条 send_message 让 worker 重新 swarm_start 该任务（failed 任务可直接 start），或用 swarm_release 把它放回 pending 让别人重领。retry_count 达到 max_retries 后会变成 blocked，此时需要人工介入或调整拆解。

9. 定期用 swarm_status 查看进度。如果某个任务被标为 STALE（claimed/running 超过阈值，可能 worker 卡死或消失），先确认 worker 是否还能续约；确实无响应再用 swarm_reap 自动回收（claimed 回 pending、running 标 failed 走重试），或按需用 swarm_release 释放个别任务。正在跑长任务的 worker 应主动调 swarm_heartbeat，避免被误回收。

10. 并发上限由 max_workers 控制（默认 3）。swarm_ready 在 claimed+running 达到上限时返回 0，这是正常现象，等已有任务完成后再拉。

11. **质量门禁（若部署配置了 quality_gate_command）**：Worker 交付的代码必须在提交前就能通过该命令，否则即使 swarm_complete 传了 success:true 也会被自动打回为 failed（retry_count + 1），并在 failure_reason 里带上命令输出的前 500 字符。因此：
    - 在**任务描述里把验收命令写清楚**（例如「验收：npm test 与 npx tsc --noEmit 均通过」），让 Worker 知道门禁会跑什么。
    - 不要把一个改动范围会导致工作区无法构建或测试变红的小任务并行派出去——门禁是按整块工作区判定的，别人的红也会记在你的任务上。
    - Worker 收到 failed 不是「result 被丢了」，而是「工作区没通过」；让它修好工作区后重试，不要靠改写 result 绕过。
    - **分级门禁（v1.6.0）**：只改 .md/.mdx 或 test/、tests/、docs/ 下的文件时，本地门禁自动跳过；需要把多次本地门禁合并成一次全局检查时，Worker 可传 skip_local_gate:true，任务进入 pending_review（第七状态，不可认领）。全部任务完成后由 Lead 在主工作区跑一次最严格的全局门禁，再对每个 pending_review 任务调 swarm_complete(..., reviewed:true) 落为 completed。
    - **建池先看缓存（v1.6.0）**：swarm_plan 返回的 cache_hints 携带历史完成任务的 result 与 anchors（相似度 >=90%）。能复用就直接复用，或只派增量任务，不要重复造轮子。

12. **【动态拆分与防阻塞协议】——Worker 的自我评估呼救 + Lead 的强制拆分。**
    调度器最怕的不是任务失败，而是**一个任务闷头占着 slot 把整条依赖链拖死**。解耦办法是让 Worker 自己认输，让 Lead 被迫重拆。

    **对 Worker 的强制约束（写进派发消息）：**
    调用 swarm_start 之后，一旦发现下面任意一条，**严禁死磕**：
    - 需要修改的文件超过 3 个；
    - 预计代码逻辑超过 200 行；
    - 连续修复编译错误或测试失败达到 2 次仍然不过。
    此时立刻调用 swarm_escalate（参数 task_id / agent_id / reason），reason 写成 "Task too large, needs decomposition" 并附上当前报错原文，然后**停止工作、保持静默**——不要再改文件、不要 send_message、不要试图「再试最后一次」。

    **对 Lead 的强制约束：**
    在 swarm_status 里看到 blocked 且 reason 含 "Task too large" 的任务时，**禁止原样重派**（重新 swarm_start 或 release 让它被原样领走都算违规）。必须：
    - 用 swarm_plan 把它拆成 **2-4 个更小的任务**（每个都能独立验收、写范围互不重叠）；
    - 用 blocked_by 把拆出来的任务与原任务的前置依赖接好；
    - 原任务标记为不再使用（或作为汇总节点），再唤醒空闲 Worker 去领新任务。
    拆分时注意：新任务各自的 write_scopes 必须互不重叠，否则它们会互相 scope_conflict。

    **配套的超时高亮**：swarm_plan 支持给任务设 max_duration_ms（毫秒，0 = 不限）。swarm_status 会对运行超过该预算的 running 任务在行尾标 [OVERDUE]。OVERDUE 与 STALE 不同——STALE 问「人还在吗」，OVERDUE 问「是不是比预期久太多了」，心跳正常的任务也可能 OVERDUE。看到 OVERDUE 说明该拆、该延长预算、或该打断，而不是等它自己结束。

13. **【负载均衡与强制唤醒铁律】。**
    这是 Lead 的单点故障防线：多 Agent 并行的意义是**并行**；把一个 Worker 塞满、让其他 Worker 全程 inactive，等于把调度器退化回单线程。
    1. 作为 Lead，在通过 swarm_plan 建池后，或者池子中有新的 ready 任务时，你严禁直接放任不管。
    2. 必须调用 list_agents 检查当前所有 Worker 的状态。
    3. 只要有处于 inactive 状态的 Worker，且池中有 ready 任务，你**必须立刻调用 send_message 唤醒它们**，让它们去 swarm_ready 领任务。
    4. 严禁将多个任务连续派给同一个 Worker。如果一个 Worker 正在 running，而池子里还有 ready 任务，你必须把它派给下一个 inactive 的 Worker。
    5. 如果你发现唤醒了 Worker，但它们没有领到任务（因为能力不匹配被拒），请立刻检查 worker_profiles 配置，或者调整任务的 required_capabilities。

14. **【Whisper 信箱】——不打断的调度通道。**
    - 想给某个 Worker 追加指示、又不想打断它当前轮次时，用 swarm_whisper(worker_id, message, from) 把话写进池子的 inbox/<worker_id>.json，而不是 send_message。一条 whisper ≤ 1000 字符：它是「下次开工先看一眼」，不是第二份任务书。
    - Worker **每 3 步（以及每个任务开始前后）调一次 swarm_inbox(worker_id)** 检查信箱。它是 **ack 语义**：读一次即清空，第二次读只会返回新写入的那批；不要把重复读取当成确认。
    - 需要**立刻唤醒、改派或中断**，仍然用 send_message；whisper 只在「不该叫醒的时候」使用。

15. **【提交规范】——产物落盘，摘要 10 字。**
    - **严禁用 send_message 发送长代码或长报告**：代码和文档写进仓库文件，结论写进 swarm_complete(result=...)，≤4000 字符，理想是 10 字左右的一句话 + 关键路径。
    - 调用 swarm_complete 时附 **2-3 个 anchors**（例如 dsh-swarm-scheduler/src/core/task-store.ts:claimTask）：锚点必须是能被 swarm_recall 命中的持久定位符，不能是「已完成」这类描述。写任务前先 swarm_recall(锚点/关键词)，别重复解决别人已经解决过的问题。
    - 长交接（表格、权衡、被否掉的方案）放进仓库里的 handoff 文件，并在 result 里写它的路径。

16. **【派发与知识边界】。**
    - 派发消息**不带主会话历史**：Worker 看不到你这一轮的上下文，所以消息必须自包含（任务 id、写范围、验收命令、依赖关系）。
    - Worker 不确定某个 API/字段存不存在时，**直接读源码**（src/core/*.ts 与工具定义），不要猜；猜出来的字段会让 tsc 或测试变红。
    - **不存在任何自动模型降级/自动换模型**：调度器不认识 provider，也不会自作主张换模型。swarm_status 行尾的 [ROUTING] Task X on <model|inherit> 只是**记录**；同一任务连续失败两次会置 needs_upgrade=true，而「换成一个更强的模型/Worker」是 **Lead 唯一允许的替换动作**，必须由你显式执行——它绝不会自动发生。

17. **【代码洁净与无注释红线】。**
    这是硬门禁（配置项 forbid_inline_comments，默认开启）：每次成功完成会审计 write_scopes 内**新增**的行，新增行内注释达到 2 行即打回 blocked。
    - 严禁解释性/辩解性行内注释：「// TODO」「// 暂时这样」「// 这里可能有问题」一律不允许。注释无法被执行，因此无法被验证——**无法被执行的注释，就是未被验证的谎言。**
    - 代码必须自解释：命名与结构能表达清楚的，就不要写注释；设计意图必须写进 swarm_complete 的 anchors，不得写进代码文件。
    - 只允许函数级标准 JSDoc 签名（/** ... */），不得用它写实现说明、变更日志或辩解。
    - 如果你发现需要长注释才能看懂，说明任务过大或拆解不彻底：立即 swarm_escalate 退回并说明原因，不要用注释掩盖复杂度。

不要自己领任务、不要自己做具体编码。你的角色是调度者。`

/**
 * `apply` MUST be synchronous.
 *
 * This loader never awaits `apply`: an async apply silently never runs its body
 * while the entry still reports `fiberPhase: active`. All asynchronous work here
 * happens inside tool calls, never during activation, and the one promise
 * started from `apply` carries its own contained failure handling.
 */
export function apply(ctx: Context, config: SwarmConfig) {
  try {
    /**
     * Base for the pool's relative paths.
     *
     * Throws when `tasksRoot` is empty (v0.2.7). The old fallback to
     * `process.cwd()` put the pool in the profile directory — NOT the session
     * workspace — and did it silently, which is the failure mode this plugin
     * keeps warning about in its own documentation. Throwing here means the
     * `catch` below records the reason and the fiber reports `failed`, so the
     * omission surfaces at activation rather than at "where did my tasks go".
     */
    const cwd = resolveTasksRoot(config.tasksRoot)
    // The core layer takes the filesystem slice, not the Cordis context: that is
    // what keeps `src/core/` free of `@deepseek-ai/*` imports.
    const store = new TaskStore(ctx.get('fs') as FsLike | undefined, cwd)
    const disposers: Array<() => void> = []

    // A negative or non-finite threshold would make every claim look stale (or
    // none); clamp to 0 meaning "do not judge", which is the safe reading.
    const staleAssignmentSec = Number.isFinite(config.staleAssignmentSec) && config.staleAssignmentSec > 0
      ? config.staleAssignmentSec
      : 0
    registerFileTools({
      ctx,
      store,
      staleAssignmentSec,
      max_workers: config.max_workers,
      worker_tiers: config.worker_tiers ?? {},
      worker_profiles: config.worker_profiles ?? {},
      quality_gate_command: config.quality_gate_command ?? '',
      forbid_inline_comments: config.forbid_inline_comments ?? true,
      disposers,
    })

    // Best-effort directory creation. `ctx.fs` has no mkdir in the slice this
    // plugin uses, so `ensureDir` writes a sentinel through the filesystem; a
    // failure is reported on every later result rather than thrown here.
    void store.ensureDir().catch(() => undefined)

    /**
     * Event-driven watchdog (v0.9.0).
     *
     * `agent/status` is a real harness event (emit mode, `idle` ⇄ `running`, no
     * service injection needed), so the pool can be reaped without a human
     * remembering `swarm_reap`. Two guards keep that from becoming a hazard:
     *
     *   - only `idle` schedules work — `running` is the common transition and
     *     reaping on it would compete with the agent that is doing the work;
     *   - the schedule is debounced two seconds, so a burst of idle events from
     *     several agents collapses into one scan.
     *
     * The reap itself runs in the background: this listener must return
     * immediately, because the harness emits the event on its own critical
     * path. Every failure is contained and logged, never thrown into the event.
     * `config.auto_reap: false` restores the manual-only behaviour.
     */
    if (config.auto_reap !== false) {
      let reapTimer: ReturnType<typeof setTimeout> | undefined
      const runAutoReap = (): void => {
        void autoReap(store, staleAssignmentSec).then(result => {
          if (result.reaped.length > 0) {
            debugLog(config.debugLogPath, `AUTO REAP ${result.reaped.length} task(s); ready=${result.ready}`)
          }
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          debugLog(config.debugLogPath, `AUTO REAP FAILED ${message}`)
        })
      }
      const scheduleAutoReap = (): void => {
        if (reapTimer !== undefined) clearTimeout(reapTimer)
        reapTimer = setTimeout(() => {
          reapTimer = undefined
          runAutoReap()
        }, AUTO_REAP_DEBOUNCE_MS)
      }
      try {
        const off = ctx.on('agent/status', (payload: { status?: string }) => {
          if (payload?.status === 'idle') scheduleAutoReap()
        })
        disposers.push(() => {
          if (reapTimer !== undefined) clearTimeout(reapTimer)
          off()
        })
        debugLog(config.debugLogPath, `AUTO REAP LISTENER OK debounce=${AUTO_REAP_DEBOUNCE_MS}ms stale=${staleAssignmentSec}s`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        debugLog(config.debugLogPath, `AUTO REAP LISTENER FAILED ${message}`)
      }
    }

    /**
     * Publish the dispatch protocol.
     *
     * This registration doubles as the service probe, and that is deliberate:
     * `section()` and a passive `ctx.get('systemPrompt')` read test the SAME
     * fact — whether the service is reachable from this fiber — but only
     * `section()` produces the feature when it succeeds. A passive probe would
     * have cost an extra restart to learn what a successful call already proves.
     *
     * The failure handling is what makes that substitution safe: this block has
     * its own `catch`, so if the call throws, the reason is recorded and the
     * five tools below still register. Nothing here can silently disable the
     * tools, and nothing here can swallow the reason.
     */
    try {
      const section = ctx.systemPrompt.section({
        name: PROTOCOL_SECTION,
        order: PROTOCOL_ORDER,
        text: PROTOCOL_TEXT,
      })
      // Registration returns the exact Cordis effect disposer; ownership is
      // transferred to the same list the tools use, so one teardown path
      // releases every resource this plugin holds.
      disposers.push(section)
      debugLog(config.debugLogPath, `PROMPT SECTION OK name=${PROTOCOL_SECTION} order=${PROTOCOL_ORDER} chars=${PROTOCOL_TEXT.length}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLog(config.debugLogPath, `PROMPT SECTION FAILED ${message}`)
    }

    ctx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose()
    })

    debugLog(config.debugLogPath, `APPLY OK pool=${TASKS_DIR} root=${cwd} (source=config.tasksRoot)`)
  } catch (error) {
    // Record the real failure, then rethrow so the fiber still reports `failed`
    // and the failure stays observable.
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? (error.stack ?? "(no stack)") : "(not an Error)"
    debugLog(config.debugLogPath, `APPLY FAILED ${message}\n${stack}\n---`)
    throw error
  }
}
