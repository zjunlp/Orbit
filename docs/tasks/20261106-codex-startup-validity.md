# Codex 启动配置失败的评测有效性
branch: fix/codex-startup-validity · status: completed · updated: 2026-11-06

## Goal
Codex 在读取私有配置时因权限退出、尚未创建 session，不能把 shared verifier 的未完成零分计入方法成绩。

## Changes
- 无 Codex/Claude transcript 时，只读取日志头最多 16 KiB，严格识别 Run 私有配置的原生权限错误；允许已知 PATH 提示和 after 阶段边界，沿用脱敏。
- `agent_configuration_failed` 归为现有 `infra`，推进、评分和归并共用映射；保留原始分数、执行状态、清理状态及证据。
- 通过现有 consolidate 的无来源、无裁剪预览与摘要确认重新判定旧结果，无需恢复已销毁的 shared verifier 环境。
- 已产生成功模型回复的部分工作继续评分；普通程序权限错误、引用文本与不完整日志不匹配。

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| 定向回归 | 本分支工作树 | passed | 4 个文件、100 项；显式 fixtures 覆盖无 session、after 边界、日志读取上限、脱敏、正常模型工作、shared verifier 与保留证据的归并 |
| 格式与 diff | 本分支工作树 | passed | Biome 与 git diff --check |
| 已保存的真实 CLI 失败日志 | 本分支工作树 | passed | 只读调用分类器，识别配置权限失败；不启动模型或修改旧记录 |
| pnpm verify | 本分支工作树 | passed | 格式、类型、边界、构建通过；scripts 5、Orbit 615、Web 82 项通过；26 项可选集成跳过，9 条既有 lint 警告 |
| 部署后真实 daemon 复核 | 本分支构建 | passed | 现有 API 无来源/无裁剪预览及摘要确认，把已保存启动故障改为 invalid/infra；原始零分、Run、日志和产物均保留 |
| 新故障注入 | — | not_run | 采用已保存的真实 CLI 故障证据验证；未额外制造配置权限失败 |

## Next / open issues
- 识别有意保持严格：额外的构建日志或未知启动提示可能漏判。运行时用户/文件属主仍须正确配置，此修复不放宽凭据文件权限。
