# Agent 安装时限与 EmbodiedLab 停止原因

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

为容器内的 Agent CLI 安装提供时限，并在 Trial 中展示 EmbodiedLab 的原生停止原因。

## Changes

Orbit 从主容器启动计算安装时限，默认 900 秒，可通过 daemon 环境变量 `ORBIT_AGENT_SETUP_TIMEOUT_SEC` 调整。重启后使用保存的时限和原启动时间。到期停止主容器，由现有收尾流程停止服务并释放租约，安装超时归为 `agent_install`。

EmbodiedLab 保留安装完成后的原生计时起点。CPU verifier 将签名证据中的停止原因带到 Trial Details，原生壁钟预算用尽可以和已提交的有效分数同时展示。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | feat/embodied-eval | passed | 格式、静态检查、测试和构建 |
| Agent 安装时限 | feat/embodied-eval | passed | 真实 Docker，使用测试安装脚本。覆盖成功安装后执行、daemon 重启后终止卡住的安装及释放租约 |
| EmbodiedLab Trial Details | feat/embodied-eval | passed | 测试验证已提交结果与壁钟耗尽同时呈现，并覆盖旧的验证输出 |
| Isaac Sim | feat/embodied-eval | not_run | 本轮验证覆盖 Orbit 安装和停止原因的传递 |
