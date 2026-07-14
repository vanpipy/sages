---
description: Serena MCP integration for pi - LSP-based code semantic retrieval/editing (6 direct tools + proxy)
---

# pi-serena - Serena 代码语义集成

> 把 [serena](https://github.com/oraios/serena) 的 27 个 LSP-based MCP 工具暴露为 6 个 first-class pi tool（whitelist）+ `mcp` proxy 工具（长尾）。

## 工作流决策

```
User 输入自然语言
  ↓
LLM 读 SKILL.md
  ↓
┌─ "找符号 / 找函数 / search symbol"     → mcp_find_symbol / mcp_get_symbols_overview
├─ "谁调用了 / 引用 / reference"        → mcp_find_referencing_symbols
├─ "读这个文件 / read file"             → mcp_read_file
├─ "替换函数体 / replace body"          → mcp_replace_symbol_body
├─ "在 X 后插入代码 / insert after"     → mcp_insert_after_symbol
└─ 其它（如 rename / delete / shell）   → mcp({ tool: "serena_xxx", args: "..." })
```

## 6 个 first-class 工具速查

| 工具 | 用途 | 典型调用 |
|------|------|---------|
| `mcp_find_symbol` | 按路径找符号（函数/类/变量） | `mcp_find_symbol({ name_path: "LuBan/executeTask", depth: 0 })` |
| `mcp_get_symbols_overview` | 高层次理解文件/模块结构 | `mcp_get_symbols_overview({ relative_path: "src/tools/luban/index.ts" })` |
| `mcp_find_referencing_symbols` | 找谁引用了这个符号 | `mcp_find_referencing_symbols({ name_path: "registerMcpTools" })` |
| `mcp_read_file` | 读文件 | `mcp_read_file({ relative_path: "src/index.ts", start_line: 0, end_line: 50 })` |
| `mcp_replace_symbol_body` | 精准替换函数体（不用字符串） | `mcp_replace_symbol_body({ name_path: "executeTask", body: "..." })` |
| `mcp_insert_after_symbol` | 在符号后插入代码 | `mcp_insert_after_symbol({ name_path: "executeTask", body: "..." })` |

## `mcp` proxy 工具（长尾）

不在 6 个 first-class 里的工具（如 `mcp_rename_symbol`、`mcp_safe_delete_symbol`、`mcp_search_for_pattern`），用 proxy tool 调用：

```js
mcp({ tool: "serena_rename_symbol", args: '{"name_path":"Foo","new_name":"Bar"}' })
mcp({ search: "rename" })                    // 模糊搜索工具名
mcp({ describe: "serena_rename_symbol" })    // 看参数 schema
mcp({ connect: "serena" })                   // 预热（lazy 默认）
mcp({})                                      // 看所有 server 状态
```

## 安全约束（不可绕过）

| 约束 | 原因 |
|------|------|
| `execute_shell_command` **已排除** | 防止 LLM 绕过 sage bash 沙箱 |
| **静默模式** 强制启用 | 不弹浏览器 dashboard / GUI 窗口 |
| 6 个 direct tools **白名单** | 避免 27 个 tool 全开爆 context (≈ 8k tokens) |
| `outputGuard: 50KB / 2000 lines` | 防止单个响应打爆 context |

## 何时用 serena vs 内置 pi tool？

| 场景 | 用 | 原因 |
|------|-----|------|
| 在大文件里找特定函数/类 | **serena** (`mcp_find_symbol`) | 内置 grep 太宽，serena 理解 AST |
| 替换一个函数体（保持签名） | **serena** (`mcp_replace_symbol_body`) | 字符串 replace 会破坏缩进/换行 |
| 在指定符号后插入代码 | **serena** (`mcp_insert_after_symbol`) | 不需要手动算行号 |
| 找谁引用了某函数（重构前） | **serena** (`mcp_find_referencing_symbols`) | 精准度比 grep 高 |
| 简单文件读 | 内置 `read` | 无需 LSP 开销 |
| 全文搜索/正则 | 内置 `grep` | serena 的 `search_for_pattern` 是 fallback |

## 配合 four sages 工作流

| Sage 阶段 | 推荐 serena 用法 |
|----------|---------------|
| **Fuxi（design）** | `mcp_get_symbols_overview` + `mcp_find_symbol` 摸清模块边界 |
| **QiaoChui（decompose）** | `mcp_find_referencing_symbols` 识别任务影响面 |
| **LuBan（execute）** | `mcp_replace_symbol_body` 精准编辑（不要用字符串） |
| **GaoYao（audit）** | `mcp_find_referencing_symbols` 验证 commit 后是否真改了引用 |

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `mcp` tool 不在工具列表 | pi-mcp-adapter 未装 | `pi install npm:pi-mcp-adapter` |
| `mcp({connect: "serena"})` 卡 30s+ | 首次冷启动 uvx 拉依赖 | 等待，下次秒启 |
| `Tool not found: mcp_xxx` | 直接 tool 名拼错 | 用 `mcp({search: "xxx"})` 查实际名 |
| `mcp.json exists at ~/.pi/agent/mcp.json (use --force to overwrite)` | 改 install.sh 模板后没生效 | 跑 `pi/scripts/install.sh --force` |

## 更多信息

- serena 官方文档：https://oraios.github.io/serena/
- MCP 协议：https://modelcontextprotocol.io/
- pi-mcp-adapter：https://github.com/nicobailon/pi-mcp-adapter
