# AGENTS.md

> 给未来 LLM agent 的项目说明。读这个文件来理解 pi-yunxiao 的工作约定。

## 项目性质

`pi-yunxiao` 是一个 **pi extension npm 包**，集成阿里云云效的 MCP 工具集。与 `sages/pi` 同模式（独立包 + 拷贝部署），但**不依赖** sages。

## 关键约定

### 1. 安装与部署

- **源位置**：`~/Project/sages/pi-yunxiao/`（git 仓库内）
- **运行时位置**：`~/.pi/packages/yunxiao/`（pi 实际加载）
- **同步命令**：`./scripts/install.sh --force`
- **scripts/ 不拷到运行时**（决策 C）—— `install-mcp-server.sh` 仅供用户手动跑
- **RUNTIME_DIRS**：`prompts` `skills` `extensions` `src` + `package.json` + `tsconfig.json`

### 2. 工具分层

- **L0 生命周期（4）**：`yunxiao_mcp_install/start/stop/status` — 几乎不用手调
- **L1 逃生口（2）**：`yunxiao_list_tools` + `yunxiao_mcp_call` — 覆盖 53 官方工具
- **L2 高级封装（6）**：建分支/任务/子任务/Bug/MR/流水线 — 90% 场景

**所有 L2 内部自动 `ensure_server()` + 解析 git remote + 调 L1**。

### 3. 状态目录

`~/.cache/yunxiao-mcp/` 包含：
- `server.pid` — 当前 server PID（atomic write via mktemp + mv）
- `server.lastused` — epoch 秒（闲置回收用）
- `server.log` — server stdout+stderr（chmod 600, 启动时 truncate）
- `lock` — flock 互斥

### 4. Token 管理

- **优先级**：`YUNXIAO_ACCESS_TOKEN` env > `~/.config/yunxiao/credentials` (chmod 600)
- **per-request override**：`yunxiao_mcp_call(overrideToken="pt-yyyy")` 切账号
- **日志**：token 仅 prefix（前 10 字符）

### 5. TDD 纪律

每个实现任务遵循 RED → GREEN → REFACTOR：
- **RED**：先写 `test/*.test.ts`
- **VERIFY**：跑测试，**确认失败**
- **GREEN**：写最小实现让测试通过
- **REFACTOR**：清理优化

### 6. TypeBox schema

所有 pi tool 用 TypeBox 定义参数：

```ts
import { Type } from "typebox";
pi.registerTool({
  name: "yunxiao_create_branch",
  parameters: Type.Object({
    sourceBranch: Type.String(),
    newBranch: Type.String(),
  }),
  // ...
});
```

## 跑测试

```bash
bun test                    # 全部
bun test test/specific.ts   # 单个
bash test/smoke.sh          # 端到端
npx tsc --noEmit            # 类型检查
```

## 提交规范

- Conventional Commits：`feat:` / `fix:` / `test:` / `refactor:` / `docs:` / `chore:`
- 例：`feat(mcp-server-manager): atomic PID write via mktemp+mv`
- 每个 task 完成后 commit 一次
