# 本机 Web 控制台使用说明

状态：W01/W02 已实现。单管理员、单节点控制台，支持项目初始化、方案查看、实验提交、取消、结果和分析。
[W 设计与维护边界](../architecture/web-research-workflow.md)；[验证记录](../changes/20260920-web-workflow-w84d2a.md)。

主导航为「实验、科研项目、资源、设置」，默认进入实验列表。科研项目页提供「查看科研运行」入口；运行列表 `#runs` 和运行详情 `#execution/<run>` 均归属「科研项目」，直接打开或刷新也保持该导航高亮。旧任务、Records 和 Agent 页面收在设置中，原有链接仍有效。Benchmark 结果复盘见[实验工作台](benchmark-workspace.md)。

## 启动与访问

前提：仓库根目录完成 `make setup`，随后构建前端。

```sh
pnpm build
uv run --locked agent-infra web --state-dir /absolute/path/to/infra-state
```

`--state-dir` **必须与 init、project、research 和 controller 使用同一目录**。
省略时采用 `AGENT_INFRA_STATE_DIR` 或用户状态目录，与 CLI 默认相同。
仅查看或创建项目不需要 Docker、Agent 账号或 Controller。

需要提交实验时，在另一终端保持 Controller 运行（以管理员批准的资源额度为准）：

```sh
uv run --locked agent-infra controller serve \
  --state-dir /absolute/path/to/infra-state --cpu 1 --memory-gib 2
```

Docker、Codex 认证和兼容镜像的准备见[本机执行指南](../reference/local-run-controller.md)。
Web 不自动安装软件、登录账号、启动 Controller 或容器。页面预检会给出缺项。
当前 D 执行入口支持 Codex 无评测 CPU 科研 Task；Agents 页面显示其他 provider 的安装状态，不意味着它们也能从这个入口执行。

终端打印带 `#token=...` 的完整访问链接，默认端口 8765。浏览器读取后移除 URL 中的 token，
保存在当前标签页 sessionStorage。同一标签页重新打开登录链接也会更新令牌并返回实验列表，无需新建标签页。令牌随 Web 重启失效；退出清除令牌。Ctrl+C 停止 Web，不取消 Controller 中的实验。
不要公开该访问链接。服务器只绑定 `127.0.0.1`，从个人电脑连接远端服务器可运行：

```sh
ssh -N -L 8765:127.0.0.1:8765 user@server
```

在电脑浏览器打开完整链接。这里没有公网反向代理、TLS 或多人权限支持。
不同工作区使用不同端口、状态目录和 `--console-dir`。wheel 未包含 Web 资产，独立安装需传 `--web-root`。
`make dev-web` 仍是无 API 代理的前端开发入口。

## 常用工作流

1. **新建项目**：输入名称、研究目标、服务器绝对工作区路径。父目录必须存在，目标目录不得是已有其他目录。
   初始化与 CLI 共用服务，创建 docs、code、configs、data、runs、artifacts；不会调用模型。
2. **查看研究方案**：通过 Agent / CLI 完善并采用方案后，项目页显示 Brief、Plan、未知项、最新与已采用版本。
   [规划指南](../reference/research-planning.md)说明保存和采用方式；Web 本批不提供聊天或方案编辑器。
3. **选择实验**：只选择已采用版本的实验。填入项目内执行 YAML，点击“编译材料快照”，或直接选择已有快照。
   缺少数据、资源配置或未知项会列出问题。执行 YAML 示例见[CPU 示例](../../examples/research/cpu-statistics/README.md)。
4. **预检与提交**：填写 Codex 模型、运行时限、联网选择。点击“检查环境与资源”，核对 CPU、内存、GPU 和阻塞原因，
   然后“确认提交一次实验”。这一步会启动模型并产生账号费用。修改参数需重新预检，最终提交还会重新检查资源。
5. **跟踪和取消**：页面进入持久 Run 地址，刷新后仍可恢复；从项目或运行页也能找到它。
   点击取消是提出请求，等待实际清理完成后才算结束。项目进度、Run、Job、执行结果、评测和清理状态分别显示；常见运行状态在页面显示为中文，“已结束”仅指生命周期结束，不代表实验成功。
6. **查看结果**：点击已归档产物展开文件；文本可预览，文件可下载。Agent / CLI 保存的 I 批分析显示在项目页，
   包括观察、解释、不确定性、建议及实际数值证据。分析不是平台对科学结论的自动认证。

