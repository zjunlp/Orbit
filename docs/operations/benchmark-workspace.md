# Benchmark 实验工作台

状态：工作台实现说明，包含 2026-09-28 的页面与易用性优化；集成事实以 Git 为准。面向本机单管理员，复用现有 Batch、Run、Records；不启动模型，不改变原生评分。

## 打开与登记

先按 [Web 控制台说明](web-console.md)安装并构建前端，再启动独立 Web：

```sh
pnpm build
uv run --locked agent-infra web --state-dir /absolute/path/to/console-state
```

打开服务输出的本机访问地址，默认进入「实验」列表。主导航保留实验、科研项目、资源和设置；科研运行列表及详情归属科研项目，注册任务、Agent 与 Records 记录入口可从设置进入，已有深链接继续有效。未登记的 Run、Campaign 和兼容性信息在列表底部的高级诊断中查看。点击「登记已有批次」，填写包含 `batch.json` 的**服务器绝对目录**。批次可以来自不同状态目录；登记会验证清单和冻结执行计划，不复制运行数据、不提交作业。最多登记 100 个目录，目录及状态路径不接受符号链接。

登记信息、名称、笔记、项目标签和默认基线保存在 Web 状态目录的 `benchmarks/console/workspace.sqlite3`。批次的 `state/benchmarks` 和原始 Records 仍是执行证据来源。移动已登记目录会显示读取错误，应登记其新位置；不要为消除错误而删除执行状态。数据库中的笔记单独备份，和原批次目录一起保存即可恢复工作台。

## 一次完整复盘

1. 在实验列表登记基线和新版批次，点击名称进入详情。顶部显示完整实验的均分、中位数、有效评分覆盖、零分数量与运行耗时中位数；点击零分数量可直接筛选。
2. 默认「任务结果」页支持名称/笔记搜索、领域（如任务标识包含已知领域）、状态与零分筛选、数值排序、20/50 条分页和 CSV。搜索、筛选、排序和页码写入 URL，刷新或返回仍可继续查看；筛选不改变顶部实验均分。
3. 点击任务名称进入详情。已完成任务默认看结果，未结束任务默认看已采集日志；轨迹深链接直接打开对应步骤。求解时限来自冻结配置，外层预算在技术信息中显示，两者都不当成实际耗时。
4. 在「Agent 轨迹」搜索命令、输出或错误，复制具体步骤链接。「文件与评分证据」优先列评分与提交文件，可以预览文本/图片并下载原始文件；「运行配置」用可读字段展示模型、版本与资源，完整 JSON 按需展开。
5. 在「实验笔记」保存实验名称、改动说明和项目标签。在「实验比较」选择另一组结果作为基线，查看共同有效任务的均分、逐题差值、提升/退步数量和配置差异；可只看有变化或不可比的任务。需要时进入「并排查看轨迹」。
6. 导出逐题 CSV、对比 CSV、Markdown 摘要；同任务集历史均分与 SVG 导出收在比较页的展开项中。只有一组实验时显示比较空状态。

所有冻结成员包括未提交任务均可查询。零分保留为数值评分，评分健康另行核验；执行失败、缺失评分、取消和清理未完成分别标示。已完成实验与任务停止周期读取，使用「刷新结果」或「刷新任务」按需获取；运行中每 5 秒读取持久记录。运行期间刷新失败保留上次数据，并显示读取错误。

科研项目页支持名称/目标搜索和状态筛选，继续提供初始化、方案、实验与结果入口。旧 Records 事件页与科研执行页共用可读事件组件，支持重点、全部、工具和 Agent 筛选；平台记录仍与原生 Codex 会话区分。

## 评分健康与研究复盘

批次与任务同时保留数值评分、评分健康、Agent 终止事件和原始状态。顶部提供「评分需要复核」「求解异常结束」「状态记录冲突」筛选。异常不会删除分数、填零或改变原聚合；比较、趋势和 CSV 同时提示或保留健康信息。`score_valid` 仍表示已有数值且原协议状态有效，不再把它解释成评测健康。

