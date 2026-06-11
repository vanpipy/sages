# /yunxiao-quickstart

快速验证 pi-yunxiao 是否配置正确。

## 步骤

1. 检查 token：`yunxiao_mcp_status` → `tokenConfigured: true`
2. 启动 server：`yunxiao_mcp_start` → `running: true, pid: <number>`
3. 列工具：`yunxiao_list_tools` → 应有 53 个工具
4. 试一次实际 API：`yunxiao_mcp_call(tool="get_current_organization_Info", arguments={})`
5. 停止 server：`yunxiao_mcp_stop`

## 预期输出

```json
{
  "success": true,
  "status": {
    "installed": true,
    "running": true,
    "healthy": true,
    "pid": 12345,
    "port": 3000,
    "tokenConfigured": true
  }
}
```

## 故障时

按 `references/troubleshooting.md` 排查。
