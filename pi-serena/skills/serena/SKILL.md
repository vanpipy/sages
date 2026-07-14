---
description: Serena MCP integration for pi - LSP-based code semantic retrieval/editing (6 first-class tools `serena_xxx` + `mcp` proxy for long-tail; requires pi-mcp-adapter 2.x)
---

# pi-serena - Serena 代码语义集成

> 把 [serena](https://github.com/oraios/serena) 的 27 个 LSP-based MCP 工具暴露为 6 个 first-class pi tool（whitelist）+ `mcp` proxy 工具（长尾）。

## 工作流决策

```
User 输入自然语言
  ↓
LLM 读 SKILL.md
  ↓
┌─ "找符号 / 找函数 / search symbol"     → serena_find_symbol / serena_get_symbols_overview
├─ "谁调用了 / 引用 / reference"        → serena_find_referencing_symbols
├─ "读这个文件 / read file"             → serena_read_file
├─ "替换函数体 / replace body"          → serena_replace_symbol_body
├─ "在 X 后插入代码 / insert after"     → serena_insert_after_symbol
└─ 其它（如 rename / delete / write）   → mcp({ tool: "serena_xxx", args: "..." })

注意：6 个 first-class 工具的注册名是 `serena_xxx`（不是 `mcp_xxx`），
由 mcp.json 里 `settings.toolPrefix: "short"` 决定（短前缀=server name）。
如改 `toolPrefix: "none"` 则注册名为裸名（如 `find_symbol`）。
```

## 安全约束（硬性边界，不可绕过）

| 约束 | 原因 |
|------|------|
| `execute_shell_command` **已排除** | 防止 LLM 绕过 sage bash 沙箱 |
| **静默模式** 强制启用 | 不弹浏览器 dashboard / GUI 窗口 |
| 6 个 direct tools **白名单** | 避免 27 个 tool 全开爆 context (≈ 8k tokens) |
| `outputGuard: 50KB / 2000 lines` | 防止单个响应打爆 context |

## 6 个 first-class 工具速查

> 注册名 = `{toolPrefix}_{toolName}`。本项目 `toolPrefix: "short"` + server `serena` → `serena_xxx`。
> **注册时机**：仅在 pi session 启动时一次性执行 `pi.registerTool()`；中途修改 `mcp.json` / `mcp-cache.json` 不会自动生效，需重启 session 或 `/mcp` panel 触发 reload。

| 工具 | 用途 | 典型调用（带真实 schema） |
|------|------|---------|
| `serena_find_symbol` | 按路径找符号（函数/类/变量） | `serena_find_symbol({ name_path_pattern: "executeTask", relative_path: "src/tools/luban/index.ts", depth: 0, max_matches: 1 })` |
| `serena_get_symbols_overview` | 高层次理解文件/模块结构 | `serena_get_symbols_overview({ relative_path: "src/tools/luban/index.ts" })` |
| `serena_find_referencing_symbols` | 找谁引用了这个符号 | `serena_find_referencing_symbols({ name_path: "registerLubanTools", relative_path: "src/tools/luban/index.ts" })` ⚠️ `relative_path` **required** |
| `serena_read_file` | 读文件 | `serena_read_file({ relative_path: "src/index.ts", start_line: 0, end_line: 50 })` |
| `serena_replace_symbol_body` | 精准替换函数体（不用字符串） | `serena_replace_symbol_body({ name_path: "executeTask", relative_path: "src/tools/luban/index.ts", body: "..." })` ⚠️ `relative_path` **required** |
| `serena_insert_after_symbol` | 在符号后插入代码 | `serena_insert_after_symbol({ name_path: "executeTask", relative_path: "src/tools/luban/index.ts", body: "..." })` ⚠️ `relative_path` **required** |

### 常见踩坑（与真实 schema 对齐）

- `find_symbol` 用 `name_path_pattern`，**不是** `name_path`
- `find_referencing_symbols` / `replace_symbol_body` / `insert_after_symbol` 都要求 **`relative_path`**（不在文件树搜索时，传目标文件路径即可，不能省略）
- `find_symbol` 的 `relative_path` 是 optional（不传则搜整个 codebase，但可能爆 context）
- 调用前若不知道目标文件，先用 `get_symbols_overview` 摸结构
- `replace_symbol_body` / `insert_after_symbol` 必须先 read 过 `include_body=True`，否则会替换出错

## `mcp` proxy 工具（长尾 + first-class fallback）

不在 6 个 first-class 白名单里的工具（如 `rename_symbol`、`safe_delete_symbol`、`search_for_pattern`、`create_text_file` 等 20 个），用 proxy tool 调用：

```js
mcp({ tool: "serena_rename_symbol", args: '{"name_path":"Foo","relative_path":"src/x.ts","new_name":"Bar"}' })
mcp({ search: "rename" })                    // 模糊搜索工具名
mcp({ describe: "serena_rename_symbol" })    // 看参数 schema
mcp({ connect: "serena" })                   // 预热（lazy 默认）
mcp({})                                      // 看所有 server 状态
```

⚠️ **proxy 调用时的 `tool` 参数必须用 server-前缀名（如 `serena_xxx`）**，不是裸名（`xxx`）也不是 `mcp_xxx`。
这与 first-class 工具的注册名逻辑一致。

**Proxy 还是 first-class？**
- **当前 session 已经启动，且 6 个 first-class 工具已经在工具列表里**：直接用 first-class，省一次 `mcp({...})` 间接调用
- **当前 session 是旧的（first-class 未注册）**，或者要调用白名单外的工具：用 proxy
- **修改 mcp.json 后想立即生效，不用重启**：用 proxy（proxy 走按需路径，实时读 cache）

## 何时用 serena vs 内置 pi tool？

| 场景 | 用 | 原因 |
|------|-----|------|
| 在大文件里找特定函数/类 | **serena** (`serena_find_symbol`) | 内置 grep 太宽，serena 理解 AST |
| 替换一个函数体（保持签名） | **serena** (`serena_replace_symbol_body`) | 字符串 replace 会破坏缩进/换行 |
| 在指定符号后插入代码 | **serena** (`serena_insert_after_symbol`) | 不需要手动算行号 |
| 找谁引用了某函数（重构前） | **serena** (`serena_find_referencing_symbols`) | 精准度比 grep 高 |
| 简单文件读 | 内置 `read` | 无需 LSP 开销 |
| 全文搜索/正则 | 内置 `grep` | serena 的 `search_for_pattern` 是 fallback |

## 配合 four sages 工作流

| Sage 阶段 | 推荐 serena 用法 |
|----------|---------------|
| **Fuxi（design）** | `serena_get_symbols_overview` + `serena_find_symbol` 摸清模块边界 |
| **QiaoChui（decompose）** | `serena_find_referencing_symbols` 识别任务影响面 |
| **LuBan（execute）** | `serena_replace_symbol_body` 精准编辑（不要用字符串） |
| **GaoYao（audit）** | `serena_find_referencing_symbols` 验证 commit 后是否真改了引用 |

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `mcp` tool 不在工具列表 | pi-mcp-adapter 未装 | `pi install npm:pi-mcp-adapter` |
| 6 个 `serena_xxx` first-class 不在工具列表，但 `mcp` proxy 在 | pi session 启动时 direct tools 注册模块返回空（cache 未生成 / mcp.json 还没就位），direct tools 只在 session 启动时一次性 register | 重启 pi session，或在交互式 session 里跑 `/mcp` 打开 panel → reload 触发 `ctx.reload()` |
| `mcp({connect: "serena"})` 卡 30s+ | 首次冷启动 uvx 拉依赖 | 等待，下次秒启 |
| `Tool not found: serena_xxx`（直接调用时） | 同上 — session 启动时未注册 | 回落为 `mcp({ tool: "serena_xxx", args: "..." })` proxy，或重启 session |
| 调用 `find_symbol` 报 `name_path_pattern` field required | SKILL.md 旧版写错（`name_path`），真实 schema 是 `name_path_pattern` | 改用 `name_path_pattern` |
| 调用 `find_referencing_symbols` 报 `relative_path` required | `relative_path` 是 required，不能省略 | 传目标文件路径 |
| `mcp.json exists at ~/.pi/agent/mcp.json (use --force to overwrite)` | 改 install.sh 模板后没生效 | 跑 `pi/scripts/install.sh --force` |

> 💡 **快速诊断脚本**（开发者向，非 LLM 决策路径）见 README.md Troubleshooting 节。

## 更多信息

- serena 官方文档：https://oraios.github.io/serena/
- MCP 协议：https://modelcontextprotocol.io/
- pi-mcp-adapter：https://github.com/nicobailon/pi-mcp-adapter
