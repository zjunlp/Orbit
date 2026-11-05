# Web：Catalog / 校准总览与 C3/C4 对话视图
branch: feat/web-catalog-conversation · status: in_progress · updated: 2026-11-05 · owner: Claude

## Goal

按 [design §9.15](../design.md) 与 [Web UI 调研](../research/web-ui/landscape.md)：校准成为 daemon 记录的一等结果；
Web 有按类别分组、能下钻到证据的 Catalog；C3/C4 trial 有以轮次为主线、联动 checker 与状态差异的对话视图。

## Changes

- **校准**：判定逻辑移到 `contracts/calibration.ts`（CLI 与 daemon 共用）；`BenchJobSpec.calibration` 标记校准作业；
  `POST /bench/calibrations` 由 daemon 抽样建作业，结束后自动重评一次（`BenchJob.rescore`），`GET /bench/jobs/:id`
  的 `calibration` 给出报告；清理确认前不判定。`orbit bench calibrate` 改用该 API，输出不变。检查带失败 trial 列表。
- **Catalog**：`GET /bench/catalog`（任务列表后台缓存 10 分钟、逐个刷新、失败保留错误；最近 5 次校准；真实方法按
  agent · model · effort 归并；保真度）；`capabilities.parity` 供 adapter 声明与原版对齐的证据。Web Bench 的
  "Registered environments" 改为 Catalog：统计筛选、按类别分组的单表、行展开（Calibration / Coverage / Methods /
  Conditions）、就地发起校准。两轮截图评审（Codex）后修正列宽、换行、文案与按钮。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | 工作区 | passed | Orbit 592 / 26 skipped、Web 64 |
| 校准与 Catalog 单测 | 工作区 | passed | 判定、阶段（运行 / 重评 / 清理未确认）、daemon 自动重评、Catalog 条目；Web 状态与证据链接渲染 |
| 真实 Docker 校准（新 API） | 工作区 | passed | 隔离 daemon：BFCL、HumanEval、τ²、TextArena 各 2 任务 × 2 seed，daemon 自动重评；τ² 首次显示清理未完成后修正为等清理确认再判定 |
| Web 截图评审 | 工作区 | passed | Playwright 截图 + Codex 两轮视觉评审，主要问题已修 |

## Next / open issues

- C3/C4 对话轨迹与视图（进行中）；BFCL 真实 Agent 运行。
