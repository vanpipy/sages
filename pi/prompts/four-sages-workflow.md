# Sages Workflow System

> Sages 通过**声明式 workflow** 驱动 4 贤协作。流程由 `.sages/workflow.yaml` + `.sages/workflows/{name}.yaml` 定义,**无需记忆 18 个 slash command**。

---

## 快速上手

### 1. 全新项目

```bash
# pi 启动后,首次进入项目
/sages-init
```

会自动创建:
- `.sages/workflow.yaml`(默认 active=four-sages)
- `.sages/workflows/{four-sages,bugfix}.yaml`(workflow 模板)
- `.sages/prompts/`(所有 stage prompt)

### 2. 启动 workflow

只需在聊天中说"我想做 X" / "implement Y" / "fix Z",FSM 会:
1. 加载当前 workflow 定义
2. 自动注入 design 阶段的 prompt
3. LLM 开始 MDD 7 Planes 设计

### 3. 用户的唯一操作

| 何时 | 做什么 | 命令 |
|---|---|---|
| 看到 review 通过通知 | **批准 plan** | `/sages-plan` |
| 任何时候想看进度 | **查状态** | `/sages-status` |
| 切换 workflow | **切换** | `/sages-workflow <name\|list\|current>` |

### 4. 流程自动推进(基于真实证据)

```
[设计 (Fuxi)]  写 draft.md (≥500 字节)
   ↓ (tool_result 检测 draft.md 创建)
[审查 (QiaoChui)]  读 draft.md,写 state.score
   ↓ (state.score ≥ 80)
[等待 plan 批准]  你输入 /sages-plan
   ↓ (manual gate)
[分解 (QiaoChui)]  写 execution.yaml
   ↓ (files-exist: plan.md + execution.yaml)
[执行 (LuBan)]  TDD,写代码 + 测试,设 state.executeStatus=complete
   ↓ (state-field: executeStatus=complete)
[审计 (GaoYao)]  5 阶段审计,写 audit.md 包含 "**Verdict**:"
   ↓ (file-content-match: "**Verdict**:")
[归档]  根据 verdict 自动路由:
   - PASS  →  archive → complete
   - REJECTED →  回 design 重新设计
   - NEEDS_CHANGES →  回 execute 修复
```

---

## 推荐:头脑风暴

⚡ **强烈建议** 在任何实现前先做:

```
/brainstorm [your request]
```

详见 `.pi/agent/skills/brainstorming/SKILL.md`。

---

## 当前可用 workflow

| workflow | stages | 适用 |
|---|---|---|
| `four-sages` | 8(design→review→plan→decompose→execute→audit→archive→complete) | 完整功能开发 |
| `bugfix` | 5(reproduce→fix→audit→archive→complete) | 已确认的小范围 bug |

未来会加:
- `adr`(架构决策记录)
- `refactor`(重构专用)
- `docs`(文档生成)

---

## 当前阶段(2026-06-29)实现状态

| 特性 | 状态 |
|---|---|
| `.sages/pipeline.yaml`(已重命名为 `workflow.yaml`) | ✅ |
| Workflow YAML 加载 + typebox schema 校验 | ✅ |
| 7 个 stage 自动推进(tool_result 触发) | ✅ |
| onVerdict 分支(PASS/REJECTED/NEEDS_CHANGES) | ✅ |
| `/sages-plan` 手动 gate | ✅ |
| `/sages-status` 状态查询 | ✅ |
| `/sages-workflow` 切换 | ✅ |
| `/sages-init` 初始化 | ✅ |
| QualityGate 预检(hard/soft/advisory) | ✅ |
| Attestation 哈希链 | ❌ 阶段 2+ |
| Autonomy tier | ❌ 阶段 2+ |
| Adapter 加载器 | ❌ 阶段 2+ |
| 死锁检测(5 次后终止) | ✅ |
| transition 边验证 | ✅ |
| 文件缺失报错 | ✅ |
| YAML 错误定位 | ✅(schema 报错含 instancePath) |
| Conformance fixture(20+) | ❌ 阶段 1.5+ |

---

## 反馈

如果遇到问题:
1. `/sages-status` 看当前 state
2. 检查 `.sages/workspace/state.json` 的 `history` 字段
3. 检查实际文件内容(draft.md / plan.md / execution.yaml / audit.md)
4. 看 pi session 的 `sages-fsm-transition` 历史
5. 提交 issue 或查看 `.sages/workflows/*.yaml` schema