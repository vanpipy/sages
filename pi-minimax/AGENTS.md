# AGENTS.md

> 给未来 LLM agent 的项目说明。读这个文件来理解 pi-minimax 的工作约定。

## 项目性质

`pi-minimax` 是一个 **pi extension npm 包**，把 MiniMax AI 平台的官方 CLI (`mmx-cli`) 包装为 **2 个 pi 工具**（auth + search），并通过 `mmxc-cli` skill 让 LLM 直接用 `mmx` 二进制调用其他 modalities。**与 pi-yunxiao 同模式**（独立包 + 拷贝部署），但架构更简单（**stateless shell-out**，无 daemon）。

2026-07-19 简化：移除了 `minimax_exec`（L1 逃生口）。LLM 现在通过 AFT-backed `bash` 工具 + `mmxc-cli` skill 直接运行其他 mmx 子命令。理由：

- 移除后 pi-minimax 体积减半（10 → 7 测试文件，~1100 → ~700 LOC）
- 不再与 mmx-cli's own SKILL.md 重复
- bash 工具 + agent skill 已经提供完整 surface

## 关键约定

### 1. 安装与部署

- **源位置**：`~/Project/sages/pi-minimax/`（git 仓库内，是 sages 的子目录）
- **运行时位置**：`~/.pi/packages/minimax/`（pi 实际加载）
- **同步命令**：`./scripts/install.sh --force`
- **scripts/ 不拷到运行时**（与 pi-yunxiao 相同的决策 C）
- **RUNTIME_DIRS**：`prompts` `skills` `extensions` `src` + `package.json` + `tsconfig.json`
- **mmx-cli 必须独立安装**：`npm install -g mmx-cli`（用户责任，不是我们打包）
- **mmxc-cli skill 推荐安装**：`npx skills add MiniMax-AI/cli -y -g`（让 LLM 知道完整的 mmx 命令表面）

### 2. 工具分层（与 pi-yunxiao 的 L0/L1/L2 同名但语义不同）

| 层 | 工具 | 用途 |
|---|---|---|
| L0 | `minimax_auth_status` | 检查 mmx 认证状态；自动从 `MINIMAX_API_KEY` env bootstrap |
| L2 | `minimax_search_query` | Web 搜索（mmx search query --q） |

**之前有 L1 `minimax_exec`（逃生口）— 2026-07-19 移除**。现在所有其他 modalities（text/image/video/speech/music/vision/quota/file）通过 AFT-backed `bash` 工具调用 `mmx <resource> <command> [flags]`，LLM 通过 `mmxc-cli` skill 学会 surface。

**剩余工具在 execute 之前仍必须调用 `ensureAuth()`**。这是 auth-bootstrap 服务的唯一入口。

### 3. 状态目录

`~/.pi/packages/minimax/` 是运行时副本。**不要在运行时目录直接修改** — 用 `./scripts/install.sh --force` 同步源。

mmx-cli 自己的状态在 `~/.mmx/`：
- `config.json` — 持久化的 api_key 和 region
- `credentials.json` — OAuth token（mmx-cli 自己管理）

### 4. Token 管理

- **优先级**：`mmx_exec({apiKey: "..."})` 参数 > `mmx --api-key` 标志 > `~/.mmx/config.json` > `MINIMAX_API_KEY` env（自动 bootstrap）
- **bootstrap 行为**：当 `mmx auth status` 报告 unauthed 且 env 有 `MINIMAX_API_KEY`，自动 `mmx auth login --api-key $KEY --non-interactive`
- **OAuth 保护**：bootstrap 只在 status 报告 unauthed 时触发，永不覆盖现有 OAuth/api-key 会话
- **日志**：token 仅 prefix（前 10 字符），截断（mmx-cli 的 `maskToken` 行为）

### 5. TDD 纪律

每个实现任务遵循 RED → GREEN → REFACTOR：
- **RED**：先写 `test/*.test.ts`（覆盖 draft.md Scenarios 的所有分支）
- **VERIFY**：跑测试，**确认失败**
- **GREEN**：写最小实现让测试通过
- **REFACTOR**：清理优化

测试用 `bun:test` 框架。**LuBan 的 luban_execute_task 当前会生成 placeholder test**（`expect(true).toBe(false)`），所以我们用 manual TDD：自己写测试 + 自己写实现，提交时遵循同样的纪律。

### 6. TypeBox schema

所有 pi tool 用 TypeBox 定义参数。`pi.registerTool` 的 execute 函数必须用精确的参数名（`toolCallId, params, signal, onUpdate, ctx`）。return 必须有 `details: T`。

业务逻辑必须从 execute 函数中提取为纯函数（`runAuthStatusTool` / `runExecTool` / `runSearchQuery`），方便测试。

## 跑测试

```bash
cd ~/Project/sages/pi-minimax

# 所有单元测试
bun test

# 单个测试文件
bun test ./test/binary-finder.test.ts

# 类型检查
./node_modules/.bin/tsc --noEmit
```

## 开发工作流（**3rd-party CLI 集成**）

