---
record_version: 1
task_id: "20260929-web-visual-tokens-b5f2d8"
title: "Web 视觉第一梯队：设计 token、SVG 图标、状态徽章与总览仪表盘"
branch: "feat/web-visual-tokens"
base_commit: "6d143fd"
work_status: completed
updated_at: "2026-09-29T22:35:27+08:00"
pull_request: null
---

## Goal and acceptance

- 落实 Web 视觉优化第一梯队（不改 API、不引依赖、纯前端）：
  1. 设计 token：语义色（success/warning/danger/info）、统一圆角与阴影，替换 `style.css` 与 `workspace.css` 中散落的状态色；
  2. 内联 SVG 图标组件，替换侧边栏文本符号（▤ ◇ ▥ ⚙）与品牌块；
  3. Badge 语义变体（success/warning/danger/info/muted），按状态自动着色；
  4. 表格悬停高亮与状态可读性；总览页从标语页改为仪表盘（关注事项 + 运行中 + 快捷入口）。
- 验收：`pnpm build`（含 typecheck）通过；`tests/web` 现有逻辑测试通过；浏览器冒烟流程（console/workflow/benchmark）通过；不改变任何 HTTP 契约与后端行为。

## Changes

- `src/web/src/style.css`：新增语义色 token（`--success/--warning/--danger/--info` 及各自 `-bg/-border`、`--neutral-bg`）、圆角 token（`--radius-sm/md/lg`）、阴影 token（`--shadow-1/2`）与 `--focus`；新增 `.badge-{success,warning,danger,info,muted}` 变体类；表格 `tbody tr:hover` 高亮（`--accent-soft`）；`.panel` 加 `--shadow-1`，登录卡用 `--radius-lg` + `--shadow-2`；事件/轨迹过滤器等散落状态色全部 token 化；删除仅旧总览页使用的 `.hero` 规则；新增总览仪表盘样式（`.stats-4`、`.overview-grid`、`.overview-side`、`.run-row`、`.attention-*`、`.quick-links`）及 950px/680px 响应式；`.brand-mark` 改为图标块，侧边栏导航项 flex 对齐。
- `src/web/src/components/icons.tsx`（新增）：无依赖内联 SVG 图标（stroke=currentColor，`aria-hidden`），含 IconFlask/IconFolder/IconCpu/IconGear/IconGauge/IconAlert/IconCheck/IconCircleX 等。
- `src/web/src/components/common.tsx`：`Badge` 新增 `variant` prop（默认 `default`，不传时保持原外观）与 `statusVariant(status)` 状态→语义变体映射。
- `src/web/src/app.tsx`：侧边栏文本符号（▤ ◇ ▥ ⚙）与品牌块替换为 SVG 图标；总览页重写为仪表盘——4 张统计卡（科研项目/已注册任务/运行中/需要关注）、最近执行列表（含时间与状态徽章）、需要关注（失败运行 + 解析异常任务，空态显正常）、快捷入口；任务页异常任务徽标显 danger。
- `src/web/src/features/{runs,execution,project-detail,benchmark-diagnostics,projects}.tsx`：状态徽标全部接入 `statusVariant` 自动着色。
- `src/web/src/features/benchmark/workspace.css`：输入框/卡片/步骤/表格等边框与圆角统一到 token；正负增长、警告、得分格（score-present/zero/missing）、结果状态等状态色 token 化；悬停与 sticky 表头用 `--accent-soft`/`--canvas`；图表色（histogram-bar）保留不动。

## Decisions

- 不引入 UI 组件库与 CSS 框架，延续现有"轻依赖、手写样式"路线；图标为无依赖内联 SVG。
- 徽标变体默认值为 `default`，现有调用点不传 variant 时保持原绿色调外观，仅状态类调用点逐一接 variant。
- 手写 SVG 图表（对比曲线、直方图）不在本次范围，留待第二梯队评估图表库。
- 修复 biome `noDescendingSpecificity`：`.attention-row .icon` 改为对图标包装 span 设 `margin-top`，避免与侧边栏图标选择器形成降序特异性。

## Validation

| Check or command | Tested revision or snapshot | Result | Evidence or limitation |
| --- | --- | --- | --- |
| `pnpm --filter @agent-infra/web build`（tsc + vite） | feat/web-visual-tokens 工作区 | passed | 50 modules，dist 正常产出 |
| `pnpm check`（biome + typecheck） | 同上 | passed | 初报 2 格式错 + 1 CSS 特异性告警，已修复后全绿 |
| `node tests/web/benchmark.test.mjs` / `node tests/web/execution-trace.test.mjs` | 同上 | passed | fail 0 |
| `node tests/web/console.smoke.cjs`（Playwright + fixture 服务） | 同上 | passed | 项目增改/重载、导航、移动端宽度、退出登录均通过 |
| `node tests/web/benchmark.smoke.cjs` | 同上 | passed | 列表/详情/对比/导出/移动端等全通过 |
| `node tests/web/workflow.smoke.cjs` | 同上 | passed | 绑定/编译/提交/取消/产物/移动端全通过 |

## Open items and blockers

- None。第二梯队（图表库、路由与信息架构深化）未做，需另行立项。

## Next steps

- 提交本分支；由用户决定是否合并 main 或开 PR。

## Compatibility and rollback

- 纯前端样式与组件改动，无接口/数据/部署影响；回滚即还原本分支提交。
