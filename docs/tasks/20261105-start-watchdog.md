# 启动看门狗：镜像拉取与构建的期限
branch: feat/start-watchdog · status: completed · updated: 2026-11-05 · owner: Claude

## Goal

真实运行中发现：`docker build` 因代理不可用卡住时，Run 一直停在 starting（4 个并发名额被占满，后续全部排队），
只能人工发现并杀掉构建进程。

## Changes

- `executor/docker.ts`：`buildImage` / `pullImage` 接受 `timeoutMs`；到时先 SIGTERM、10 秒后 SIGKILL，返回
  `IMAGE_TIMEOUT`（124），日志追加一行说明。`imageDeadlineMs()` 读 `ORBIT_IMAGE_DEADLINE_MIN`（默认 60 分钟）。
- `runs/launch.ts`：两者都带这个期限；超时以"made no progress within N min and was stopped"作为失败原因（不写成
  普通构建失败，避免被误当成任务本身的问题）。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | feat/start-watchdog | passed | 见提交时的完整输出 |
| 单测：卡住的 docker 在期限内被停止 | 同上 | passed | 假 docker 只 sleep，1.5 s 期限返回 124 且不挂起 |
| 真实超时 | — | not_run | 未在真机上等满 60 分钟；用假 docker 覆盖了同一代码路径 |
| 真实构建正常完成不受影响 | 同上 | passed | TextArena 游戏镜像真实构建（数分钟）未被期限打断 |
