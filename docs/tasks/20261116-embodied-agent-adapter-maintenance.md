# 具身 Agent 适配器维护

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

修复 EmbodiedLab 的原生计时起点、EmbodiedCLBench 的原生工具调用超时和 RLE-Bench 的重复摘要计算。

## Changes

- EmbodiedLab 在 Agent 命令启动前开启原生壁钟预算。环境就绪和 Agent CLI 安装发生在握手之前。显式配置的 Orbit 运行超时仍以主容器启动为起点。
- EmbodiedCLBench 在工具调用超时后终止原生调用进程组，保留失败证据，并拒绝导出该序列的部分状态。
- RLE-Bench 在准备时记录目录和任务族摘要。规划验证文件库存与元数据，变化时重新读取内容并核验。旧准备目录可以通过 `--refresh-digests` 升级。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | feat/embodied-eval | passed | 类型、格式、测试和构建 |
| EmbodiedLab Docker 启动和截止时间 | eb91c79 | passed | 用 HTTP 测试替身验证握手和 Agent 命令超时退出 |
| EmbodiedLab Isaac Sim 运行 | eb91c79 | not_run | 当前验证限于启动和计时，未使用原生 RTX 环境 |
| EmbodiedCLBench 原生参考与重评 | 5b26420 | passed | 使用固定上游源码和数据的单条参考轨迹及独立 CPU 重评 |
| EmbodiedCLBench 原生超时回归 | 5b26420 | passed | 用明确的进程测试替身验证超时、整组终止及拒绝导出 |
| RLE-Bench 规划回归 | feat/embodied-eval | passed | 检查 solve 和 verify 复用摘要、旧锁升级与任务文件变更拒绝 |
| RLE-Bench 原生任务重跑 | feat/embodied-eval | not_run | 本次验证覆盖目录准备和计划阶段 |

## Next / open issues

EmbodiedLab 的原生仿真计时仍待兼容 RTX 环境复验。
