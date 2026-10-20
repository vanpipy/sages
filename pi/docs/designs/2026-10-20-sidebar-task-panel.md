# pi-sidebar 独立任务面板 — 调查与考量记录

> **状态**：brainstorming / grilling，**未定稿**。最后一个问题未回答，下游设计全部悬置。
> **日期**：2026-10-20
> **范围**：让 `pi-sidebar/` 拥有自己的、完整的任务扩展，能力对等 `pi-tasks/`，取代当前"复制 pi-tasks 读取逻辑"的做法。
> **本文性质**：调查记录 + 考量过程，**不是**设计文档。所有 `file:line` 均在 2026-10-20 的 `main`（`df06c04`）上实测核对过。

---

## 1. 起点

原话："当前 sidebar 只是复制了 ./pi-tasks/ 和任务。现在我们需要一个独立的 sidebar task panel。"

拆开就是三件事：

1. `pi-sidebar/extensions/sidebar/sections/tasks.ts`（442 行）与 `pi-tasks` 重叠的部分要消除
2. sidebar 要成为**独立**的任务扩展，不是 pi-tasks 的消费者
3. **main agent 的 TaskStore 与 sidebar 的 TaskStore 必须是两块彼此独立的板**，不能指向同一个文件

第 3 条是后加的约束，它推翻了本文 §7 中间推荐过的一个方案（见 §9）。

---

## 2. 重复清单

`pi-sidebar/extensions/sidebar/sections/tasks.ts` 与 `pi-tasks` 的重叠：

| sidebar 侧 | pi-tasks 侧 | 风险 |
|---|---|---|
| `Task` 类型 `types.ts:20` | `pi-tasks/src/types.ts:24` | 类型漂移 |
| `projectKey` `tasks.ts:41` | `task-paths.ts:50` | **静默失败**，仅靠一个测试保字节一致 |
| `orchestratorWorkdir` `tasks.ts:49` | `task-paths.ts:36` | 同上 |
| `parseTasksJson` `tasks.ts:69`（55 行） | `normalizeTask` `task-store.ts:91` | 校验规则分叉 |
| `resolveTasksSource` `tasks.ts:206` | `sessionTaskFile` `task-paths.ts:72` / `orchestratorProjectTaskFile` `:90` | scope 解析分叉 |
| `readWorkspaceTasks` `tasks.ts:247` | `TaskStore` + `withLock` `task-store.ts:174` | **幽灵任务 bug 的源头** |

注：`countTasks:131` / `toTaskRows:166` / `renderTasksSection:411` 是纯展示逻辑，pi-tasks 没有对应物，**不该**被当作重复消除。

### 2.1 不是重复的部分

两套字形表语义不同，sidebar 应保留自己的：

| | pi-tasks `task-glyphs.ts:54` | sidebar `tasks.ts:350` |
|---|---|---|
| completed | `✔` | `✓` |
| in_progress | `◼` | `◼` |
| pending | `◻` | `▷` |
| blocked | `›` | `⌥` |
| intent | *不存在* | `◌` |

pi-tasks 根本没有 `intent` 这个显示状态。

---

## 3. 三条硬约束

1. **pi-sidebar 不是 workspace member。** `install.sh:236-237` 定义源与目标，`install_pi_sidebar_files`（`install.sh:1864`）用 `tar` 管道做文件拷贝并显式 `--exclude='./node_modules'`，注释里明确说明**不跑 `bun install`**。部署后无 `node_modules`。"零 `@sages/*` 导入"是显式维护的不变量。
2. **pi-tasks 也不在 `workspaces` 数组里。** 根 `package.json:6-12` 只有 `pi-orchestrator` / `pi-subagents` / `pi-codebase-memory` / `pi-evaluator` / `pi-routines`。pi-tasks 靠 `node_modules/@sages/pi-tasks -> ../../pi-tasks` 手工符号链接 + `pi-orchestrator/package.json:35` 的 `"file:../pi-tasks"` 解析。**仓库里已存在一处不一致**（pi-routines 在数组里、无符号链接），别再加一处。
3. **7 个包都部署成 `~/.pi/packages/` 下的兄弟目录**，pi-tasks 与 pi-sidebar-sages 只差一层路径。

## 4. 两个有利条件