**重要**：与 pi-yunxiao 不同，pi-minimax 是 mmx-cli 的薄包装，**不需要 mock 测试 3rd-party API**。

1. **写 wrapper 前**：用真 mmx 跑一次 `mmx <command> --output json` 看真实 schema
2. **写 wrapper 后**：用 `mockExec` 在测试中模拟 execMmx 返回值
3. **集成验证**：写 `bun -e '...'` inline 脚本，用真实 mmx 验证端到端
4. **wrapper 升级时**：只改 src/tools/*.ts 和对应 test；不动 services（已经稳定）

## 工具命令构造规则

`execMmx({command, args, apiKey?, raw?})`:
- `command`: 多词命令如 `"text chat"` 自动 split 为 `["text", "chat"]`
- `args`: Record → flatten 为 `--key value` 或 `--flag`（boolean true）
- `auto-inject`: `--output json --quiet --non-interactive`（除非 `raw: true` 或 caller 已传 `--output`）
- `apiKey`: 末尾追加 `--api-key <key>`
- 返回 `{stdout, stderr, exitCode, parsed?}` — `parsed` 仅当 stdout 是 valid JSON

## 提交规范

- Conventional Commits：`feat:` / `fix:` / `test:` / `refactor:` / `docs:` / `chore:`
- 例：`feat(pi-minimax): T8 minimax_search_query tool`
- 每个 task 完成后 commit 一次
- 提交者用 git config 已配置的身份（不要 `-c user.name=...` 覆盖）

## 关键约束

- **不发布到 npm** — 本地包
- **不写 SYSTEM.md** — sages 装过
- **不依赖 sages/pi** — 独立包（但 git 是 sages 的子目录）
- **scripts/ 不拷到运行时**
- **mmx-cli 凭证** — `chmod 600 ~/.mmx/config.json`（mmx-cli 自己保证）
- **不允许 import `mmx-cli/sdk`** — shell-out only；零 API client 代码

## 已知陷阱

1. **mmx-cli 不读 `MINIMAX_API_KEY` env**（resolver.ts 只读 --api-key flag 和 config.json）。我们的 auto-bootstrap 填补了这个 gap。
2. **Bash 工作目录不持久**：每次 `bash` 调用 cwd 重置为 `~/Project/sages/`，需要 `cd ~/Project/sages/pi-minimax && ...` 显式切换。
3. **LuBan stub test bug**：`luban_execute_task` 写 `expect(true).toBe(false)` 永远失败。Manual TDD only。
4. **OAuth 和 api_key 互斥**：mmx-cli's `runOAuthLogin` 会 `delete existing.api_key`，反之亦然。我们的 bootstrap 只在 unauthed 时触发，不会破坏现有会话。
5. **`bun test` 路径**：默认从 cwd 找 `*.test.ts`；显式路径要 `./test/foo.test.ts`（不是 `test/foo.test.ts`）。
6. **tsc 不检查 test/**：bun-types 的 `bun:test` 模块 tsc 不识别。test tsconfig exclude 掉，bun runtime 处理。
7. **exec timeout (60s)**：`EXEC_TIMEOUT_MS = 60_000` hardcoded。Long-running mmx commands (e.g. `video generate` polling) will hit timeout. Use `mmx <cmd> --async` for long polls, or call mmx directly outside pi.
8. **auth cache TTL (5min)**：`AUTH_CACHE_TTL_MS = 300_000` hardcoded. The `ok` cache expires after 5min; next ensureAuth() re-checks. Catches OAuth session expiry mid-session.
9. **Process-global module-level cache**：`cachedState` (auth-bootstrap) and `cached` (binary-finder) are bare `let` at module level. Assumes single pi agent per process. If you ever embed pi-minimax in a multi-instance scenario, wrap caches in a class instance.
10. **Env param injection risk**：`execMmx`'s `env` param merges arbitrary Record<string,string> into subprocess env. If LLM is prompt-injected, could override `PATH` etc. Acceptable risk: `env` param only reachable via `minimax_exec` escape hatch (LLM-controlled). Not exposed in any L2 tool's TypeBox schema.
11. **`--api-key` visible in ps aux**: `execMmx` appends `--api-key <key>` to mmx argv; briefly visible in `ps aux | grep mmx`. mmx-cli processes it in-memory and never logs it, but the key is in the OS process table for ~ms. Acceptable for single-user local use; consider env-var passing for CI/multi-user.

## 当前状态

- 67 单元测试通过（binary-finder 8 + exec 11 + auth-status 6 + auth-bootstrap 8 + auth tool 5 + exec-tool 6 + search 11 + tools-index 10 + extension 2 = 67 tests）
- tsc clean
- install.sh 部署到 ~/.pi/packages/minimax 验证通过
- 21 个 git commits（T1-T22，最后一次 `31419a7 docs(pi-minimax): T22 fix tool description drift`）
- 31 个 git-tracked 文件，~2972 LOC
- Audit verdict: 94/100 PASS (7 findings: 5 minor addressed in T18-T20, 2 major addressed in T16-T17)
