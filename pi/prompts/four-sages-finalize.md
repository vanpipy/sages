# Finalize Stage Prompt

workflow 完成的归档阶段。

## 任务

将 `.sages/workspace/` 全部内容归档到 `.sages/archive/${planName}/${timestamp}/`,并向用户报告。

## 操作

```bash
mkdir -p .sages/archive/${planName}/${timestamp}
cp -r .sages/workspace/* .sages/archive/${planName}/${timestamp}/
```

## 报告

告诉用户:
- workflow 名称
- planName
- 归档位置
- 历史转换次数

## 完成后

FSM 推进到 `complete` 阶段,workflow 终止。
