---
description: Graphify MCP integration for pi - knowledge graph queries (query/path/explain/god_nodes) over mixed corpus
---

# pi-graphify - 知识图谱查询

> 把 [graphify](https://github.com/safishamsi/graphify) 的 MCP server 暴露为 first-class pi tool。处理 **mixed corpus** (代码+文档+论文+视频+图片) — sage workflow 跟 codebase-memory-mcp **互补**不替代。

## 工作流决策

```
User 输入自然语言
  ↓
LLM 读 SKILL.md
  ↓
┌─ "问个问题 / 解释概念 / 找东西"             → mcp_graph_query
├─ "两个概念之间什么关系 / A 怎么到 B"        → mcp_graph_shortest_path
├─ "详细解释某个 node"                          → mcp_graph_get_node / mcp_graph_explain
├─ "跟 X 相关的都有什么"                        → mcp_graph_get_neighbors
├─ "X 属于哪个 community"                        → mcp_graph_get_community
├─ "哪些是最重要的节点 / hub"                   → mcp_graph_god_nodes
├─ "这个 graph 有多大"                          → mcp_graph_graph_stats
└─ 其它 (list_prs, get_pr_impact, triage_prs) → mcp({ tool: "list_prs", ... })
```

## 7 个 first-class 工具速查

> LLM 直接看 system prompt 就能选，不需要先 `mcp({search: "graphify"})`。

| 工具 | 用途 | 典型调用 |
|------|------|---------|
| `mcp_graph_query` | 基于自然语言问题的图查询（最常用） | `mcp_graph_query({ question: "How does auth work?" })` |
| `mcp_graph_shortest_path` | 两个节点之间的最短路径 | `mcp_graph_shortest_path({ source: "AuthModule", target: "Database" })` |
| `mcp_graph_get_node` | 节点的详细信息 | `mcp_graph_get_node({ label: "SwinTransformer" })` |
| `mcp_graph_get_neighbors` | 节点的邻居 + 关系 | `mcp_graph_get_neighbors({ node: "executeTask" })` |
| `mcp_graph_get_community` | 节点所属的 community | `mcp_graph_get_community({ node: "Foo" })` |
| `mcp_graph_god_nodes` | 高中心性节点（hub） | `mcp_graph_god_nodes({ limit: 10 })` |
| `mcp_graph_graph_stats` | 图的统计（节点/边/community 数） | `mcp_graph_graph_stats()` |

## `mcp` proxy 工具

`graphify list_prs`, `graphify get_pr_impact`, `graphify triage_prs` 不在 first-class 列表里：

```js
mcp({ search: "graphify" })                 // 列出全部 graphify 工具
mcp({ describe: "mcp_graph_list_prs" })     // 看参数 schema
mcp({ tool: "list_prs", args: '{"base":"main"}' })  // 调具体 tool
```

## ⚠️ 重要：graph 是 batch 模式

**first-time use 流程**（新 repo）：

1. **Build (batch, ~5-10 min)**: 通过 bash 跑 `graphify .`
   - 扫描整个 corpus
   - 产出 `graphify-out/{graph.html, graph.json, GRAPH_REPORT.md}`
2. **Query (real-time, MCP)**: graph 存在后，`mcp_graph_*` 才工作
   - Lazy 启动: 第一次 tool call ~1s cold start

**如果 graphify-out/ 不存在**：
- ❌ `mcp_graph_query` 会失败
- ✅ LLM 应该先调 `bash({command: "graphify ."})` 一次

## ⚠️ 何时用 graphify vs codebase-memory-mcp

| 场景 | 用 |
|---|---|
| 找函数的所有 caller | **codebase-memory-mcp** `mcp_trace_path` |
| 改代码后看 blast radius | **codebase-memory-mcp** `mcp_detect_changes` |
| 看代码库架构（语言/包/路由） | **codebase-memory-mcp** `mcp_get_architecture` |
| **看视频/读论文/混合 corpus** | **graphify** (multi-modal) |
| **找概念之间的关系 + 跨文件 cluster** | **graphify** `mcp_graph_query` |
| **持久化 Obsidian vault / HTML report** | **graphify** (批处理输出) |
| **Surprising Connections（隐藏的相关性）** | **graphify** (只有它有) |
| **GitHub PR 影响分析** | **graphify** `mcp_graph_get_pr_impact` |
| 实时 API 查询 AST 符号 | **codebase-memory-mcp** |

## 配合 four sages 工作流

| Sage 阶段 | 推荐 graphify 用法 |
|----------|-------------------|
| **Fuxi（design）** | `mcp_graph_query` 探索设计空间；`mcp_graph_god_nodes` 找关键模块 |
| **QiaoChui（decompose）** | `mcp_graph_query` 理解任务上下文；`mcp_graph_shortest_path` 找依赖链 |
| **LuBan（execute）** | 复杂任务用 `mcp_graph_get_neighbors` 找调用方后再 edit |
| **GaoYao（audit）** | `mcp_graph_query` 验证 change 涉及的概念 |

## 安全约束

| 约束 | 原因 |
|------|------|
| `excludeTools: []` (空) | graphify MCP tools 都是只读 graph queries |
| `outputGuard: 50KB / 2000 lines` | `graph_stats` 在大项目可能 verbose |
| `idleTimeout: 10 min` | graphify MCP server 闲置后自动 kill，节省资源 |
| `lazy` 启动 | 第一次调才拉起 ~1s cold start，不抢占 session 启动时间 |

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `mcp_graph_*` tool 不在工具列表 | graphify CLI 未装 `[mcp]` extra | `uv tool install --reinstall "graphifyy[mcp]"` |
| `graphify: command not found` | uv tool 没装 graphify | `uv tool install "graphifyy[mcp]"` |
| `mcp_graph_query` 返回 "no graph" | graphify-out/ 不存在 | `bash({command: "graphify ."})` 跑批处理 |
| `mcp_graph_query` 慢 | graph 很大（>10k 节点） | 缩小 corpus / 用 `--max-edges` |
| 第一次调 `mcp_graph_query` 卡 1-2s | 冷启动（lazy） | 正常，第二次秒级 |

## 更多信息

- graphify GitHub: https://github.com/safishamsi/graphify
- Pi platform support: `graphify install --platform pi` (已经做了)
- pi-mcp-adapter: https://github.com/nicobailon/pi-mcp-adapter
- 论文 + sage: codebase-memory-mcp 是 sage workflow 的主工具，graphify 是 mixed corpus 增强