- **通用 RPC 已存在。** `pi-subagents/src/cross-extension-rpc.ts:92` 的 `registerRpcHandlers` 只是 `handleRpc(events, channel, handler)` 的薄封装，任何扩展都能注册自己的 channel 并被对端 `rpcCall` 调用（pi-tasks 已在 `index.ts:257` 用它调 pi-subagents）。
- **push 通道已通。** pi-tasks 在 `index.ts:361`（任务完成 → `log`）和 `index.ts:1434`（subagent spawn → `highlight`）推 `sidebar:event`。但推的是**通知片段**不是**状态**，sidebar 收到后仍要自己读文件补全。

---

## 5. 实测一：能否直接 import pi-tasks

建探针文件从 pi-sidebar import pi-tasks，四种场景：

| 场景 | 结果 |
|---|---|
| 仓库内 `npx tsc --noEmit` | 通过 |
| 仓库内 `bun` 运行 | 通过，`projectKey` 与路径解析均正确 |
| 部署后**无** `node_modules`（现状） | `Cannot find module '@sages/pi-tasks/task-paths'` |
| 部署后**加**符号链接 | 通过，解析到 `~/.pi/packages/pi-tasks` |

需要的全部代价，`install.sh` 加一行：

```bash
mkdir -p "$PI_SIDEBAR_DEST_DIR/node_modules/@sages"
ln -sfn ../../../pi-tasks "$PI_SIDEBAR_DEST_DIR/node_modules/@sages/pi-tasks"
```

（相对层级：symlink 位于 `.../pi-sidebar-sages/node_modules/@sages/`，上溯三级到 `packages/`，故为 `../../../pi-tasks`。）

**符号链接不是 install。**"不跑 `bun install`、不落地 node_modules"这条不变量完全存活。

不需要新增 subpath export，现有三个够用：

```ts
import { TaskStore, type Task, type TaskStatus, type TaskType } from "@sages/pi-tasks/task-store";
import { projectKey, orchestratorProjectTaskFile, sessionTaskFile } from "@sages/pi-tasks/task-paths";
```

`task-store.ts:17` 已 `export type { Task, TaskStatus, TaskStoreData, TaskType }`。

> ⚠️ **只能 import subpath。** 绝不能 import `"@sages/pi-tasks"`（`.` 那个），它就是扩展工厂，import 会在 sidebar 里二次注册 7 个工具。

开发期还需给 pi-sidebar 补一条 `"@sages/pi-tasks": "file:../pi-tasks"` 到 devDependencies，保证干净 clone 也能解析。

---

## 6. 实测二：TaskStore 的多板能力

```
main    sees: [ "1:plan:main agent task" ]
sidebar sees: [ "1:intent:sidebar task" ]
independent? true
after main.clearAll() -> main: 0 sidebar: 1
sidebar file survived: true 1 task(s)
```

两个实例各自 `nextId` 从 1 开始、ID 空间互不干扰、`clearAll()` 不波及对方、锁文件独立。

| 能力 | 支持？ | 证据 |
|---|---|---|
| 多个**彼此独立**的板子 | **本来支持** | 构造函数接受任意绝对路径 `task-store.ts:113-122` |
| 一个 store **读多个文件** | **不支持** | `filePath` / `lockPath` 是标量 `:106-107`；`load()` 只读一个 `:135`；`save()` 只写一个 `:162` |
| 每实例独立锁 | 支持 | `lockPath = filePath + ".lock"` `:120` |

**结论：「允许指向多个文件」这个扩展，只在需要「一个 panel 同时显示两块板」时才必要。** 只要是"两块板各自独立"，现状已经够用。

### 6.1 不建议改 TaskStore 的单文件语义

`save()`（`:161-171`）的 tmp + `renameSync` 原子写依赖单一路径；`withLock`（`:174`）的锁令牌模型同理。若真要支持多文件，更安全的做法是**在 panel 层聚合**（两个实例各自读、sidebar 合并渲染），而不是把多路径语义塞进 store。

### 6.2 顺带可删

`readWorkspaceTasks`（`tasks.ts:247`）是手搓的多文件合并读取器。若每块板对应单个 `TaskStore`，这段直接删除，今天幽灵任务（`.pi/tasks/` 里两个月前的残留 completed 任务渲染成 `2/2 ✓`）的根因随之消失。

---

## 7. 曾提出并被推翻的方案（保留记录）

