# 常用工作流模板

## Pattern 1: 完整工作流（建分支 → 改代码 → 建 MR）

```
1. yunxiao_create_branch(sourceBranch="master", newBranch="feat/WBGA-4215-xxx")
2. [user 改代码]
3. git add . && git commit && git push
4. yunxiao_create_mr(projectCode="WBGA", title="feat: ...")
   → 自动从 sourceBranch 提取 work item id (WBGA-4215) 并关联
```

## Pattern 2: 紧急修 Bug

```
1. yunxiao_create_bug(projectCode="WBGA", subject="...", baseBranch="master")
   → 返回 serialNumber: "WBGA-4220"
   → 自动建 fix/WBGA-4220 分支
2. yunxiao_create_mr(...)  // 提 MR
```

## Pattern 3: 子任务分解

```
1. yunxiao_create_task(projectCode="WBGA", subject="登录模块重构")
   → 返回 serialNumber: "WBGA-4230"
2. yunxiao_create_subtask(parentWorkItemId="WBGA-4230", subject="前端")
3. yunxiao_create_subtask(parentWorkItemId="WBGA-4230", subject="后端")
```

## Pattern 4: 自动化 CI

```
1. yunxiao_trigger_pipeline(branch="feat/xxx", pipelineKeyword="test")
   → 默认仓库 = 当前 git remote
2. (轮询) yunxiao_mcp_call(tool="get_latest_pipeline_run", arguments={...})
```

## Pattern 5: 多账号切换

```ts
// 默认 qipda 项目用 env token
const mr = yunxiao_mcp_call(tool="create_change_request", arguments={...});

// 临时切到 vue-supply 账号
const other = yunxiao_mcp_call(
  tool="create_change_request",
  arguments={ repositoryId: "xxx%2Fvue-supply", ... },
  overrideToken="pt-yyyy"
);
```

## Pattern 6: 长尾能力（NL→YAML 等）

```ts
// 53 工具里有个 create_pipeline_from_description（NL 生成 YAML）
// 不在 L2 包装里，用 L1 通用调用
const yaml = yunxiao_mcp_call(
  tool="create_pipeline_from_description",
  arguments={{
    description: "跑 Node 18 单元测试，覆盖率 > 80%",
  }}
);
```