Controller 不可用时，初始化与持久结果仍可读取，提交/取消按钮显示不可用原因。
同一标签页中，网络失败后的同参数重试保留操作 ID；Controller 不会重复启动该请求。
如果已收到成功回执后再主动提交一次，则属于新运行。关闭标签页前，遇到不确定结果先去运行列表核查。

## 旧项目与其他页面

旧项目仍来自 `--console-dir/projects.sqlite3`（默认 `var/console`），ID、目标、里程碑和关联不会丢失。
未绑定项目不会因为浏览而创建目录。在详情页可明确关联到一个已有工作区，重复相同绑定幂等；不自动覆盖双方目标。
旧条目与工作区条目均保留，所以列表数量是条目总数，可能包含同一研究的两个入口。

旧任务继续用 `--task path/to/task.yaml` 注册，可重复传入；路径哈希会记录对应的 Task ID / revision。
未注册或版本改变的旧关联标记待处理，编辑其他字段不会丢弃它。
绑定不把旧里程碑、旧任务伪装成新的研究方案；已有 Run/Task 身份不改写。

默认 Records 与 Controller 共用 `--state-dir/controller/records`。
如果过去使用 `var/runs/_records` 等目录，必须显式传入：

```sh
uv run --locked agent-infra web \
  --state-dir /absolute/path/to/infra-state \
  --records-root var/runs/_records --console-dir var/console \
  --web-root src/web/dist --task examples/task-packages/file-result/task.yaml --port 8765
```

`--records-root` 为额外的历史查询来源，不改变科研工作流的 Controller 状态或产物来源。
运行页分“科研工作流运行”和原 Records 列表；旧 Run 继续用旧详情入口查看事件与产物索引。
H/E/I 的 Run 与 Job 状态可查看；长期环境关闭、环境构建取消、Planner 停止仍用对应 CLI/MCP，页面不提供假按钮。

资源页保留真实 CPU/内存/NVIDIA 监控、过期提示和短期趋势；它不是 Controller 的授权剩余额度。
Agents 只探测已安装/认证状态，缓存 60 秒。任务页只显示 `--task` 注册的可见描述，编译任务在项目详情选取。
实验页支持登记跨目录批次、查询结果、比较、查看归档轨迹/产物和保存笔记。单任务取消会保存请求供对应 worker 处理，不提供网页提交或重跑。实验列表底部的「高级诊断与兼容性」读取同一 `--state-dir` 的等待队列、租约、近期运行、Campaign 候选和兼容矩阵；此诊断视图仍只读，不展示原生私有评测正文。操作与证据级别见[工作台说明](benchmark-workspace.md)和[BM07 参考](../reference/benchmark-delivery.md)。

## 读取与安全边界

- 科研项目与活动 Run 详情每 5 秒刷新；已结束 Run 停止轮询，事件支持按需刷新。轨迹是已持久化的分页事件，不是实时 token 流。事件正文采用既有展示摘要，最多 8,000 字符。
- 运行页的“平台执行记录”把同页内相同 call ID 的工具请求和响应合并为一项，显示中文操作名、本地时间、调用耗时、Job 状态及 Attempt 采集范围；仍可展开安全字段。默认“重点”隐藏常规读取/状态查询，“全部”保留每项公开事件，也可查看“工具调用”或“Agent”事件。失败与采集缺口始终留在重点视图。
- 事件分页可逐页前进和返回；筛选只作用于当前页，分页边界上的请求与响应可能分开显示。“本页未见响应”不代表调用仍在运行，需查看相邻页或稍后刷新。
- 此页记录资源、容器、MCP 工具和任务状态，不等同宿主机 Codex 原生会话。网页不返回平台工具的原始参数、结果 blob 或私有事件；Agent 原生流是否完整以采集范围为准。
- 产物沿 D 的 RunQueries 读取，先过滤 visibility / data_class，再按 manifest 精确匹配成员。拒绝私有评测、凭据、secret 及 evaluator/admin 内容。
- 单文件下载最多 16 MiB；JSON/CSV/文本等预览最多 256 KiB。更大文件走现有本地 Records 工具；不暴露任意宿主机文件路径。
- React 纯文本展示，下载作为文件处理，不把实验产生的 HTML 当页面运行。Controller 凭据留在服务端，浏览器仅持有 Web token。
- 原始日志不做任意下载；公开归档产物可下载，未标记的普通 Agent 输出不具备自动秘密识别能力。
- 项目详情最多最近 100 个编译快照、100 个 Run、20 份分析；运行列表每页 100 条。更完整历史仍通过 CLI 查询。
- 目录、数据库和写入者均为可信本机输入。浏览器身份是本机管理员，不是面向外部用户的项目级授权。

