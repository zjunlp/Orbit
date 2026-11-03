# 具身评测与调度基础设施源码调研
branch: docs/embodied-infra-research · status: completed · updated: 2026-11-03

## Goal

基于固定源码版本，解释 Embodied First Exam、AllenAI VLA Evaluation Harness、Isaac Lab-Arena + OSMO
的功能、执行链路、协议、调度、评分、恢复与扩展方式，为 Orbit 跨场景评测规划提供可追溯的技术参考。

## Changes

- 在 `docs/research/embodied-bench/` 增加三份独立研究文档；第三份覆盖 Arena 评测层与 OSMO 作业调度层两个仓库。
- 主要结论链接到固定 commit 的源码位置，区分实现、上游声明、研究判断与未运行验证。
- 对照 Orbit 的已实现能力和 §9 规划，说明资源分配、服务容器、错误分母与在线评分的适配边界。
- 本任务只增加研究文档，不修改运行时、公共契约、设计决策或当前功能状态。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| 上游源码与关键调用链核查 | 各文档记录的固定 commit | passed | 静态审阅并核对接口、队列、失败分类、评分与恢复边界 |
| 固定源码链接、路径及行号检查 | 文档工作树 | passed | 159 个上游固定版本引用；相对链接按最终目录校验 |
| 文档空白、引用与代码围栏检查 | 文档工作树 | passed | 新文件逐个执行 diff whitespace check，引用定义与围栏完整 |
| `pnpm verify`（受限环境） | Orbit `3e92a17` | failed | 测试中的子进程创建和本地端口监听返回 EPERM |
| `pnpm verify`（允许本地测试操作） | Orbit `3e92a17` | passed | 格式、lint、类型、依赖边界、测试和构建通过；原有警告保留 |
| 上游仿真、GPU、模型与集群运行 | — | not_run | 此次为源码研究，未安装上游运行环境或执行实验 |

## Next / open issues

- 实际接入需另行执行文档所列最小验收；此调研不构成任何上游 benchmark 已在 Orbit 运行的证据。
