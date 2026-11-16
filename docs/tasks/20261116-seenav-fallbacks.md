# SeeNav 兜底动作诊断

branch: feat/embodied-eval · status: completed · updated: 2026-11-16

## Goal

让 EB-Navigation Trial 区分策略计划中的动作和兜底动作。

## Changes

SeeNav 通过可选的策略响应字段报告空计划和非法计划。原生动作与判分继续遵循现有配方。
CPU 重评从原有动作块证据生成诊断，Trial 列出记录次数并可跳转到对应帧。历史证据缺少字段时显示未记录。

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Python 和 Web 回归 | passed | 策略消息、证据、旧轨迹和跳转按钮 |
| 固定 SeeNav 镜像 CPU 检查 | passed | 使用上游 planner 和合成模型响应，检查空计划、非法计划、重置及正常分支 |
| 新真实模型 rollout | not_run | 定向回归覆盖各类回复 |
