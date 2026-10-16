import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import { Config, type Config as SwarmConfig } from './config.js'
import { TaskStore, TASKS_DIR } from './task-store.js'
import { registerFileTools } from './tools-file.js'

export const name = 'dsh-swarm-scheduler'
export { Config }

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

2. 用 list_agents 查看有没有空闲的 teammate（status 为 inactive 的）。
   有空闲的 → 直接 send_message 唤醒它们，不要新建。
   没有空闲的 → 用 spawn_teammate 创建 2-3 个。

3. 给每个 worker 发一条 send_message，消息里只说：
   "去 swarm_ready 查就绪任务，swarm_claim 自领，做完用 swarm_complete 回报，然后回到 swarm_ready 再拉一圈，直到 swarm_ready 返回 0。"

4. 不要指定具体任务给 worker。谁领到哪一个是原子竞争的结果。

5. 用 swarm_status 查看整体进度，向用户汇报。

6. 如果 worker 在执行中撞到依赖冲突（比如两个任务要改同一个文件、或者串行链在规划期没声明），它会通过 send_message 报告你。你收到报告后，用 swarm_set_deps 调整任务的 blocked_by，把冲突的任务串行化。依赖调整只由你做，不要让 worker 自己改。

7. 定期用 swarm_status 查看进度。如果某个任务被标为 STALE（claimed 时间超过阈值，可能 worker 卡死或消失），用 swarm_release 释放它，让其他 worker 能重新领取。

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
     * `process.cwd()` is the profile directory in this deployment — NOT the
     * session workspace — so an empty `tasksRoot` is only a safe fallback for
     * deployments that happen to launch from the workspace they schedule.
     * Real deployments set `tasksRoot` explicitly.
     */
    const cwd = config.tasksRoot.trim().length > 0 ? config.tasksRoot.trim() : process.cwd()
    const store = new TaskStore(ctx, cwd)
    const disposers: Array<() => void> = []

    // A negative or non-finite threshold would make every claim look stale (or
    // none); clamp to 0 meaning "do not judge", which is the safe reading.
    const staleAssignmentSec = Number.isFinite(config.staleAssignmentSec) && config.staleAssignmentSec > 0
      ? config.staleAssignmentSec
      : 0
    registerFileTools({ ctx, store, staleAssignmentSec, disposers })

    // Best-effort directory creation. `ctx.fs` has no mkdir in the slice this
    // plugin uses, so `ensureDir` writes a sentinel through the filesystem; a
    // failure is reported on every later result rather than thrown here.
    void store.ensureDir().catch(() => undefined)

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

    debugLog(config.debugLogPath, `APPLY OK pool=${TASKS_DIR} root=${cwd} (source=${config.tasksRoot.trim().length > 0 ? 'config.tasksRoot' : 'process.cwd()'})`)
  } catch (error) {
    // Record the real failure, then rethrow so the fiber still reports `failed`
    // and the failure stays observable.
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? (error.stack ?? "(no stack)") : "(not an Error)"
    debugLog(config.debugLogPath, `APPLY FAILED ${message}\n${stack}\n---`)
    throw error
  }
}
