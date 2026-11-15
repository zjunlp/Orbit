# 原生具身评测共享冻结目录

branch: feat/embodied-eval · status: completed · updated: 2026-11-15

## Goal

减少固定批量准备、Solve 证据和 Verify 请求中重复保存的冻结评测目录。

## Changes

- 批量请求共用一份 reference 和批次计划，批量 Solve 只准备一次 SDK。每条样本仍核对成员身份、初态、策略和 Binding。
- 每个 Solve Run 归档一份 `reference.json`。Run 标签、episode contract 和 Verify 请求绑定同一摘要，CPU 重评在检查共享目录后按原有规则计分。
- 兼容旧 Run 内嵌的 reference 和原有的批次、Diffusion Policy 证据版本。

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| 128 条批量准备 | passed | 使用真实 CHORES-L 和 HSSD-OV 登记对比同一批样本。批量请求分别从约 305 MiB 降到 2.8 MiB、从约 161 MiB 降到 1.6 MiB |
| SDK 和适配器回归 | passed | 覆盖单条、固定批次、逐条 CPU 验证、计分和共享文件摘要校验 |
| `pnpm verify` | passed | 格式、类型、边界、测试和构建 |
| 留存原生证据 | passed | 使用原始内嵌格式和转换后的共享格式重评 CHORES 与 HSSD-OV，判定和轨迹索引一致。HSSD-OV 使用固定镜像的 CPU 验证 |
| 新 GPU rollout | not_run | 验证使用留存轨迹和合成 Solve 回归 |

## Next / open issues

HSSD-OV 的模拟器 reset 开销另行量化。完整套件和新模型推理吞吐需单独测量。
