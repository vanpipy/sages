---
description: Yunxiao (Alibaba Cloud DevOps / codeup.aliyun.com) MCP integration - 8 tools for branch/MR/task/issue/pipeline
---

# pi-yunxiao - 云效集成

> 把云效（codeup.aliyun.com）53 个官方 MCP 工具暴露为 8 个 pi tool。

## 工作流决策

```
User 输入自然语言
  ↓
LLM 读 SKILL.md
  ↓
┌─ "建分支 / branch / 分支"        → yunxiao_create_branch
├─ "建任务 / 任务 / task"          → yunxiao_create_task
├─ "子任务 / subtask"              → yunxiao_create_subtask
├─ "Bug / 缺陷 / 提单"             → yunxiao_create_bug
├─ "MR / 合并请求 / pull request"  → yunxiao_create_mr
├─ "触发流水线 / 跑测试 / pipeline" → yunxiao_trigger_pipeline
├─ "MCP 状态 / server 在不在"      → yunxiao_mcp_status
└─ 其它（如 53 工具的任意长尾）     → yunxiao_list_tools + yunxiao_mcp_call
```

## 8 个工具速查

| 层 | 工具 | 用途 |
|---|------|------|
| L0 | `yunxiao_mcp_install` | `npm i -g` MCP server |
| L0 | `yunxiao_mcp_start` | 启 HTTP 旁路（幂等） |
| L0 | `yunxiao_mcp_stop` | 停 server |
| L0 | `yunxiao_mcp_status` | 查状态 |
| L1 | `yunxiao_list_tools` | 列 53 官方工具 schema |
| L1 | `yunxiao_mcp_call` | 直调任意工具（per-request token override） |
| L2 | `yunxiao_create_branch` | 建分支（自动解析 git remote） |
| L2 | `yunxiao_create_task` | 建任务卡 |
| L2 | `yunxiao_create_subtask` | 建子任务 |
| L2 | `yunxiao_create_bug` | 建 Bug |
| L2 | `yunxiao_create_mr` | 建 MR（自动关联 work item） |
| L2 | `yunxiao_trigger_pipeline` | 触发流水线 |

## 重要规则

1. **首次调用前**确认 `YUNXIAO_ACCESS_TOKEN` 已配置。`yunxiao_mcp_status` 返回 `tokenConfigured: false` 时提示 user 跑 `~/.pi/packages/yunxiao/scripts/install-mcp-server.sh` 兄弟脚本 + 设置 token。
2. **server 第一次启动** ~3-5s（npx 下载 + initialize RPC）。之后热调用 < 200ms。
3. **闲置 10 分钟**自动 kill server。再次调 tool 触发 lazy start。
4. **多账号**用 `yunxiao_mcp_call(overrideToken="pt-yyyy")` 切。
5. **错误**都返回结构化 JSON（`code/message/suggestion`），不静默。

## 详细参考

- 53 工具简表：`references/tool-catalog.md`
- 常用工作流：`references/patterns.md`
- 故障排查：`references/troubleshooting.md`