自动检查目前识别归档的 BenchFlow schema v2 中嵌套 `evaluator_unavailable` 和评分分项的文件/依赖缺失错误；硬性检查失败单独显示。终止事件来自本次归档 Codex JSONL 的最后一轮，区分正常结束、额度中断、其他失败和未知。不会把工具日志里的 `timed out` 当成 Agent 超时。缺失、损坏、超限或不支持的证据显示未知；「未发现已知异常」不是完整评分或科学正确性认证。只缓存有归档的已结束评分诊断，按状态目录、Run、attempt 和 artifact 身份隔离。

已有复盘收在批次任务表上方的「研究复盘」展开项，逐题结果页显示观察、解释和待验证假设，并链接本次可见归档文件或轨迹步骤。署名研究解读与自动检查分开。完整报告按 Markdown 原文安全显示和下载，不执行 HTML；报告内原始相对文件路径仍属于离线复盘目录，在线证据入口以经过验证的案例链接为准。

在批次页下载当前快照模板，然后上传不超过 64 KiB 的 JSON 附件；也可由管理员通过同一 HTTP 接口导入。`report` 最多 30,000 字符，`cases` 最多 100 项，每项至少一个证据链接；文件 `member` 与轨迹 `step` 二选一。示例（用模板中的真实 snapshot、revision 和本批次 Run 替换示例值）：

```json
{
  "schema_version": 1,
  "snapshot": "<从当前批次模板获取的 64 字符摘要>",
  "revision": 0,
  "title": "本轮研究复盘",
  "author": "复盘作者",
  "summary": "主要发现及其限制",
  "report": "# 完整复盘\n\n证据、结论和待验证假设。",
  "cases": [{
    "run_id": "<本批次 Run>",
    "observation": "保存的结果说明了什么",
    "interpretation": "如何解释以及哪些原因尚未证实",
    "next": "接下来验证哪个假设",
    "evidence": [
      {"label": "评分分项", "member": "outputs/benchflow_score.json"},
      {"label": "轨迹步骤 0", "step": 0}
    ]
  }]
}
```

快照绑定全批次的运行、attempt、执行计划、产物、指标和结果状态；新 attempt 或结果变化后旧复盘标为过期，当前摘要/逐题解释会收起，旧报告仍可查阅。更新使用 revision 防止覆盖其他作者的修改。后端检查 Run 归属、可见文件和可准确定位的步骤；导入者仍负责文字解读的证据质量。复盘保存在工作台自己的 `workspace.sqlite3`，不会写回原始批次，不提供自动调用模型复盘或重评。

## 如何解释图表

- 单批次均值是当前有效评分的**描述性统计**，不是原生套件或官方分数。未评分、失败、取消不默认补零；原生有效零分保留。
- 趋势只纳入同任务集合、材料与评分版本、且每题都具有所选有效指标的批次。横轴是批次时间顺序，不是不同题的完成顺序。重复任务的多次尝试不进入趋势。
- 两批次比较使用同任务且材料/协议一致的有效评分交集，同时显示覆盖分母。重复尝试、缺失题、评分无效和协议不同都有原因，不会偷偷选择最佳尝试。
- 模型、提示参数和预算可以作为实验变量变化，配置差异可展开检查；它们不同不表示同预算对照。不同任务集或未完成批次的单批均值不可直接当成性能提升。
- 本轮没有自动调用各 adapter 的原生套件聚合，也没有统计显著性或官方提交功能。多 seed 统计仍应遵循各 benchmark 的协议。

## 日志、轨迹和取消

实验列表会提示观察到的批次完成变化；可显式开启浏览器完成通知。页面关闭时不提供后台通知服务。

运行日志展示 worker 已写入 Records 的 combined stream 最后 64 KiB，可暂停显示更新。它不是容器实时 stdout 直连；worker 未推进时没有新日志。读取页面不推进队列、不恢复/重启任务。

