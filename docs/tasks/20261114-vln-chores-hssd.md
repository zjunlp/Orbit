# CHORES 和 HSSD-OV 原生评测

branch: feat/embodied-eval · status: completed · updated: 2026-11-15

## Goal

接入 CHORES-S、CHORES-L 和 HSSD-OV 的完整发布目录及原生评测协议，支持独立登记 SPOC、FLaRe 和 LightNav-0。

## Changes

CHORES 两套目录各有 10 类任务。Orbit 冻结指令、户型、初态、上游任务别名和步数上限。两种策略共用双 RGB、指令、
抓持状态和 20 个离散动作。CPU 校验按种子核对 Stretch 初始相机俯角，并按原生终止证据复算成功与 SEL。

HSSD-OV 冻结 Habitat 原生起点、旋转、目标类别、可接受实例视点和 navmesh 摘要。CPU 校验读取记录的 navmesh，
复算终点测地距离、STOP 判定和 SPL。LightNav-0 使用上游 RVQ 解码，再投影到 HSSD-OV 离散动作。
独立的仿真、策略和资产准备见 [CHORES](../../examples/bench-adapters/embodied/benchmarks/chores/README.md)
和 [HSSD-OV](../../examples/bench-adapters/embodied/benchmarks/hssd-ov/README.md)。

## Validation

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| CHORES-S | passed | 1,887 条样本全部通过上游任务解析及 Orbit 计划生成 |
| CHORES-L | passed | 2,091 条样本全部通过上游任务解析及 Orbit 计划生成 |
| CHORES 资产 | passed | 两个套件引用的 3,229 个户型完成原生资产准备 |
| HSSD-OV | passed | 43 个场景完成资产清单生成，1,751 条样本全部通过 Habitat 加载及 Orbit 计划生成 |
| SPOC × CHORES | passed | S、L 各一条 ObjectNav 冻结样本通过真实推理、原生仿真、CPU 校验和重评 |
| FLaRe × CHORES | passed | S、L 各一条 ObjectNav 样本，S 上各一条 Pickup、Fetch、RoomVisit 样本，均通过真实推理、仿真、CPU 校验和重评 |
| HSSD-OV 固定动作 | passed | 最终镜像完成原生左转、前进和 STOP，重建 navmesh 匹配上游摘要，CPU 校验及重评得出同一结论 |
| LightNav-0 × HSSD-OV | passed | 单独冻结的五步开发配置使用真实模型执行全部动作，Habitat 达到步数上限，独立 CPU 校验和重评一致 |
| 项目与 SDK 回归 | passed | `pnpm verify`、Python 3.8 共享 SDK 回归、Python 3.11 集成回归。Python 3.11 有一项依赖 RoboDojo 上游 checkout 的可选检查跳过 |

## Next / open issues

LightNav-0 使用 Hugging Face 推理后端，单步耗时随历史帧增加。正式 500 步协议下已验证真实推理与原生动作执行，正式协议下的真实模型终止和全套件统计仍待验证。