## HTTP 增量接口

前缀 `/api/v1`，Bearer 鉴权。POST JSON 最大 64 KiB。旧 resources/agents/tasks/runs/attempts 接口保留。

| 方法和路径 | 行为 |
| --- | --- |
| `GET /capabilities` | 实测 Controller 可用性、工作区/产物能力及不可用原因 |
| `GET /projects`、`GET /projects/{id}` | 联合列表、方案、编译 Task、运行与分析 |
| `POST /projects/init` | `goal/name/directory/operation_id`；与 CLI 同一初始化服务 |
| `POST /projects` | 只编辑已有旧 catalog 项目；携带原 id/revision |
| `POST /projects/{id}/bind` | 明确绑定已有 `project_id` |
| `POST /projects/{id}/compile` | C 接口的 `experiment_id/research_revision/execution` |
| `POST /projects/{id}/preflight`、`/submit` | D SubmissionRequest；提交另需 operation_id；校验当前采用版本 |
| `GET /execution/runs?offset=0`、`GET /execution/runs/{id}` | Controller 持久状态与 Job 摘要 |
| `POST /execution/runs/{id}/cancel` | D 实验取消，经已有 Controller |
| `GET /execution/runs/{id}/events?cursor=...` | 过滤后的事件页 |
| `GET /execution/runs/{id}/artifacts` | 可见产物索引 |
| `GET /execution/runs/{id}/artifacts/{artifact_id}?member=...` | 无 member 返回文件索引；有 member 返回 base64 内容 |
| `GET /benchmarks` | 只读 benchmark 排队、租约、近期 Run、Campaign 和兼容矩阵摘要 |

参数问题 400，鉴权失败 401，Host 不符 403，记录不存在 404，项目冲突 409，内部不可用 503。
Controller 拒绝信息通过 Web 的 400 返回具体原因；能力探测失败提供禁用提示。
API 是当前本机 UI 接口，尚未承诺第三方长期兼容。

## 验证与排障

```sh
make verify
uv run --locked pytest tests/unit/web -q
```

可选浏览器回归需要已有 Playwright / Chromium，未增加产品依赖：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome-headless-shell \
node tests/web/workflow.smoke.cjs
```

新流程测试使用真实 HTTP、SQLite、Projects、Records 和 Controller；Agent/Environment 为明确测试替身，不调用模型或 Docker。
`tests/web/console.smoke.cjs` 继续验证旧页面及实际宿主机只读资源采样。截图仅写 `/tmp/agent-infra-w-*.png`。

401：Web 重启后重新连接新链接。Controller 未连接：检查同一 `--state-dir`，启动前台 controller serve。
Web 与 Controller 支持任意启动顺序，共用的 `controller/` 目录首次创建为 `0700`。
如果已有目录提示权限错误，先核实目录归属及其他服务的使用情况，再将该目录权限设为 `0700`；
程序不会自动修改已有目录的权限。显式状态路径不允许符号链接，使用真实绝对路径。
`config-check` 默认目录已与这些入口一致；显式 TOML 仅用于配置检查，不会改变运行命令的状态目录。
数据为空：确认状态目录、历史 `--records-root` 和 `--console-dir`，不要删除数据库来消除错误。
预检未通过：按返回原因补齐镜像、账号、材料、环境锁或资源；不自动替换失败集成。
项目 revision 冲突：保留编辑内容，重新读取后合并。初始化未完成：使用 `project recover`，不直接覆盖工作区。
备份时同时考虑旧 catalog（含新增映射表）、Projects 和 Controller/Records；仅回滚代码不会删除它们。

无模型 Docker 衔接回归：`uv run --locked pytest -m e2e tests/e2e/test_web_research.py`。
需要本机 Docker、已有 `python:3.12-slim` 镜像及空闲单用户 Controller 槽位；测试先开 Web，
再启动真实 Controller、执行 CPU Job、归档指标并读取分析，最后验证服务离线后历史仍可读取。
容器请求 0.5 CPU / 256 MiB，不调用模型；页面交互继续由上面的浏览器测试覆盖。

## Benchmark 实验工作台

本轮工作台扩展支持登记不同目录的已有批次、完整成员查询、同任务评分比较、轨迹与产物复盘、笔记和导出，以及保存单 Run 取消意图。原有只读诊断接口保持兼容。使用范围、评分口径与新接口见 [Benchmark 实验工作台](benchmark-workspace.md)。
