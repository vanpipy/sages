# 故障排查

## 错误码速查

| 错误码 | 含义 | 解决 |
|--------|------|------|
| `TOKEN_EXPIRED` | token 401 | 轮换 PAT，重写 env 或 `~/.config/yunxiao/credentials` |
| `REPO_NOT_FOUND` | 404 | 检查 `git remote -v`，确认在 codeup.aliyun.com |
| `VALIDATION` | 参数缺失/错 | 重读 tool schema |
| `RATE_LIMITED` | 429 | 等待 1-2 分钟 |
| `UPSTREAM_ERROR` | 5xx | 云效服务端问题，稍后重试 |
| `REMOTE_NOT_FOUND` | git remote 无法解析 | `git remote add origin git@codeup.aliyun.com:...` |
| `PARSE_ERROR` | JSON-RPC 格式错 | 报 bug |
| `RPC_ERROR` | JSON-RPC 协议层错误 | 报 bug |
| `WORK_ITEM_FAILED` / `SUBTASK_FAILED` / `BUG_FAILED` / `MR_FAILED` | 业务错 | 看 message |
| `PIPELINE_NOT_FOUND` | 流水线不匹配 | 检查 repo name + keyword |

## 常用诊断命令

```bash
# 1. 查 MCP server 状态（在 pi 里）
# → yunxiao_mcp_status

# 2. 查 server 日志
cat ~/.cache/yunxiao-mcp/server.log

# 3. 手动测 MCP server 是否在跑
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 4. 查 token 是否配置
env | grep YUNXIAO
cat ~/.config/yunxiao/credentials  # 应有 pt-xxx

# 5. 强制清理（server 状态坏了）
rm -rf ~/.cache/yunxiao-mcp/
# 下次 tool 调用会 lazy start 新 server
```

## 常见陷阱

### 1. 第一次调用慢（3-5s）

首次 spawn `npx -y alibabacloud-devops-mcp-server --streamable-http` 需要下载包。**解决**：跑 `~/.pi/packages/yunxiao/scripts/install-mcp-server.sh`（一次性 `npm i -g`，冷启动 < 1s）。

### 2. 多 pi 进程端口冲突

两个 pi 进程同时想用 3000 端口。**解决**：第二个会通过 flock 复用第一个的 server；若有第三方占用，spawn 失败 → 改 `YUNXIAO_MCP_PORT=3001`。

### 3. Token 进了日志泄漏

本包 logger 自动截断 token 到 10 字符前缀 + `...`。**但**如果你用 `yunxiao_mcp_call` 调试时打印了 response，可能含 token — **不要 echo 完整 response 到终端**。

### 4. 工作流钩接的失败

如果你的项目想 "luban_execute_task 完成后自动建 yunxiao_create_subtask" — **当前 v1 不支持**。这是 sages/pi 集成层的事，不是 pi-yunxiao 自身。

## 性能调优

| 指标 | 默认 | 调优方式 |
|------|------|---------|
| 冷启动 | ~3-5s | `npm i -g` MCP server → <1s |
| 热调用 | ~50-200ms | 无需调优 |
| 闲置超时 | 10 min | `YUNXIAO_MCP_IDLE_MIN=30` |
| 健康检查 | 2 次失败 | 改 `mcp-server-manager.ts` 重建实例 |
| 端口 | 3000 | `YUNXIAO_MCP_PORT=3001` 避免冲突 |

## 🚨 Yunxiao MCP 工具参数名易踩坑（**已用 E2E 验证**）

> 这些是从端到端测试里抓出来的。**Yunxiao 53 个工具的参数名不一致**，写 L2 wrapper 必须先调一次 `tools/list` 查 schema，或用真实 token 验证。

### 完整已验证列表（E2E test 覆盖）

| 工具 | 正确参数 | 易错写法 | 状态 |
|------|---------|---------|------|
| `create_branch` | `branch`, `ref`, `organizationId`, `repositoryId` | ~~`newBranch`~~, ~~`sourceBranch`~~, ~~`repoName`~~ | ✅ L2 wrapper 已修 |
| `delete_branch` | `branchName` | ~~`branch`~~ | 📋 未包装 (用 L1 直调) |
| `create_work_item` | `workitemTypeId` (32-char ID), `spaceId`, `subject`, `parentId?`, `assignedTo?` | ~~`workItemType`~~ (string "Task") | ✅ L2 wrapper 已修（2-step lookup） |
| `create_change_request` | `reviewerUserIds` (array of user IDs) | ~~`reviewers`~~ (usernames) | ✅ L2 wrapper 已修（2-step lookup） |
| `list_pipelines` | `organizationId` | (需 organizationId 必填) | ✅ L2 wrapper (step 1/2) |
| `create_pipeline_run` | `pipelineId`, `branch` | (无明显坑) | ✅ L2 wrapper (step 2/2) |
| `get_current_organization_info` | (no args) | (返回 `lastOrganization` 字段) | ✅ used by lookups |
| `get_work_item_types` | `organizationId`, `id` (spaceId), `category?` | (返回 array of `{id, name}`) | ✅ used by workitemTypeId lookup |
| `search_organization_members` | `organizationId`, `query` | (返回 array of `{userId, name}`) | ✅ used by reviewerUserIds lookup |
| `initialize` | `protocolVersion`, `capabilities`, `clientInfo` | (首次调用) | ✅ McpClient 内部 |

**待验证的工具**（v2 候选）：
- `update_file`, `get_file_blobs`, `list_files` - 文件 API
- `smart_list_pipelines` - NL 查询
- `create_pipeline_from_description` - NL→YAML
- `list_package_repositories`, `list_artifacts`, `get_artifact` - 制品仓库
- 其它 50+

### E2E 验证工作流（**已 commit**）

```bash
# 跑 E2E 测试（需真 token，没就 SKIP）
bash scripts/test-e2e.sh

# 跑全部测试
bun run test:all
```

**E2E 测试 5 分钟内逮到 5 个 wrapper 真 bug**：
1. `branch.ts` - `sourceBranch` → `ref`，删 `repoName`
2. `task.ts` - `workItemType` → `workitemTypeId` (lookup)
3. `subtask.ts` - 同上
4. `bug.ts` - 同上
5. `change-request.ts` - `reviewers` → `reviewerUserIds` (lookup)

全部在 30 分钟内修好（详见 commit `36850eb`）。
