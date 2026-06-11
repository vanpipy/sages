# 端到端集成测试 (manual)

> 文档化的人工 smoke test 流程。在真实环境验证 pi-yunxiao 与 pi agent 集成。

## 前置

- 已安装 pi (`which pi`)
- 已 clone 并部署 pi-yunxiao（参见 `../../README.md`）
- 已配置 `YUNXIAO_ACCESS_TOKEN` 或 `~/.config/yunxiao/credentials`

## 步骤

### 1. 验证 pi agent 加载 yunxiao extension

```bash
pi --debug 2>&1 | grep -i yunxiao
```

应看到 8 个 tool 加载日志（yunxiao_mcp_install / start / stop / status / list_tools / mcp_call / create_branch / task / subtask / bug / mr / trigger_pipeline）。

### 2. 验证 SKILL.md 可读

```bash
# 在 pi 里说：
"用云效工具"

# LLM 应该读 skills/yunxiao/SKILL.md，列出 8 个 tool
```

### 3. 真实 API 调用（用 token）

```bash
# 在 pi 里说：
"查一下当前组织信息"

# LLM 调 yunxiao_mcp_call(tool="get_current_organization_Info", arguments={})
# 期望返回 { orgId, userId, userName, ... }
```

### 4. 完整工作流

```bash
# 在 pi 里说：
"基于 master 建一个 feat/test 分支"
"在这个分支建一个任务 '测试 pi-yunxiao'，项目前缀 WBGA"
"基于 feat/test 提一个 MR 到 master"
"触发 qipda 的 test 流水线"

# 期望 4 个 tool 依次调用
```

### 5. 错误处理

```bash
# 在 pi 里说：
"建一个空标题的任务"
# → 返回 VALIDATION 错误，明确告诉 LLM 缺什么

# Token 失效场景：
unset YUNXIAO_ACCESS_TOKEN
echo "invalid" > ~/.config/yunxiao/credentials
chmod 600 ~/.config/yunxiao/credentials
# 在 pi 里说："查组织信息"
# → 返回 TOKEN_EXPIRED + 修复建议
```

### 6. 闲置回收

```bash
# 1. 启动 server
# 2. 等 11 分钟（不调任何 tool）
# 3. ps aux | grep mcp-server
# 期望：server 进程已死
```

## 自动化

T10 包含 `test/smoke.sh` 跑 5 项自动检查（文件存在、typecheck、tests、install.sh 端到端）。

## 通过标准

- 所有 8 个 tool 在 pi agent 里可见
- SKILL.md 内容被 LLM 正确解析
- 真实 API 调用返回正确数据（或友好错误）
- 闲置回收生效
- 端到端流程无崩溃