规范轨迹在归档后可用。优先读取不超过 16 MiB 的完整 ASI 规范轨迹，否则使用已归档的有界视图；搜索范围与截断状态明确标示。Harbor 等适配器只要提供同一证据投影即可显示，不按 benchmark 名称建立另一个页面。每步展示上限 64 KiB；文件预览上限 1 MiB、下载上限 16 MiB。超过限制的原始产物仍可用 Records CLI 导出。原生实时 token 流、完整 ATIF 结构解析和跨页调用配对不是本轮能力。

「取消此任务」仅保存已有 Run 的取消意图，由对应批次的 worker 处理清理。任务结束前仍会显示待处理；不会清理其他任务或自动重试。批次停止后续提交、重新执行和创建新配置仍通过已有 CLI，见 [批量运行](asi-bench-batch.md)。

## HTTP 与维护入口

所有路径在 `/api/v1/benchmarks/workspace` 下，沿用 loopback Host 校验与 Bearer 认证：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/`（无尾斜杠） | GET / POST | 批次索引 / 显式登记目录 |
| `/{batch}` | GET | 全部冻结成员、当前结果、健康、笔记、复盘摘要与 review_snapshot |
| `/settings` | POST | 保存默认基线，带 revision |
| `/{batch}/review` | GET / POST | 读取完整复盘 / 导入绑定快照的复盘（带 revision） |
| `/{batch}/note?unit=...` | POST | 批次或任务笔记；乐观版本检查防覆盖 |
| `/compare?left=...&right=...&metric=...` | GET | 逐题可比性及共同有效样本统计 |
| `/{batch}/runs/{run}/detail` | GET | 配置、状态、评分与资源 |
| `/{batch}/runs/{run}/trajectory` | GET | cursor/limit/search/kind 查询归档轨迹 |
| `/{batch}/runs/{run}/files?member=...` | GET | 文件清单或有界 Base64 内容 |
| `/{batch}/runs/{run}/logs` | GET | 已提交日志尾部 |
| `/{batch}/runs/{run}/cancel` | POST | 保存取消意图 |

成员文件通过该 Run 自有 artifact manifest 与 Records blob 引用读取，不接受宿主机任意文件路径。私有评测、凭据与 secret 类 artifact/stream 不通过这些入口提供。笔记使用独立表和 revision；更新冲突需要刷新核对后保存。

源码分工：`projects/benchmark_workspace.py` 保存用户元数据；`runs/benchmark_views.py` 提供纯投影/比较，`runs/benchmark_evidence.py` 读取有界证据，`runs/benchmark_health.py` 解释健康，`projects/benchmark_review.py` 限定复盘附件契约；`bootstrap/benchmark_workspace.py` 组装状态与 Records；`features/benchmarks.tsx` 负责路由与数据组装；`features/benchmark/` 的 `batch-list`、`batch-header`、`batch-detail`、`batch-summary` 分离列表、详情标题、任务表与统计，`presentation.ts` 集中处理展示数据和筛选；`run-result`、`trace-reader` 与 `evidence-files` 负责复盘。科研与旧记录共用 `features/execution-events.tsx`。不引入图表库、第二套执行器或独立前端状态管理依赖。

## 验证范围

后端测试覆盖 60 题成员、缺失/无效/零分、协议差异、重复任务、登记完整性、Run 归属、搜索、笔记冲突、取消意图和日志提交边界。浏览器测试使用明确的合成数据，经过真实 HTTP 和 Records 读取路径，检查桌面/390px 手机布局、刷新、导出和步骤链接；不代表新模型或原生 benchmark 验收。

```sh
uv run --locked pytest tests/unit/benchmarks/test_workspace.py
node --test tests/web/benchmark.test.mjs
# 使用已有本机 Playwright/Chromium；服务和数据由脚本创建在临时目录。
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
node tests/web/benchmark.smoke.cjs
```

详见 [原工作台记录](../changes/20260926-benchmark-web-4f82c1.md)与[页面优化记录](../changes/20260928-web-workbench-usability-9a2c6e.md)。

本轮健康与复盘展示的实现和验证见[任务记录](../changes/20260928-web-evidence-review-3fa821.md)。
