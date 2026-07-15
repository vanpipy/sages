---
description: codebase-memory-mcp integration for pi - full graph-based code intelligence (14 first-class tools + proxy)
---

# pi-codebase-memory - Knowledge Graph 代码智能

> 把 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 的 14 个 MCP 工具暴露为 first-class pi tool + proxy 兜底。基于 tree-sitter AST，158 种语言，**Linux kernel (28M LOC) 索引 3 分钟，查询 < 1ms**。

## 工作流决策

```
User 输入自然语言
  ↓
LLM 读 SKILL.md
  ↓
┌─ "谁调用了 X / callers of X / call chain"     → mcp_trace_path
├─ "改这个函数会炸哪些 / git diff 有什么影响"    → mcp_detect_changes
├─ "代码库长什么样 / 整体架构 / packages"          → mcp_get_architecture
├─ "按函数名读源码 / get function body"            → mcp_get_code_snippet
├─ "找符号 / search symbol / find function"        → mcp_search_graph
├─ "看 graph 怎么 query / cypher / schema"         → mcp_query_graph / mcp_get_graph_schema
├─ "扫整个项目 / grep-like / search code"          → mcp_search_code
├─ "有没有索引过 / 索引状态 / 重新建索引"          → mcp_index_status / mcp_index_repository
└─ 其它 (manage_adr, list_projects, delete_project, ingest_traces)
                                               → mcp({ tool: "..." })
```

## 14 个 first-class 工具速查

> LLM 直接看 system prompt 就能选，不需要先 `mcp({search: "..."})`。

### 🔍 索引管理（Indexing）

| 工具 | 用途 | 典型调用 |
|------|------|---------|
| `mcp_list_projects` | 列出所有已索引项目 + node/edge counts | `mcp_list_projects()` |
| `mcp_index_status` | 检查某个项目的索引状态 | `mcp_index_status({ project: "." })` |
| `mcp_index_repository` | 建/重建索引（首次慢，大仓库可能几分钟） | `mcp_index_repository({ project: "." })` |
| `mcp_delete_project` | 删项目 + 所有 graph 数据 | `mcp_delete_project({ project: "." })` |

### 🔎 查询（Querying — sage workflow 高频）

| 工具 | 用途 | 典型调用 |
|------|------|---------|
| `mcp_search_graph` | 结构化搜索（label/name/pattern/degree + 分页） | `mcp_search_graph({ label: "Function", name_pattern: "execute.*", limit: 20 })` |
| `mcp_trace_path` | **调用图 BFS 遍历** — sage 最常用 | `mcp_trace_path({ name: "executeTask", direction: "callers", depth: 3 })` |
| `mcp_detect_changes` | **git diff → 受影响符号 + blast radius** | `mcp_detect_changes({ base: "main" })` |
| `mcp_get_code_snippet` | 按 qualified name 拿函数完整源码 | `mcp_get_code_snippet({ name: "executeTask" })` |
| `mcp_get_architecture` | 代码库全景（语言/包/路由/hotspot/cluster/ADR） | `mcp_get_architecture()` |
| `mcp_query_graph` | Cypher-like 图查询（read-only） | `mcp_query_graph({ query: "MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name='executeTask' RETURN g LIMIT 10" })` |
| `mcp_get_graph_schema` | Node/edge types + property 定义 | `mcp_get_graph_schema()` |
| `mcp_search_code` | 索引内全文搜索（比 grep 快） | `mcp_search_code({ query: "TODO", regex: true })` |

### 📝 高级（少用，但需要时直接有）

| 工具 | 用途 | 典型调用 |
|------|------|---------|
| `mcp_manage_adr` | CRUD Architecture Decision Records | `mcp_manage_adr({ action: "create", title: "...", content: "..." })` |
| `mcp_ingest_traces` | 运行时 trace 入图（验证 HTTP_CALLS edge） | `mcp_ingest_traces({ project: ".", trace_file: "..." })` |