| 轮次 | 方案 | 结局 |
|---|---|---|
| Q1 | RPC 拉取快照（pi-tasks 注册 `tasks:rpc:snapshot`） | 用户澄清要的是 sidebar **独立拥有**任务扩展，不是消费 pi-tasks → 作废 |
| Q2 | 直接 import `@sages/pi-tasks` 子路径 | 我当时判定"破坏部署不变量" → **实测证伪**，符号链接不是 install |
| Q2 | pi-sidebar 自建 `TaskStore` 指向**同一文件** | 与用户 §1.3 的独立性约束冲突 → 作废 |
| Q1 | pi-tasks 退役、能力整体搬进 pi-sidebar | 用户未采纳（反问"不能直接使用 pi-tasks 吗"），实际是保留 pi-tasks 并让 sidebar 直接依赖它 |

---

## 8. 未决问题（阻塞后续全部设计）

sidebar 那块**独立板**里装什么？谁写入？

- **(a) 用户自己的任务** —— 与 agent 工作流无关的个人清单，需要给 sidebar 加独立写入工具
- **(b) agent 工作的持久记录** —— 主板有 `autoClearCompleted`（`pi-tasks/src/auto-clear.ts`），完成任务会被清掉，主板永远没有历史；独立板不参与清扫，能留住跨会话记录。可由 pi-tasks 在完成时**单向写一条**过去（状态仍不共享，独立性成立）
- **(c) 两者都要**，用 `type` 或标记区分
- **(d) 其他**

(a) 与 (b) 实现差别很大。未回答前不进入设计。

次级问题（可在主问题定后一并确认）：

1. sidebar 的 store 是否**只读**？（倾向是：sidebar 严格保持"被动可视面"，不成为第二个 writer）
2. sidebar 板的路径？候选：`new TaskStore("sidebar")` → `~/.pi/tasks/sidebar.json`；或按项目隔离的绝对路径
3. 若走 (b)，pi-tasks → sidebar 板的单向写入在 `TaskStore` 之外还是之内？

---

## 9. 顺带发现：learn 文档已漂移

不在本次范围内，但调查时核对发现，记录备查。

`pi/docs/learn/` 的 `file:line` 引用已指向错误的代码（`pi/docs/learn/README.md:45` 明确说这些引用是契约）：

| 文档声称 | 实际 |
|---|---|
| `pi-sidebar/extensions/sidebar.ts` 594 行 | 859（改前） |
| `pi-sidebar/.../utils.ts` 74 行 | 149 |
| `pi-sidebar/tests/sidebar.test.ts` 1441 行 / 65 测试 | 1822 / 88 |
| `pi-tasks/src/index.ts` 1431 行 | 1623 |
| `sidebarPlugin` 在 `:194` | `:430`（改前） |
| `SidebarComponent` 在 `:103` | `:339`（改前） |
| `TaskCreate` 在 `:628` / `TaskExecute` 在 `:1165` | `:802` / `:1339` |

成因：`7dc7f5d`（shrink-to-fit，+169 行）、`b6ddb51`、`df06c04` 三个提交晚于 `344989a`（写文档）和 `b6ddb51`（更新文档）。散文部分描述新代码是对的，**过期的是头部行数与符号表**。

另注：两个包的测试运行器都是 **vitest**，不是 `bun test`。用 `bun test` 跑 pi-tasks 会得到 28 个假失败（`global-setup.ts` 与 vitest `configLoader` 不会加载）；正确运行器下 444/444 通过，pi-sidebar 88/88（改动后 92/92）。

---

## 10. 已完成的改动（与本记录同批）

autohide 默认值翻转，见 §9 之外的独立变更：

| 文件 | 改动 |
|---|---|
| `pi-sidebar/extensions/sidebar.ts` | 新增导出 `autohideWorkingFromEnv(env?)`（`:187`），默认 `false`；调用点 `:475` |
| `pi-sidebar/extensions/sidebar/types.ts` | `isStreaming` 注释补充"turn_end 只在整个工具批次结束后才触发" |
| `pi-sidebar/tests/sidebar.test.ts` | 新增 `autohide default from env` 4 个测试 |
| `pi/docs/learn/pi-sidebar.md` | 重写 autohide 章节 + 修正过期的 `sidebar.ts` 行号引用 |

原因：pi 的 turn 跨越整个工具批次（`pi-agent-core/dist/agent-loop.js`：`turn_start:113` → `streamAssistantResponse:141` → `executeToolCalls:165` → `turn_end:180`），`turn_end` 只在所有工具调用返回后才发。原默认 `true` 导致面板在整个工作期（含 subagent 派发）隐藏，恰好与"工作期被动看板感知"的定位相反。

已用 `tar` 同步到 `~/.pi/packages/pi-sidebar-sages`。**需重启 pi 才生效。**