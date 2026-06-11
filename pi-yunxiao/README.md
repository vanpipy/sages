# pi-yunxiao

> **云效（Alibaba Cloud DevOps）MCP 集成 for [pi](https://pi.dev)**

把官方 [alibabacloud-devops-mcp-server](https://github.com/aliyun/alibabacloud-devops-mcp-server) 的 53 个工具通过 **HTTP 旁路 + JSON-RPC** 暴露为 8 个分层 pi tool。

## ✨ 8 个工具一览

| 层 | 工具 | 用途 |
|---|------|------|
| L0 | `yunxiao_mcp_install` | `npm i -g` MCP server（一次性） |
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

## 📦 安装

### 一次性安装

```bash
# 1. 部署到 ~/.pi/packages/yunxiao
./scripts/install.sh --force

# 2. 一次性安装 MCP server（加速冷启动 ~5s → <1s）
./scripts/install-mcp-server.sh

# 3. 配置 token（二选一）
export YUNXIAO_ACCESS_TOKEN=pt-xxxxx
# 或：
mkdir -p ~/.config/yunxiao
echo 'pt-xxxxx' > ~/.config/yunxiao/credentials
chmod 600 ~/.config/yunxiao/credentials

# 4. 重启 pi
exit && pi
```

### 验证

```bash
# 在 pi 里说：
"yunxiao-quickstart"
# 或手动：
"用 yunxiao_mcp_status 查一下"
"建一个 feat/test 分支基于 master"
"列出 53 个工具"
```

## 🔧 卸载

```bash
./scripts/install.sh --uninstall
```

## 🏗️ 工作原理

```
pi agent
  ↓ 调 yunxiao_create_branch
yunxiao-extension (registerTool)
  ↓ ensureServer()
McpServerManager (flock-protected)
  ↓ spawn (lazy)
alibabacloud-devops-mcp-server --streamable-http (port 3000)
  ↓ HTTPS + PAT
codeup.aliyun.com API
```

**关键设计**（详见 [设计文档](../../.sages/designs/2026-06-11-yunxiao-pi-design.md)）：

- **按需启停**：第一个 tool 触发 spawn，闲置 10 分钟自动 kill
- **flock 并发保护**：多 pi 进程共享同一 server
- **2 次失败健康判定**：防误杀 + 及时发现崩溃
- **per-request token override**：多账号场景
- **chmod 600 token 文件**：凭证不泄漏
- **scripts/ 不拷到运行时**：运行时只含必要的代码

## 🔍 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `TOKEN_EXPIRED` | token 失效 | 轮换 PAT，重写 env 或 credentials |
| `REMOTE_NOT_FOUND` | git remote 非 codeup | `git remote add origin git@codeup.aliyun.com:...` |
| 首次 tool 慢 3-5s | npx 下载 MCP server | 跑 `scripts/install-mcp-server.sh` |
| 端口 3000 被占 | 其他进程占用 | `export YUNXIAO_MCP_PORT=3001` |
| `PIPELINE_NOT_FOUND` | 关键字/仓库名不匹配 | 检查 `pipelineKeyword` 和 `git remote` |
| Token 泄漏风险 | echo 完整 response | logger 已自动截断；勿 echo response |

**手动诊断**：

```bash
# 查 server 状态
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 看日志
cat ~/.cache/yunxiao-mcp/server.log

# 强制清理
rm -rf ~/.cache/yunxiao-mcp/
```

完整 troubleshooting：见 [skills/yunxiao/references/troubleshooting.md](skills/yunxiao/references/troubleshooting.md)

## 🛠️ 开发

```bash
# 类型检查
npx tsc --noEmit

# 跑测试
bun test                     # 75 unit tests
bash test/smoke.sh           # 端到端 smoke

# 部署（改完源后）
./scripts/install.sh --force
exit && pi
```

## 📊 状态

- 75 unit tests pass
- typecheck clean
- 端到端 install.sh 通过
- 5 个 git commits（T1-T11）逐步实现
- 24+ 文件，~2400 行（实现 1500 + 测试 900）

## 📚 文档

- 设计文档：`~/.sages/designs/2026-06-11-yunxiao-pi-design.md`（13 章节，1130 行）
- SKILL.md：`skills/yunxiao/SKILL.md`（LLM 读这个决策）
- 53 工具简表：`skills/yunxiao/references/tool-catalog.md`
- 工作流模式：`skills/yunxiao/references/patterns.md`

## License

MIT
