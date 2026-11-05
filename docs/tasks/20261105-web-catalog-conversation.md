# Web：Catalog / 校准总览与 C3/C4 对话视图
branch: feat/web-catalog-conversation · status: completed · updated: 2026-11-05 · owner: Claude

## Goal

按 [design §9.15](../design.md) 与 [Web UI 调研](../research/web-ui/landscape.md)：校准成为 daemon 记录的一等结果；
Web 有按类别分组、能下钻到证据的 Catalog；C3/C4 trial 有以轮次为主线、联动 checker 与状态差异的对话视图；
并用真实模型（经 CLI Agent）跑一次 C3，验证视图对排查失败有用。

## Changes

- **校准**：判定逻辑移到 `contracts/calibration.ts`（CLI 与 daemon 共用）；`BenchJobSpec.calibration` 标记校准作业；
  `POST /bench/calibrations` 由 daemon 抽样建作业，结束后自动重评一次（`BenchJob.rescore`），`GET /bench/jobs/:id`
  的 `calibration` 给出报告；清理确认前不判定。`orbit bench calibrate` 改用该 API，输出不变。检查带失败 trial 列表。
- **Catalog**：`GET /bench/catalog`（任务列表后台缓存 10 分钟、逐个刷新、失败保留错误；未列出时用最新作业的能力分组；
  最近 5 次校准；真实方法按 agent · model · effort 归并；保真度）；`capabilities.parity` 供 adapter 声明与原版对齐的证据。
  Web Bench 的 "Registered environments" 改为 Catalog：可筛选的统计、按类别分组的单表、行展开（Calibration / Coverage /
  Methods / Conditions）、就地发起校准。
- **对话轨迹**：review kind `conversation` 与契约 `ConversationTrajectory`（轮次、消息、工具调用与结果、轮次检查与状态、
  verdict 的首个失败轮次 / 说明 / 计分与诊断检查、终态差异、producer / trust / completeness）。BFCL verify 由独立重放写出
  （对前缀运行原版 checker 定位首个失败轮次，之后 `unchecked`；常见失败类型附说明）；τ² verify 由已验证的模拟、原版 reward
  检查与重放出的终态 DB 写出。
- **对话视图**：`pages/trial/Conversation.tsx` 三栏（轮次 / 对话 / 检查器：Check、State diff、Reference vs actual、Final state、
  Raw），失败轮次的调用默认展开、状态值可展开、`h` `l` `e` `/` 键位、检查器可加宽；Trial 页上一 / 下一 / 下一个失败。
- **BFCL CLI Agent**：`bfcl_mcp.py`（标准库 stdio MCP），adapter 对 CLI 方法给 `agentTask` + 工具，`requires: mcp`。
- 每一轮界面改动后用 Playwright 截图，交 Codex（gpt-6.1-sol）做视觉与可用性评审，共四轮，主要问题已修。

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | 合并前 | passed | Orbit 592 / 26 skipped、Web 69 |
| BFCL 适配器测试（镜像内，含真实 bfcl-eval） | 合并前 | passed | 23 项：首个失败轮次与 unchecked、MCP 会话记录→verify 重放、拒绝调用、CLI 方法无 ground truth |
| τ² 适配器测试（镜像内，真实上游） | 合并前 | passed | 17 项：对话轨迹的检查与终态差异（oracle 一致、empty 不一致） |
| 真实 Docker 校准（新 API） | 合并前 | passed | 隔离 daemon：BFCL、HumanEval、τ²、TextArena 各 2 任务 × 2 seed，daemon 自动重评；τ² 首次显示清理未完成后修正为等清理确认再判定 |
| 契约一致 | 合并前 | passed | 本机 16 份 BFCL/τ² verify 生成的 conversation.json 均通过 `ConversationTrajectory` 校验 |
| 真实模型：Codex gpt-6.1-sol 经 MCP 跑 BFCL | 合并前 | passed | 4 题（base ×2、miss_func、miss_param）全部 valid，2/4 通过；失败分别定位在第 4 轮（response mismatch）与第 3 轮（空响应，后续 unchecked）；重评 4/4 分数不变 |
| Web 截图评审 | 合并前 | passed | Catalog 2 轮、对话视图 2 轮 + 真实数据 1 轮 + 终检；静态截图，未做交互自动化 |
| τ² 用户模拟器 | — | not_run | 需要用户模型的调用来源；ARK 方案要求经 Agent 工具调用，不允许脚本直接调用 |

## Next / open issues

- 浏览器端交互（展开、键位、滚动联动）只做了渲染测试与静态截图，没有自动化交互测试。
- Catalog 的任务列表缓存只在内存，daemon 重启后需重新列出；吞吐与大目录（EFE 2,260 任务）下的首屏耗时未测。
- BFCL MCP 脚手架与榜单 FC 提示不同，分数不可与榜单比较；如需对齐需另做原生 FC 方法。
- τ² 的真实用户模拟器、C1 judge 类与 C7 多人对局的视图尚未做。
