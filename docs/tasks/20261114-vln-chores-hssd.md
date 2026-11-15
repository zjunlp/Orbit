# CHORES 原生评测

branch: feat/embodied-eval · status: completed · updated: 2026-11-15

## Goal

接入 CHORES-S 和 CHORES-L 的完整发布目录及原生评测协议，支持独立登记 SPOC 和 FLaRe。

## Changes

CHORES 两套目录各有 10 类任务。Orbit 冻结指令、户型、初态、上游任务别名和步数上限。两种策略共用双 RGB、指令、
抓持状态和 20 个离散动作。CPU 校验按种子核对 Stretch 初始相机俯角，并按原生终止证据复算成功与 SEL。

仿真、策略和资产准备见 [CHORES 接入说明](../../examples/bench-adapters/embodied/benchmarks/chores/README.md)。

## Validation

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| CHORES-S | passed | 1,887 条样本全部通过上游任务解析及 Orbit 计划生成 |
| CHORES-L | passed | 2,091 条样本全部通过上游任务解析及 Orbit 计划生成 |
| CHORES 资产 | passed | 两个套件引用的 3,229 个户型完成原生资产准备 |
| SPOC × CHORES | passed | S、L 各一条 ObjectNav 冻结样本通过真实推理、原生仿真、CPU 校验和重评 |
| FLaRe × CHORES | passed | S、L 各一条 ObjectNav 样本，S 上各一条 Pickup、Fetch、RoomVisit 样本，均通过真实推理、仿真、CPU 校验和重评 |
| 项目与 SDK 回归 | passed | `pnpm verify`、Python 3.8 共享 SDK 回归、Python 3.11 集成回归。Python 3.11 有一项依赖 RoboDojo 上游 checkout 的可选检查跳过 |

## Next / open issues

全套件实跑统计仍待验证。
