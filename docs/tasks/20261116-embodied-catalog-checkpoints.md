# 具身目录与 CHORES 权重范围

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

让已接入的具身 benchmark 可在产品目录发现，并在提交计划时提示权重的建议适用范围。

## Changes

- 产品目录收录 EB-Navigation、CHORES、HSSD-OV、LIBERO-Mem、BiGym 2.0 和 CLIPort。CHORES-S 和 CHORES-L 归为同一家族，登记分别显示套件变体。
- SPOC 登记声明建议套件，FLaRe 登记声明建议任务族。超范围提示随作业保留，CLI 和 Web 均可查看。语义匹配的跨范围实验可以提交。

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| 目录和登记回归 | passed | 六个家族映射、两套 CHORES 变体和六个发布权重的登记范围 |
| 提交回归 | passed | 范围提示随作业保存，作业正常提交且执行快照保持一致 |
| `pnpm verify` | passed | 格式、类型、边界、测试和构建 |
| 新模型推理 | not_run | 改动覆盖目录、登记元数据和展示 |
