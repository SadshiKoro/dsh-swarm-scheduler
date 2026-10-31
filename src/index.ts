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
   "去 swarm_ready 查就绪任务，swarm_claim 自领，swarm_start 开工，做完用 swarm_complete 回报（失败时 success=false，成功时可附带 actual_tokens / duration_ms 供性能统计），然后回到 swarm_ready 再拉一圈，直到 swarm_ready 返回 0。预计耗时超过 staleAssignmentSec 一半的任务，running 期间每隔一段时间调一次 swarm_heartbeat 续约。如果你发现自己搞不定（缺关键文件、代码冲突无法解决、需求本身需要重新规划），不要硬写假代码，调用 swarm_escalate 把任务挂起（状态变 blocked，原因写进 failure_reason），让 Lead 重新规划。"

4. 不要指定具体任务给 worker。谁领到哪一个是原子竞争的结果。

5. 用 swarm_status 查看整体进度，向用户汇报。

6. 如果 worker 在执行中撞到依赖冲突（比如两个任务要改同一个文件、或者串行链在规划期没声明），它会通过 send_message 报告你。你收到报告后，用 swarm_set_deps 调整任务的 blocked_by，把冲突的任务串行化。依赖调整只由你做，不要让 worker 自己改。
   如果收到 worker 的呼救（swarm_escalate），任务会以 blocked 状态出现并在 failure_reason 里写明原因；用 swarm_status 查看，再决定改需求、补依赖或重新拆解。需要从某个 Worker 手里强行收回任务时，用 swarm_escalate(force: true)。
   注意：失败率过高（失败次数 > 3 且失败率 > 50%）的 Worker 会被拒绝领取 complexity=high 的任务（worker_unreliable），但 low/medium 仍对它开放——这是有意的「练手与翻身」通道。

7. 看到 failed 的任务时，判断是否重试：可以再发一条 send_message 让 worker 重新 swarm_start 该任务（failed 任务可直接 start），或用 swarm_release 把它放回 pending 让别人重领。retry_count 达到 max_retries 后会变成 blocked，此时需要人工介入或调整拆解。

8. 定期用 swarm_status 查看进度。如果某个任务被标为 STALE（claimed/running 超过阈值，可能 worker 卡死或消失），先确认 worker 是否还能续约；确实无响应再用 swarm_reap 自动回收（claimed 回 pending、running 标 failed 走重试），或按需用 swarm_release 释放个别任务。正在跑长任务的 worker 应主动调 swarm_heartbeat，避免被误回收。

9. 并发上限由 max_workers 控制（默认 3）。swarm_ready 在 claimed+running 达到上限时返回 0，这是正常现象，等已有任务完成后再拉。

10. **质量门禁（若部署配置了 quality_gate_command）**：Worker 交付的代码必须在提交前就能通过该命令，否则即使 swarm_complete 传了 success:true 也会被自动打回为 failed（retry_count + 1），并在 failure_reason 里带上命令输出的前 500 字符。因此：
    - 在**任务描述里把验收命令写清楚**（例如「验收：npm test 与 npx tsc --noEmit 均通过」），让 Worker 知道门禁会跑什么。
    - 不要把一个改动范围会导致工作区无法构建或测试变红的小任务并行派出去——门禁是按整块工作区判定的，别人的红也会记在你的任务上。
    - Worker 收到 failed 不是「result 被丢了」，而是「工作区没通过」；让它修好工作区后重试，不要靠改写 result 绕过。

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