## `mcp` proxy 工具

非 first-class 的边角用法通过 proxy：

```js
mcp({ search: "codebase" })                              // 列所有 14 个 first-class tool 名
mcp({ describe: "mcp_trace_path" })                       // 看参数 schema
mcp({ tool: "mcp_index_repository", args: '{"project":"."}' })  // 走具体 tool
```

## ⚠️ 何时用 serena vs codebase-memory-mcp

| 场景 | 用 | 原因 |
|------|-----|------|
| **快速找一个函数体**（< 100 文件项目） | **codebase-memory-mcp** (`mcp_get_code_snippet`) | 索引后 < 1ms |
| **快速编辑函数体** | **pi-serena** (`mcp_replace_symbol_body`) | LSP 维护缩进 |
| **大项目找 caller**（> 1k 文件） | **codebase-memory-mcp** (`mcp_trace_path`) | 图遍历 vs grep |
| **改代码后看影响面** | **codebase-memory-mcp** (`mcp_detect_changes`) | git diff → 自动算 blast radius |
| **精确编辑（保持语法正确）** | **pi-serena** (`mcp_replace_symbol_body`) | AST-aware 编辑 |
| **架构理解 / 跨包分析** | **codebase-memory-mcp** (`mcp_get_architecture`) | 跨包概览 |
| **LSP 语义（类型/继承）** | **pi-serena** (`mcp_find_symbol`) | 真实 LSP，不是 regex |

## 配合 four sages 工作流

| Sage 阶段 | 推荐 codebase-memory-mcp 用法 |
|----------|----------------------------------|
| **Fuxi（design）** | `mcp_get_architecture()` — 自动拿到代码库 overview，跳过手写调研 |
| **QiaoChui（decompose）** | `mcp_detect_changes({base: "main"})` — 提前知道任务影响面 |
| **LuBan（execute）** | `mcp_trace_path({direction: "callers", depth: 2})` — 改前看下游 |
| **GaoYao（audit）** | `mcp_detect_changes` + `mcp_query_graph` — 验证 commit 是否安全 |

## 首次使用（first-session initialization）

进入一个新 workspace 时：

1. **检测**：`mcp_index_status({project: "."})` → 看 "no index" 表示需要建
2. **建索引**：`mcp_index_repository({project: "."})` → 大仓库 ~几分钟，小仓库秒级
3. **开始用**：`mcp_search_graph`, `mcp_trace_path`, ...

> 注：上游 `codebase-memory-mcp` 是独立进程 (C + 薄 Go wrapper)，第一次 mcp 调用会触发进程启动 (~1s cold start)。

## 安全约束

| 约束 | 原因 |
|------|------|
| `excludeTools: []` (空) | 上游纯 graph 操作，无 shell exec / 无文件写入（除 `index_*` / `manage_adr`） |
| 工具调用 sandboxed | codebase-memory-mcp 只读 graph，**不能改你的代码** |
| 写入操作需要显式调用 | `index_repository` / `delete_project` / `manage_adr` 都是独立 tool，不会意外触发 |

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `mcp_*` tool 找不到 | `pi-mcp-adapter` 未装 | `pi install npm:pi-mcp-adapter` |
| `codebase-memory-mcp: command not found` | 二进制未装 | `./pi/scripts/install.sh --force` |
| `mcp_index_repository` 超时 (>2 min) | 大项目首次扫描 | 等待；状态用 `mcp_index_status` |
| `mcp_*` 返回空结果 | 项目未索引 | `mcp_index_repository({project: "."})` |
| `command not found` 在 PATH 里 | binary 装到 `~/.local/bin/` 但 PATH 没含 | `export PATH="$HOME/.local/bin:$PATH"` |

## 更多信息

- upstream: https://github.com/DeusData/codebase-memory-mcp
- paper: [Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP](https://arxiv.org/abs/2603.27277)
- pi-mcp-adapter: https://github.com/nicobailon/pi-mcp-adapter