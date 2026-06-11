# 53 个官方 MCP 工具简表

> 来源：https://help.aliyun.com/zh/yunxiao/developer-reference/cloud-effect-mcp-tool-instructions
> 调用方式：`yunxiao_mcp_call(tool="<name>", arguments={...})`

## 组织管理（11 个）

| 工具 | 用途 |
|------|------|
| `get_current_organization_Info` | 当前用户所在组织信息 |
| `get_user_organizations` | 用户加入的组织列表 |
| `get_organization_role` | 组织角色信息 |
| `get_organization_departments` | 部门列表 |
| `get_organization_department_info` | 部门详情 |
| `get_organization_department_ancestors` | 部门上级 |
| `get_organization_members` | 成员列表 |
| `get_organization_member_info` | 成员详情 |
| `get_organization_member_info_by_user_id` | 按 userId 查 |
| `search_organization_members` | 搜索成员 |
| `list_organization_roles` | 角色列表 |

## 项目管理（6 个）

| 工具 | 用途 |
|------|------|
| `get_project` | 项目详情 |
| `search_projects` | 搜索项目 |
| `get_work_item` | 工作项详情 |
| `search_workitems` | 搜索工作项 |
| `get_work_item_types` | 工作项类型 |
| `create_work_item` | 创建工作项 |

## 代码管理（17 个）

| 工具 | 用途 |
|------|------|
| `create_branch` | 创建分支 |
| `delete_branch` | 删除分支 |
| `get_branch` | 分支详情 |
| `list_branches` | 分支列表 |
| `create_file` | 创建文件 |
| `delete_file` | 删除文件 |
| `get_file_blobs` | 文件内容 |
| `list_files` | 文件树 |
| `update_file` | 更新文件 |
| `create_change_request` | 创建 MR |
| `create_change_request_comment` | MR 评论 |
| `get_change_request` | MR 详情 |
| `list_change_request_patch_sets` | MR 版本列表 |
| `list_change_request` | MR 列表 |
| `list_change_request_comments` | MR 评论列表 |
| `get_compare` | 代码比较 |
| `get_repository` / `list_repositories` | 仓库信息 |

## 流水线工具（15 个）

| 工具 | 用途 |
|------|------|
| `get_pipeline` | 流水线详情 |
| `list_pipelines` | 流水线列表 |
| `smart_list_pipelines` | **NL 智能查询**（如"昨天的"） |
| `create_pipeline_run` | 运行流水线 |
| `get_latest_pipeline_run` | 最新运行 |
| `get_pipeline_run` | 运行详情 |
| `list_pipeline_runs` | 历史 |
| `list_pipeline_jobs_by_category` | 任务列表 |
| `list_pipeline_job_historys` | 任务历史 |
| `execute_pipeline_job_run` | 手动跑任务 |
| `get_pipeline_job_run_log` | 任务日志 |
| `list_service_connections` | 服务连接 |
| `create_pipeline_from_description` | **NL→YAML 自动生成** |
| `update_pipeline` | 更新 YAML |

## 制品仓库（3 个）

| 工具 | 用途 |
|------|------|
| `list_package_repositories` | 制品仓库列表 |
| `list_artifacts` | 制品列表 |
| `get_artifact` | 制品详情 |
