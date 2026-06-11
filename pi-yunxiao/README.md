# pi-yunxiao

云效（Alibaba Cloud DevOps / codeup.aliyun.com）MCP 集成 for [pi](https://pi.dev)。

把官方 [alibabacloud-devops-mcp-server](https://github.com/aliyun/alibabacloud-devops-mcp-server) 的 53 个工具通过 **HTTP 旁路 + JSON-RPC** 暴露为 8 个分层 pi tool。

## 8 个 Tool

| 层 | 工具 | 用途 |
|---|------|------|
| L0 | `yunxiao_mcp_install` / `start` / `stop` / `status` | 旁路进程生命周期 |
| L1 | `yunxiao_list_tools` / `yunxiao_mcp_call` | 53 工具发现 + 通用调用 |
| L2 | `yunxiao_create_branch` / `task` / `subtask` / `bug` / `mr` / `trigger_pipeline` | 高频操作封装 |

## 安装

```bash
# 1. 部署到 ~/.pi/packages/yunxiao
./scripts/install.sh --force

# 2. 一次性安装 MCP server（加速冷启动）
./scripts/install-mcp-server.sh

# 3. 配置 token（二选一）
export YUNXIAO_ACCESS_TOKEN=pt-xxxxx
# 或：
mkdir -p ~/.config/yunxiao && echo 'pt-xxxxx' > ~/.config/yunxiao/credentials && chmod 600 ~/.config/yunxiao/credentials

# 4. 重启 pi
exit && pi
```

## 使用

在 pi 里直接说：

```
"帮我基于 master 建一个 feat/category 分支"
"建一个工单 WBGA-1234 关联到 sprint/20260611 的 MR"
"触发 qipda 的 test 流水线"
```

LLM 会自动读 `skills/yunxiao/SKILL.md` 选择合适的 tool 调用。

## 卸载

```bash
./scripts/install.sh --uninstall
```

## 工作原理

详见 [设计文档](../../.sages/designs/2026-06-11-yunxiao-pi-design.md)。

简述：
- `alibabacloud-devops-mcp-server --streamable-http` 跑成常驻 HTTP 旁路（端口 3000）
- pi tool 用 `fetch` + JSON-RPC 2.0 调用
- 按需启停，闲置 10 分钟自动 kill
- 状态文件 `~/.cache/yunxiao-mcp/`（PID / log / lock）
- 多 pi 进程共享同一 server，per-request token override 支持多账号

## 故障排查

```bash
# 查看 server 状态
# 在 pi 里调 yunxiao_mcp_status

# 查看日志
cat ~/.cache/yunxiao-mcp/server.log

# 强制清理
rm -rf ~/.cache/yunxiao-mcp/
```

## License

MIT
