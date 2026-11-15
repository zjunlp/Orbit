# 具身评测证据和汇总覆盖率

branch: feat/embodied-eval · status: completed · updated: 2026-11-15

## Goal

使原生评测的 CPU 重评遵守 Solve 的动作规则，并在分数中说明本次计划的样本覆盖率。

## Changes

- Solve 和 Verify 共用动作块校验。Verify 按绑定核对动作维数、重规划与终止边界，继续支持 CALVIN 旧证据和首块特殊长度。
- EB-Navigation 核对动作反馈和位姿变化。CHORES 核对底盘运动范围及停止、确认动作的位姿，目标可见性、抓取和房间标签来自原生记录。
- 新汇总记录计划、计分、排除和缺失数。CLI 和 Web 也能从旧报告中推导覆盖率，已归档的报告保留原始字段。
- 重评 staging 清除当前 SDK 已删除的模块。HSSD-OV 的主机配置入口可以在只有标准库的 Python 中启动。

## Validation

| Check | Result | Notes |
| --- | --- | --- |
| Node 和 Python 回归 | passed | 官方规则、短动作块、非法切块、导航位姿、重评 staging 及 HSSD-OV 配置入口 |
| 现有原生导航证据 | passed | 新 CPU 验证器复验 EB-Navigation 和 CHORES 的留存轨迹 |
| 新 GPU rollout 或全套件 | not_run | 本轮使用既有原生证据与合成回归检查验证改动 |

## Next / open issues

完整套件的目录重复传输与仿真重置开销仍需单独处理。
