# v0.9.0 E2E 压测证据（scope_conflict 闭环）

本文件是 v0.9.0 全链路压测中 **write_scopes 冲突拦截** 的闭环证据留档。
所有条目都是运行时原文回执，未经改写；时间戳来自 `.dsh-tasks/*.log`。

压测日期：2026-10-31 · 调度器：`dsh-swarm-scheduler-beta` v0.9.0 · 任务池：`.dsh-tasks/`

---

## 1. 为什么需要重建探针：原始设计跑不出冲突

任务池最初按「D 与 A 故意共享 `src/utils/`」来验证 scope 冲突。这个设计**从机制上就无法产生样本**：

- `findScopeConflict` 只扫描 `status === 'claimed' || status === 'running'` 的任务；
- A 完成后锁即释放，D 才被领取 —— 二者**从不同时在场**；
- 因此 D 的 claim 一路放行，返回 `completed`。

两个独立来源确认了这一点：

- `worker-docs`（D 的执行者）在 result 里写：
  > Claim succeeded without scope_conflict because e2e-A-core was already completed,
  > so no overlapping claim was held.
- `worker-gamma` 收工时独立给出同样判断，并建议重造「同时在场（都 claim 不 complete）」的一对任务。

**教训**：验证锁，必须让锁同时被两个 claimant 争抢。串行依赖的任务永远测不到冲突。

---

## 2. 受控探针组（`e2e-evidence`）

持锁端 `e2e-S1-guard` 先 claim 并保持 `claimed`（不 start、不写文件），三个被测端在持锁期间依次 claim：

| 探针 | write_scopes | 与持锁端关系 | 预期 | 实测 |
|---|---|---|---|---|
| `e2e-S1-guard` | `dsh-swarm-scheduler/src/index.ts` | 持锁端 | claim 成功 | ✅ claimed |
| `e2e-S2-same-file` | `dsh-swarm-scheduler/src/index.ts` | 同文件精确重叠 | 拒绝 | ✅ scope_conflict |
| `e2e-S3-ancestor` | `dsh-swarm-scheduler/src/` | 祖先目录 ⊃ 文件 | 拒绝 | ✅ scope_conflict |
| `e2e-S4-非重叠反例` | `dsh-swarm-scheduler/src/utils/` | 与 index.ts 无祖先关系 | 放行 | ✅ claimed |

### 2.1 同文件精确重叠 → 拒绝

```
REJECTED scope_conflict: e2e-S2-same-file refused: write scope "dsh-swarm-scheduler/src/index.ts"
overlaps "dsh-swarm-scheduler/src/index.ts" of e2e-S1-guard (held by lead).
Serialise them with swarm_set_deps, or make the scopes narrower.
建议将 write_scopes 缩小到具体文件，或用 swarm_set_deps 串行化。
```

### 2.2 祖先目录 → 拒绝

```
REJECTED scope_conflict: e2e-S3-ancestor refused: write scope "dsh-swarm-scheduler/src/"
overlaps "dsh-swarm-scheduler/src/index.ts" of e2e-S1-guard (held by lead).
Serialise them with swarm_set_deps, or make the scopes narrower.
建议将 write_scopes 缩小到具体文件，或用 swarm_set_deps 串行化。
```

### 2.3 非重叠反例 → 放行（关键对照）

```
OK claimed: e2e-S4-非重叠反例 claimed by lead
```

这一条是**反例对照**，价值不低于前两条：它证明判定不是字符串前缀匹配。
`src/utils/` 与 `src/index.ts` 共享 `src/` 前缀，但 `index.ts` 并不在 `utils/` 之下，因此**不冲突**。

规则实现见 `src/core/scope.ts:36`：

```ts
if (left === right) return true
return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
```

即 **等值 或 祖先/后代**，两侧都带 `/` 边界，所以 `src/utils` 与 `src/utilsX` 不会被误判重叠。

> 压测初期曾误把 `src/utils/` 当成「会拦截 `src/index.ts`」，即源于把该规则想象成了裸前缀匹配。
> 本反例把这一误解固定下来，避免 v1.0.0 修改 scope 逻辑时回归。

---

## 3. 未验证项（明确标记，勿当作已通过）

- **`ctx.fs` 与 `node:fs` 混用下的 claim 锁原子性**：本轮所有调度调用都带
  `degraded: ctx.fs refused the claim lock under the sandbox; using node:fs`，
  claim 锁与任务写盘均走 `node:fs` 回退路径。
  理论上存在「一侧看到锁文件、另一侧看不到」的可见性分裂风险，但**本轮并发度最高仅 2，
  未观察到任何 `already_claimed` 误判或双领**。样本量不足以证伪，故标记为未验证。
- **`scope_conflict` 的并发竞态分支**：`task-store.ts:898-923` 的「lock 文件存在但状态未落盘」
  分支未被触发。本轮验证的是 `findScopeConflict` 主分支（状态已落盘）。

---

## 4. 复现方式

```bash
# 1. 建立持锁端并 claim
#    write_scopes: ["dsh-swarm-scheduler/src/index.ts"]

# 2. 在持锁端保持 claimed 期间，claim 同文件任务 → 必须返回 scope_conflict
# 3. claim 祖先目录任务   → 必须返回 scope_conflict
# 4. claim 非重叠任务     → 必须返回 OK claimed
```

探针任务完成后应从池中清除（`e2e-S*.json` / `.log` 及残留锁文件），不要留在正式任务池里。
