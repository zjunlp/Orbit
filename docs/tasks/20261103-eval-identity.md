# 评测身份、官方口径与报告修订（P2）
branch: feat/eval-identity · status: completed · updated: 2026-11-03

## Goal

按 design §9.1a / §9.7（审查 R2）让结果可追溯、口径不混用：失败原因可计数，episode 结束方式可见，
benchmark 自己的统计规则与 Orbit 的 valid-only 口径并列，结果在重新评分或归并后不被原地覆盖。

## Changes

- 契约：`FailureKind`（封闭集合）、`Episode`、`OfficialRule`、`OfficialValue`、`ReportEntry`、`BenchReport`；
  `Outcome.failure/episode`、`BenchJob.official`、`MethodSummary.official`；adapter `tasks.official`、`score.failure/episode`。均为可选，旧数据可读。
- `bench/classify.ts`：invalid 结果填写 failure（infra、agent_install、budget_exceeded、model_unavailable、scorer_error 或 adapter 给的类型）；
  consolidate 重新分类时记 `model_unavailable`。
- `bench/summary.ts`：`planDigest`、`officialValue`（errors exclude/fail，unit sample/task，missing → partial）、`buildReport`、`sameReport`。
- 存储：`bench_reports(job_id, revision)` 只追加；删除 job 与归并来源时一并删除。
- `BenchService`：提交时存 official 快照；job 无未完成 trial 时（结束、取消、重新评分、归并后）若结果变化则追加修订；旧 job 首次读取补 `backfill`。
- API `GET /bench/jobs/:id/reports`；CLI `orbit bench report <job> [-r n]`，`bench show` 显示官方值；Web 方法卡片显示官方值，job 页 Reports 列表。
- 文档：design §7 adapter 回复、§9.7 已实现说明、§9.13；guide `bench-adapter.md` 新增"官方口径、失败类型与 episode"。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 417 orbit（17 skipped）+ 51 web；新增 `reports.test.ts` |
| 官方聚合：1/1 与 1/9 两批，sample 20%、task 55.6%；errors fail/exclude；partial | working tree | passed | 单元测试 |
| 报告只追加、相同结果不重复写、删除 job 时删除 | working tree | passed | 单元测试 |
| 真实 job（fixture external adapter，process 后端，3 任务 × 2 seed，1 任务 judge 失败） | working tree | passed | Orbit 100%、官方 66.7%（4/6），failure `judge_unavailable:2`，episode 保存；改 adapter 后重新评分 2 个 trial 只写 1 个 `rescore` 修订，修订 1 不变，计划 digest 不变 |
| Web 页面视觉检查 | — | not_run | 类型检查与构建通过，未在浏览器中查看 |
| 内置 harbor / asi 的官方规则 | — | not_run | 未声明：尚未核对其官方统计对 error 的处理，不猜测 |

## Next / open issues

1. 内置 harbor 与 asi 未声明 official 规则；需对照 Terminal-Bench / ASI 官方统计确认后再加。
2. attempt/retry 的显式计数与"补跑不额外授予重试"的规则尚未在提交路径实施（目前报告引用 trial 与 Run 作为 attempt）。
3. 多个 Trial 共享一个 Run 的批量执行（§9.1a）未实现。
