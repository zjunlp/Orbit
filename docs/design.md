# Orbit 设计

状态：R0 已确定的目标设计；R1–R3 已实现；R4（多节点，§8）已实现，仅在同机双 daemon 仿真上验证。实现进度见 [status.md](status.md)。本文是架构与接口的唯一权威来源；
改变模块边界、公共契约或关键决策时，在同一分支更新本文。

## 1. 定位

> Orbit 让 Codex / Claude Code 等 Agent 在隔离的 Docker 中按资源规则运行实验，
> 并完整记录过程与结果；Web 用于本地复盘。

- **Agent 是本体**：规划、写代码、分析由 Agent 和人完成。Orbit 不启动"规划 Agent"、不审批研究方案、不编排科研流程。
- **Orbit 是插件和规范**：提供 CLI（Agent 通过 bash 调用，`--json` 输出）、薄 MCP、skill 与约定（指标、产物、实验笔记的写法）。
- **两种用法，同一个执行原语 Run**：
  1. 日常科研：宿主机上的 Agent 改代码 → `orbit run` 把代码快照放进容器跑 → 监控、比较、复盘。
  2. 刷榜：`Agent + 方法包 × Benchmark`，每个 trial 在容器中运行 Agent，再独立评测，保留轨迹和分数。
- **使用范围**：单人使用；一台或多台自己的机器（可跨网络，Tailscale）；空闲资源都可以用。
- **不做**：多用户/权限、云控制面、自研 Agent 循环、自研实验追踪全功能替代品、官方榜单自动提交、手机对话（后续再议）。

## 2. 总体结构

```
Agent (Codex / Claude Code, on host)
  │  plugin: skill + hooks      CLI: orbit ... --json      MCP (thin, optional)
  ▼
orbit daemon (one per node; single writer of local state)
  ├─ resources   ledger of GPUs/CPU/memory (+ future devices), probes, leases, queue
  ├─ runs        Run lifecycle, scheduling loop, sweeps, rerun
  ├─ executor    docker backend (process backend for native benchmark runners)
  ├─ workspace   code snapshot (commit + diff), mounts, named datasets/weights
  ├─ images      base images, project Dockerfile build cache
  ├─ auth        credential profiles for harnesses (login / API key / relay base URL)
  ├─ harness     how each Agent CLI is installed, configured and parsed inside containers
  ├─ records     logs, metrics, artifacts, events, notes
  ├─ sessions    host Agent session capture (Codex, Claude Code) linked to runs
  ├─ bench       adapters, agent profiles + method bundles, trials, outcomes
  └─ cluster     node join, heartbeat, code bundles, remote placement and mirroring (R4)
  ▼
Web (local SPA served by the daemon): runs, compare, logs, sessions, bench review
```

技术栈：TypeScript（Node 24，开发时直接运行 `.ts`），`node:sqlite`（无原生依赖，便于 npm 安装），
直接调用 `docker` / `nvidia-smi` / `git` 命令行，Hono HTTP，zod 契约，commander CLI，
vitest 测试，Biome 格式/lint，tsdown 打包。发布为单个 npm 包 `@zjunlp/orbit`，命令 `orbit`。

分发：`pnpm pack:release` 先构建 Web、CLI 与契约 JS / 声明文件，生成包含 Web、README 与 MIT 许可的
tarball（含共享 skills 与 dsh 薄入口）；pnpm 的 `publishConfig.exports` 将仓库内源码入口替换为发布包的 `dist` 入口。
`pnpm smoke:package [tarball]` 在仓库外安装，验证 CLI、导出、自动 daemon 与 Web 资源。
用户通过 `npx -y @zjunlp/orbit doctor` 试用或 `npm install -g @zjunlp/orbit` 安装。
`orbit plugin install [claude|codex|dsh|pi]` 调用各平台原生安装器，省略平台仍默认 Claude。
Claude / Codex 注册 `zjunlp/Orbit` marketplace 后安装 `orbit@orbit`；Codex 使用根 `plugin.json` 和
`.agents/plugins/marketplace.json`。dsh 必须指定带 skills 服务的 `--profile`，通过 npm bundle 的
Cordis patch 挂载薄入口，委托宿主的 filesystem provider；本地包通过 `file:` 安装，避免目录链接在
profile 外解析不到宿主依赖。pi 通过 npm 包的 `pi.skills` 发现 skills；本地目录注册需保留该目录。
dsh / pi 默认安装与当前 CLI 相同版本的 npm 包，不引用 npx 临时缓存。各平台只有
`plugin/skills/` 一份源文件，构建时复制入包；无全局 CLI 时使用 npx。安装器不改 daemon 状态或凭据。
插件支持不扩展容器内 harness、auth 或会话解析（目前仍只有 Codex / Claude）；MCP 独立待实现。
GitHub Release 的 `v<version>` 标签触发 npm 发布工作流，通过 npm trusted publishing 认证；首次发布需要维护者登录。

## 3. 代码布局与依赖方向

```
packages/orbit/src/
  contracts/   zod schemas + types shared by daemon, CLI, MCP and Web (no runtime deps on modules)
  lib/         small generic helpers (process exec, ids, time, fs)
  config/      paths (~/.orbit), config file, daemon endpoint/token
  store/       sqlite access and migrations
  resources/ auth/ images/ workspace/ executor/ harness/ records/ notify/ sessions/   domain modules
  feishu/      Feishu app bots (long connection, pairing, read-only commands); uses notify
  runs/        orchestrates domain modules into a Run
  bench/       builds trials on top of runs
  cluster/     multi-node (R4)
  daemon/      HTTP API + scheduler loop wiring (composition root)
  client/      typed HTTP client for the daemon API
  cli/         commander commands; talks to daemon through client only
  mcp/         MCP tools; talks to daemon through client only
  bin.ts       composition root of the `orbit` executable (wires cli + daemon); nothing imports it
  dsh.ts       optional host plugin entry; delegates skill loading to dsh's filesystem provider
packages/web/  React SPA (Vite, uPlot); imports `@zjunlp/orbit/contracts` types only; built into
               packages/orbit/dist/web and served by the daemon
plugin/        canonical skills/orbit and skills/orbit-bench; portable / Claude manifests and dsh bundle patch
examples/      bench-adapters/<benchmark>/: external bench adapters (not part of the package)
```

规则（由 `pnpm check:boundaries` 强制，定义在 `scripts/boundaries.ts`）：

| 模块 | 可以依赖 |
| --- | --- |
| contracts, lib | 无（contracts 仅依赖 zod） |
| config, store | contracts, lib |
| resources, auth, images, workspace, executor, records, notify | contracts, lib, config, store |
| harness | 上一行 + auth |
| sessions | contracts, lib, config, store, records, harness |
| runs | 以上所有 domain 模块 |
| bench | runs 及其可依赖的模块 |
| cluster | runs, resources, workspace, records 及基础模块；runs 不依赖 cluster（经 `runs/placement.ts` 的 `RemotePlacement` 注入） |
| feishu | contracts, lib, config, store, notify（经注入的函数调用 daemon 自己的 API） |
| daemon | 除 cli/mcp/client 外全部 |
| client | contracts, lib, config |
| cli, mcp | client, contracts, lib, config |
| web (`packages/web/src`) | 自身文件；`@zjunlp/orbit` 只能 `import type` 自 `@zjunlp/orbit/contracts`，另可在运行时使用无依赖的 `@zjunlp/orbit/naming`（Run 显示名规则）与 `@zjunlp/orbit/metrics`（bench 指标的取值、聚合与格式化） |

- **源码文档与个人使用记录分开**：`docs/` 只记录通用架构、功能、问题和开发验证。个人实验成绩、批次进度、
  重跑/归并过程、私有资源配置及账号或机器清单放在源码仓库外的用户侧笔记中，不进入任务文档、提交说明或 PR。
  Orbit 的运行记录仍由 daemon 管理；需要给 Run 添加笔记时使用现有 `orbit note` API 路线。
- **daemon 是本机状态的唯一写者**。CLI/MCP/Web 只通过 HTTP API 访问；CLI 需要时自动拉起 daemon。
  daemon 只监听 `127.0.0.1`（默认端口 7717，被占用时——同一台机器上另一个用户的 daemon——自动换空闲端口；`ORBIT_PORT` /
  `--port` 指定的端口被占用则报错），启动时生成随机 token，与地址一起写入
  `~/.orbit/daemon.json`（0600）；所有 `/api/v1` 请求需 `Authorization: Bearer <token>` 或 Web 登录后的
  HttpOnly cookie（token 比较为常数时间；凭 cookie 的写请求须同源，否则 403）。`ORBIT_HOME` 可覆盖 `~/.orbit`。
- **小状态与大数据分开**：`ORBIT_HOME`（默认 `~/.orbit`）只放数据库、profile、配置与 daemon 端点；Run 目录、bench
  staging、代码 bundle 放在**数据目录**（`ORBIT_DATA`，否则 `<home>/config.json` 的 `dataDir`，否则 `ORBIT_HOME`）。
  `orbit config data <dir>` 写配置（比环境变量可靠：自动拉起的 daemon 总能读到），重启 daemon 生效，已有 Run 不自动搬。
  `doctor` 报告数据目录与 Docker `DockerRootDir` 的剩余空间，在系统盘上或空间不足（少于磁盘的 10%，下限 50 GB、上限 500 GB）时给 `warn`。
  资源探测的磁盘也是数据目录所在的盘。
- `src/` 根目录下的文件（如 `bin.ts`）是组合根，可引用任意模块，但不能被模块引用。
- 同类能力只有一份实现：一个 Run 状态机、一个资源账本、一个记录库。
- Docker、sqlite 句柄不出现在 contracts 中。

## 4. 核心契约（R1 目标，字段以 `contracts/` 为准）

**ResourceRequest**：`{ gpus, gpuMemGB?, gpuIds?, cpus, memGB, node? }`。Agent 按任务估算后提交；
不满足时排队，而不是失败。

**Lease**：`{ id, runId, node, gpuIds, cpus, memGB, state: active|released }`。
只有确认容器已清理才释放。

**资源可用性**：可用 = 探测到的硬件 − Orbit 活动租约 − 外部占用。外部进程占用显存超过阈值
（默认 1 GiB）的 GPU 视为不可用；外部进程退出后自动变为可用。CPU 的外部占用 = 实测使用中的 CPU
（`/proc/stat`，上升立即生效、下降按 30 s 时间常数衰减）− 已创建满 60 s 的租约 − 噪声余量
（5% 核数，至少 1 核）；刚创建的租约尚未体现在实测中，故不扣除（偏向排队）。内存同时受
`MemAvailable` 约束。只影响准入，不抢占运行中的 Run。

**谁占着 GPU**（`resources/gpu-procs.ts`）：把 `nvidia-smi --query-compute-apps` 的每个 pid 补成
`Gpu.processes` 的一项 `{ pid, memMiB, user, command, startedAt, container, runId }`：用户取自
`/proc/<pid>/status` 的 uid 加上 `/etc/passwd`；启动时间 = `/proc/stat` 的 `btime` 加上
`/proc/<pid>/stat` 第 22 字段的时钟节拍（`getconf CLK_TCK`）；命令只记进程名和它跑的脚本或模块
（`python -m vllm...`），**不记参数**（可能含 key）；容器名与 `orbit.run` 来自一次缓存的
`docker ps`（5 s）。读不到的字段（别的 PID namespace、进程已退出、无权限）为 null，界面显示
unknown。纯粹用于展示：准入只看显存占用。

**RunSpec**：
```
{ name?, project?(repo path), image | dockerfile, command(argv), resources,
  mounts[{ source | dataset, target, mode: ro|rw }], env, passEnv[], network(default true),
  snapshot(default true when project set), auth?(profile name), collect[], tags, parentId?,
  services[], networks[{ name, internal }], runNetworks[], dependsOn[], after?, mkdirs[],
  hooks[{ service?, command, timeoutSec }] }
```

**Run**：`{ id, spec, state, exitCode?, node, remote, origin?, leaseId?, containerId?, code{commit, dirty, diffRef},
createdAt/startedAt/endedAt, cleanup: pending|done|failed, usage? }`

- `state`: `queued → starting → running → succeeded | failed | cancelled | lost`。
- 执行结果（state/exitCode）、清理状态（cleanup）、评测有效性（bench 中）是三个独立字段。
- `remote`：主节点上的镜像记录，Run 实际在 `node` 上执行；`origin`：worker 上替主节点执行的 Run 的主节点名（§8）。
- mount 二选一：`source`（本机绝对路径）或 `dataset`（命名数据集，在执行节点解析为本地路径）；
  `target` 为绝对路径、互不重复、不含 `..`，且不能落在 `/orbit` 下（有 project 时也不能落在 `/workspace` 下）。`collect` 路径同样不含 `..`。
- `env` 的值随 Run 记录保存，只放非密钥配置；密钥用 `passEnv`（只记变量名，启动时从 daemon 环境读取，
  值按名字规则在日志中脱敏）。CLI：`-e KEY=VALUE` / `--pass-env VAR`。

**服务容器**（`RunSpec.services`，Harbor 的 docker-compose 环境用）：Run 容器旁边的附属容器（如模拟器、评测服务），
`{ name, image | dockerfile + context, command?, env, workdir?, cpus?, memGB?, healthcheck?, dependsOn, networks,
init, readOnly, tmpfs, capAdd, capDrop, securityOpt, pidsLimit?, collect }`，同一 Run 的一部分，不是另一条执行路径：
- 租约 = Run 自身资源 + 各服务的 `cpus`/`memGB`（没有限额的服务不设限，按 1 CPU / 1 GB 计入租约）；GPU 只给 Run 容器。
  有服务的 Run 只在提交节点运行，只用 docker 后端，不能用 host 网络。
- 启动：构建 / 拉取服务镜像 → 创建 per-run 网络 `orbit-<run>-<name>`（`default` 总是存在，Run 无网络时它是
  internal）→ 按依赖顺序启动服务（别名 = 服务名，标签 `orbit.parent=<run>`），依赖项有 healthcheck 等到 healthy、
  否则等到 running → 等 `dependsOn` 后启动 Run 容器（别名 `main`）。这些都在 `startedAt` 之前，失败即环境失败。
  执行时限从 Run 容器启动开始计。
- 结束：Run 容器退出并采集后，先记下运行中坏掉的服务（非 0 退出、OOM、unhealthy → `Run.services[].failure`，
  bench 记为 invalid），再停止服务，把日志与 `collect` 路径存到 `output/services/<name>/`。
- 清理：删除 Run 容器、`orbit.parent` 服务容器和网络，全部确认后才释放租约；daemon 重启后同样按标签清理。

**after 阶段**（`RunSpec.after`，Harbor shared verifier 用）：`{ command, timeoutMin, env, passEnv, copy[{ source, target }],
network?, collect }`，在 `command` 结束（或到时被停）后于**同一容器**里运行，看到它留下的文件与仍在运行的进程：
- 容器命令包一层 `/orbit/phases/run.sh`：命令在自己的 session 中后台运行（有 `setsid` 时），退出码写入
  `/orbit/phases/main.exit`，容器保留。执行时限只停命令（整组进程），after 阶段照常运行；取消则停整个容器。
- 命令结束后：先采集 `collect`（命令留下的样子），把 `copy` 复制进容器（如 `tests/`，命令运行时不可见），按需断开 /
  接入网络，`docker exec -d` 启动 after 命令（输出与退出码写入 `/orbit/phases/`，密钥经 env-file），按其时限等待，
  采集其 `collect` 到 `output/after/`，再停容器、收服务、清理。状态记在 `Run.after { state: running | succeeded |
  failed | timeout | skipped | error, exitCode, reason, startedAt, endedAt }`；其输出在容器日志排空后接到 Run 日志。
- 状态都在文件里，daemon 重启后接着等命令或 after 阶段。Run 的 state / exitCode 只反映 `command`。
  after 阶段的用量计入同一容器的 usage。

**hooks**（Harbor `[[verifier.collect]]`）：命令结束后、采集前执行的 shell 命令（同样靠保留容器的阶段脚本）：
先在 Run 容器里执行，没有 after 阶段时随后停掉 Run 容器，再在服务容器里执行（同 Harbor 顺序）；各自有时限，失败只记事件。
`mkdirs`：容器命令前先建目录（尽力而为），Harbor 任务用它建 `/logs/{agent,verifier,artifacts}`。

**容器内约定**（skill 告诉 Agent；实验代码直接用环境变量）：

| 路径 / 变量 | 含义 |
| --- | --- |
| `/workspace` | 代码快照（可写副本；原仓库不受影响） |
| `$ORBIT_OUTPUT` = `/orbit/output` | 产物目录，自动归档 |
| `$ORBIT_METRICS` = `/orbit/metrics.jsonl` | 每行一个 JSON：`{"step": 10, "loss": 0.3}`，Web 画曲线 |
| `$ORBIT_RUN_ID` | 当前 Run ID |

**运行前检查**：`RunService.preflight` 是提交校验的唯一实现：`submit` 遇到第一个失败项即拒绝；`POST runs/check`
（`orbit run|sweep --check`）不建 Run，返回完整清单（`DoctorReport` 形状）：spec、project、镜像是否已在本机、每个
挂载（宿主路径 / 数据集在哪些节点、注册路径是否还在）、输出目录（数据盘剩余空间、可写）、placement（现在能在哪个
节点启动，或排队原因；worker 数据盘偏低时 `warn`）。`orbit run|sweep` 提交前都会调用它并打印 warn/FAIL 项。
`--smoke '<cmd>'` 用相同设置（`sh -c`，sweep 时代入第一组参数，不进 group，标签 `smoke=true`，默认 15 分钟上限）
先跑一个试跑 Run；成功才提交正式 Run，其 `parentId` 指向试跑。等待在 CLI 中进行，daemon 不保存“待提交”状态。

**代码快照**：记录 `HEAD` commit、未提交 diff 与未跟踪文件列表；复制 `git ls-files -co --exclude-standard`
的文件到快照目录。数据和权重不进快照，用命名 dataset 只读挂载。

**容器**：GPU 优先用 CDI（`--device nvidia.com/gpu=<UUID>`，检测到 `/etc/cdi` 或 `/var/run/cdi` 中的
NVIDIA spec 时），否则 `--gpus device=<UUID>`；启动后核对 `nvidia-smi -L` 与租约一致。默认以宿主用户
`uid:gid` 运行（产物归属正确），`--root` 例外。每个 Run 的记录目录挂载为 `/orbit`（rw）。
没有租到 GPU 的容器设置 `NVIDIA_VISIBLE_DEVICES=void`，避免镜像默认值暴露全部 GPU。`image` 本地不存在时先
`docker pull`（输出写入 Run 日志），拉取失败记为环境失败。daemon 重启后重新附着容器时，日志截回启动时记录的
偏移再重新跟随，避免重复。

**会话关联**：CLI 提交时识别调用它的 Agent：`ORBIT_AGENT=<harness>[:<id>]` 优先；否则祖先进程中最近的
`claude` / `codex` 决定 harness（Agent 相互嵌套时子进程会继承父 Agent 的环境变量），会话 ID 取
`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`；Codex 无 ID 时按 cwd 找最近的会话文件。daemon 读取
`~/.claude/projects/**/<id>.jsonl` 或 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`，
归一为 `SessionMessage`（text / thinking / tool_call / tool_result），Web 标出提交该 Run 的那一步。
Run 内运行的 Agent（auth profile、bench solve）的会话随 Agent home 留在 Run 目录（`orbit/agent/{codex,claude}`），
取其中最新的会话文件（跳过 Claude 的 subagents）。`GET runs/:id/session` 返回 `RunSessions { submitter,
submitterError, agent }`；Web Session 页两种都有时左右两栏（左提交者、右 Run 内 Agent），只有一种时单独显示
（带提示列表与侧栏）。远端 Run 的 Agent 会话留在 worker 上，主节点不显示。

**失败也要保留证据**：任何终态都先采集日志与 `$ORBIT_OUTPUT`，再清理容器；日志读到 EOF，截断必须标记。
执行超时计时在确认容器 / 进程退出后立即停止，日志排空、产物采集与用量收尾不计入执行时限；
daemon 重启时仅对仍在运行的任务重新计时。bench 的超时 issue 与用量统计只识别调度器的完整超时原因，
不匹配日志或其他错误文本中的 timeout 字样。

**实测用量**（`Run.usage`，`runs/usage.ts`）：执行节点每 5 s 采样一次运行中的 Run：docker Run 读容器的
cgroup v2（`memory.peak`/`memory.current`、`cpu.stat`、`memory.events` 的 `oom_kill`）；process Run 读其进程组
的 `/proc` RSS 与 CPU 时间，加上带 `orbit.parent` 标签的子容器的 cgroup；租到 GPU 时按这些进程的 host pid 匹配
`nvidia-smi --query-compute-apps` 的显存。记录 `{ samples, peakMemGB, peakCpus, meanCpus, peakGpuMemGB, oomKills,
oomKilled }`，运行中写库（不发变更事件），终态前再采一次并写一条 `usage` 事件；daemon 重启后接着累计（OOM 计数
不重复）。`oomKilled` = 容器被标记 OOMKilled 且非 0 退出（reason 为 `out of memory (limit N GB)`）；`oomKills` 记容器
内被杀的进程（Run 可能照常结束）。从未读到进程的极短 Run 不记 usage。远端 Run 的 usage 随镜像同步。

## 5. HTTP API 与 Web

`/api/v1`：`health`、`resources`、`doctor`、`ledger`（资源 + 活动租约 + 排队原因）、`GET/POST runs`、
`runs/:id`、`runs/:id/{cancel,note,wait,events,logs,log.txt,metrics,artifacts,files/*,diff,session}`、
`POST runs/check`（运行前检查）、`POST runs/delete`、`stream`（SSE：`run` 变化推送，`deleted` 删除推送）、`GET/POST auth`、`DELETE auth/:name`、`POST auth/:name/test`、
`GET/POST notify`、`DELETE notify/:name`、`POST notify/:name/{test,pair}`，bench 路由（§7），
`GET/POST cluster/nodes`、`DELETE cluster/nodes/:name`、`GET/POST cluster/expose`、`GET cluster/token`、
`POST cluster/token/rotate`、`GET/POST datasets`、`DELETE datasets/:name`（§8），`GET folders`、`POST folders/move`、
`POST folders/export`（文件夹，见下）。`POST runs` 与 `POST bench/jobs` 可带 `?folder=`，`GET runs` 可按 `?folder=` 筛选（含子文件夹）。`GET /login?token=&next=` 设置 cookie 后跳转到站内路径（拒绝 `//`、外站）。
`orbit web [id]` 打印带 token 的登录 URL（`--open` 时用浏览器打开）并定位到 Run。
`files/*` 只读输出目录内的普通文件（解析符号链接后仍须在目录内），以 `Content-Security-Policy: sandbox`、
`nosniff` 返回，避免产物中的 HTML 以 Web UI 的身份执行脚本。`wait` 在 Run 终态且清理结束后返回。

Web 页面（参考 W&B / Neptune 的实验对比、Modal / E2B 的沙箱运行详情、GitHub 的 diff 视图）：

- **Runs**：按 group 折叠、状态筛选、全文过滤（名称/参数/标签/分支），多选对比，键盘导航。三类条目：单个 Run、
  `-g` 实验组、bench job（显示为 job 行：benchmark、trial 进度、各方法均分；展开为 trial 行，每行 solve → verify
  状态、分数、有效性，点击进入 trial 页）。顶部按 All / Experiments / Benchmarks 筛选。
- **Trial**（`/bench/<job>/trials/<trial>`）：结果与 issues、solve → verify 时间线与实测用量、重新评分前的历次结果；标签由 adapter 的
  `review` 决定（每个声明的文件一个标签，按 kind 渲染；Grader 来自 `items`；Details 来自 `details` 与未知字段），
  之后固定有 Agent session 与 Outputs（两个 Run 的全部文件）。Markdown 只生成 React 元素，不渲染 HTML、不加载外部图片，
  图片按相对路径取同一 Run 的文件。bench 的 solve / verify Run 页面包屑为 `Bench / job / trial / phase`，带 “← Trial”。
  Runs 页选中整个 job 行可删除该 job。
- **Run 详情**：Overview（生命周期时间线、清理核对、笔记、指标迷你图、日志尾）、Logs（虚拟列表、ANSI、
  搜索、跟随）、Metrics（uPlot，平滑、同步十字线）、Artifacts、Code（相对快照 commit 的 diff）、
  Session（提交者会话标出提交点，与 Run 内 Agent 会话并排）、Events。
- **Compare**：`?ids=` / `?group=`，按 seed 聚合 mean ± std、相对基线的变化、曲线叠加、配置差异。
- **Resources**：GPU 卡片（Orbit 租约 / 外部占用 / 空闲、显存与利用率，以及占用显存的每个进程：用户、
  命令、PID、容器或 Run、已运行多久）、租约与队列、worker 节点表（§8）。
- **Bench**：job 列表、job 详情（分数矩阵，格子进入 trial 页）、方法对比（§7）。
- **删除**（不可恢复）：`POST runs/delete` 只删已终态且清理完成、不属于 bench trial 的 Run（远端 Run 须镜像同步结束）；
  全部校验通过才动手，删除记录、事件、租约与 Run 目录（容器以 root 写下的文件用该镜像的临时容器清掉；仍删不掉的
  目录在结果中列出）。bench job 只能整体删（`DELETE bench/jobs/:id`，非 running）：trial、全部 solve/verify Run 与
  staging。CLI `orbit rm <id>... | -g <group>`、`orbit bench rm-job <job>`，Web 删除按钮都要求输入 Run id / 组名 /
  job id 才能确认（GitHub 式）；无终端时必须显式 `--yes`。
- **文件夹**（逻辑的，不搬文件）：Run 与 bench job 各有可改的 `folder` 字段（`/` 分隔的名字，如 `rcb/noskills`；`""` 为无）。
  提交时 `--folder`，之后 `orbit mv <id...> <folder>` / Web 多选 “Move to folder” 修改；bench job 与它的 Run 总在同一
  文件夹：移动 job 或它的任一 Run 都移动整个 job，job 之后提交的 Run 跟随 job 当前的文件夹。父文件夹不需创建，有记录用到
  就出现；`GET folders` 只给每个文件夹本身的计数与大小，树与子文件夹合计由 CLI / Web 推出。Run 清理完成后记录目录大小
  （`sizeBytes`；旧 Run 在 daemon 启动后于后台补测）。Runs 页左侧是文件夹树（`?folder=`），`orbit folders` 列出同样的树。
  需要实体目录时 `orbit export <folder> <dest>` 复制该文件夹（含子文件夹）的 Run 目录与记录（`runs/<id>/`、`run.json`）、
  job 与 trial（`jobs/<id>.json`）和 `index.json`；`dest` 须为空且不在数据目录内，输出留在其他节点的 Run 列入 `skipped`。
- **Run 显示名**：未给 `-n` 时由 `contracts/naming.ts` 的固定规则从命令得出（去掉 `python`、`torchrun`、`accelerate
  launch`、`uv run`、`sh -c` 等启动器，取脚本或模块名，加 `key=value` / `--flag value` 参数，去掉路径与长文本，最多 60 字符；
  认不出时用截断的命令）。只影响显示，记录中的 name 仍为空、command 完整保留。
- **Settings**：容器内 Agent 版本、auth profile（掩码、测试、删除）、通知目标（发测试、删除）、浏览器通知开关。
  Web 不录入密钥：添加 profile / 目标只走 CLI。

## 6. 认证（auth）、harness 与通知

**Auth profile**（`contracts.AuthProfile`，公开字段不含密钥）：

```
{ name, harness: codex | claude-code, kind: login | api-key | relay, baseUrl?, model?,
  env(非密钥附加变量，如 HTTPS_PROXY), hostNetwork, secretHint, createdAt, updatedAt }
```

- 保存在 `~/.orbit/auth.json`（0600，只有 daemon 写），codex 登录态（Codex 的 `auth.json` 内容）也内联在其中。
  API 与 Web 只返回公开字段和掩码提示；密钥只经本机 HTTP 提交一次，CLI 从 stdin 或环境变量读取，不走 argv。
- 注入方式：

| harness / kind | 容器内 |
| --- | --- |
| codex login | `$CODEX_HOME/auth.json` 为 profile 登录态的副本；run 结束后若 token 已刷新则写回 profile |
| codex api-key | `$CODEX_HOME/auth.json` = `{ OPENAI_API_KEY }` |
| codex relay | `$CODEX_HOME/config.toml` 定义 provider（`base_url`、`env_key = ORBIT_RELAY_API_KEY`），密钥经环境变量 |
| claude-code login | `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成的长期 token） |
| claude-code api-key | `ANTHROPIC_API_KEY` |
| claude-code relay | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |

- 密钥环境变量通过 0600 的 `--env-file` 传给 `docker run`，启动后删除（`docker inspect` 仍可见，仅限本机
  docker 用户）。run 结束后删除容器内写下的凭据文件；日志写入前按当前所有密钥脱敏（`[redacted]`）。
- `orbit auth test <name>` 用该 profile 提交一个真实的小 Run（`auth-test` 组），让 Agent 回复固定口令并检查日志；
  结果作为 Run 保留。

**Harness**：`RunSpec.auth = <profile>` 时，Orbit 把宿主机上已安装的 Agent CLI 只读挂载进容器
（codex 为静态 musl 二进制，挂到 `/opt/orbit/codex`；Claude Code 原生二进制需 glibc，挂到 `/opt/orbit/claude`），
按镜像的 `PATH` 追加这些目录，并在事件中记录版本。版本固定 = 宿主机当前版本；`orbit doctor` 显示两者版本。
Agent 的 home 放在 `/orbit/agent/{codex,claude}`（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`），会话轨迹随 Run 记录保留。
容器本身就是沙箱：容器内 codex 用 `--dangerously-bypass-approvals-and-sandbox`，claude 用
`--dangerously-skip-permissions`。profile 设置 `hostNetwork` 时 Run 使用宿主网络（例如代理只监听 127.0.0.1）。

与 Harbor 内置 Agent 的对照（本地 harbor `09f5b964`）：
- claude-code：方法的 `effort` → `--effort`；设 `IS_SANDBOX=1`（Harbor 任务以 root 运行，否则 Claude Code 拒绝跳过权限）
  与 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`；relay profile 有 `model` 时，`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL`
  与 `CLAUDE_CODE_SUBAGENT_MODEL` 缺省都设为它（与 Harbor 自定义 base URL 时一致）。指令走 argv（Harbor 走 stdin），
  输出为文本（Harbor 为 stream-json），二者不改变 Agent 行为。
- codex：参数同 Harbor（`--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model`，effort 为
  `model_reasoning_effort`）；Harbor 另加 `--enable unified_exec` 与 `--json`。Orbit 不默认开启 `unified_exec`，以免改变
  已有实验的条件；与 Harbor 对齐的跑分要记下这一差异。
- 版本：Agent CLI 用宿主机版本（事件记录版本）；bench job 记录 benchmark checkout 的 `source`（commit、`git describe`、
  是否有改动），`orbit bench show` 显示。

**通知**：`~/.orbit/notify.json`（0600）中的目标：webhook `{ name, kind: feishu | dingtalk | wecom | slack | webhook, url, on[] }`，或飞书自建应用
`{ name, kind: feishu-app, appId, appSecret, users[], on[] }`，
`on` ⊆ `succeeded | failed | group`。单个 Run（无 group）结束时按状态通知；group 中的 Run 不单独通知，
该 group 不再有排队/运行中的 Run 时发一条汇总（成功/失败计数、失败的 Run 与原因）。失败通知附原因与日志最后几行
（已脱敏）。发送失败只记 daemon 日志，不影响 Run。Web 可开启浏览器通知（页面打开时）。

**飞书应用**（`feishu-app`；推送在 `notify/feishu.ts`，用 OpenAPI 的 `fetch`，不用 SDK；接收在 `feishu/`）：
- daemon 为每个应用保持一条**出向**长连接（官方 `@larksuiteoapi/node-sdk` 的 `WSClient`，仅在有该类目标时懒加载；
  `wsConfig.pingTimeout = 3` 收不到 pong 即重连），无需公网地址，daemon 仍只监听 `127.0.0.1`。
- 创建：`orbit feishu init [name]` 在 CLI 中调用 SDK 的 `registerApp`（OAuth 设备码），终端打印二维码（`uqr`）；扫码确认页
  预填机器人、消息权限与 `im.message.receive_v1`（飞书未开放预填时被忽略），返回 appId/secret 与扫码人 open_id，
  CLI 经 `POST notify` 保存（扫码人即配对用户）。订阅方式（长连接）不能经二维码预填；`orbit feishu check` 调
  `POST notify/:name/reconnect` 重连、等待连接并发测试卡片，失败时给出要改的后台页面。一个 daemon 可有多个
  `feishu-app` 目标，同一 appId 只能绑一个（飞书每个事件只投给应用的一条连接）。
- 配对：未配对的用户私聊机器人时收到 6 位码（10 分钟有效），在本机 `orbit notify pair <name> <code>` 后其 open_id
  记入 `users`；重新保存同一 appId 的目标保留 `users`。群聊只处理 @ 机器人的消息。未配对用户得不到任何数据。
- 只读命令：`/gpu`（`ledger`：每张卡的显存、利用率、占用者，CPU/内存/磁盘，队列，worker）、`/runs`（最近 10 个）、
  `/show <id>`（Run 卡片：资源、实测峰值、指标曲线、失败时的日志尾）；其余回复帮助。命令经 `app.request()` 在进程内
  调用 `/api/v1`，与其他客户端走同一套路由；没有取消、提交等写操作。
- 推送：Run / group 结束时给每个配对用户发 Card 2.0 卡片；单个 Run 附最多 2 条指标曲线（含 `loss` 的优先，抽稀到
  200 点，纯折线、不标数值：飞书的 chart 组件不支持 `markPoint`/`markLine`，逐点标签在手机上重叠）。
- 消息 ID 在内存中去重（最近 1000 条）；处理器立即返回，避免飞书因未及时确认而重投。

## 7. 刷榜（bench）

```
AgentProfile = harness + version + model + auth + method bundle (directory)   → contracts.Method
Benchmark    = tasks + per-task environment + instruction + verifier + aggregation
Trial        = task × AgentProfile × seed → solve Run (Agent inside) + verify Run (separate)
Outcome      = { execution, evaluation: valid|invalid|unknown, score?, maxScore, metrics?, issues[], cleanup }
```

- **Method**（`contracts.Method`）：`{ name, agent: codex | claude-code | oracle | empty, auth?, model?, effort?, bundle? }`。
  `oracle` 运行参考解、`empty` 什么都不交，用于检验适配器；Agent 方法必须有 harness 匹配的 auth profile。
  `bundle` 目录（AGENTS.md / CLAUDE.md、skills）复制进 Agent home（`RunSpec.agentBundle`）；harness 版本由 Run 的
  `harness` 事件记录。
- **Benchmark 登记**：`~/.orbit/benchmarks.json`（0600，daemon 写）存 `{ name, adapter, path, config, env, passEnv[] }`。
  `adapter` 为内置名（`harbor`、`asi`）或适配器可执行文件的绝对路径；`config` 是适配器自己的非密钥设置（如 asi 的
  `python`、`instances`）；`env` 进入两个 Run；`passEnv` 只记变量名（如评审模型的 API key），只给 verify Run，启动时
  从 daemon 环境读取，不落盘。登记时先调用一次适配器的 `tasks`，失败则不保存。
- **Job / Trial**：sqlite 表 `bench_jobs`、`bench_trials`。每个 trial 独立推进：`pending → solving → verifying → done`；
  `BenchService` 监听 Run 变化推进，daemon 重启后从库中恢复未完成的 trial。solve 与 verify 都是普通 Run
  （同一租约、队列、记录、Web 详情），`group = bench-<job>`，tags `{bench, job, trial, phase}`；verify Run
  `priority = 1`，排队时先于新的 solve 调度。
- **重新评分**（`POST /bench/jobs/:id/rescore`，`orbit bench rescore <job> [-t task] [-m method] [--trial id]`，
  Web job 页与 trial 页的 Rescore）：不重跑 Agent。只对已结束 job 中已完成、solve 输出仍在本机且需要 verify 的
  trial；当前 `{verifyRunId, outcome, endedAt}` 移入 `Trial.history`，trial 回到 `solving`（solve Run 不变），
  由同一状态机向适配器重新要 verify 描述（staging 由适配器按 solve 输出重建）、提交新的 verify Run 并评分；
  当前结果始终是最新一次，汇总只看当前。job 状态不变，job 的取消不影响重新评分。旧 verify Run 仍属于该 trial
  （`trial_runs` 表记录 trial 的全部 Run），随 job 移动、删除。
- **Outcome 判定**（`bench/classify.ts`），执行、评测、清理分开：

| 情况 | evaluation |
| --- | --- |
| solve 取消 / lost，verify 取消 / lost，job 取消 | unknown |
| solve 未启动（镜像构建、租约、认证失败） | invalid（环境问题，不是方法的结果） |
| solve 失败或超时 | 照常 verify（方法的结果；超时记入 issues） |
| solve 因内存不足被杀（`usage.oomKilled`，资源申请的问题，不是方法的结果；仍照常 verify 并保留分数） | invalid |
| solve 内的 Agent 最后一轮以认证、额度、模型不可用或连不上模型结束（`sessions.runAgentFailure` 读 Run 的 Agent home，规则在 `harness.agentErrorKind`；对所有适配器生效，保留分数） | invalid |
| verify 未启动、超时、内存不足，没有分数，或适配器判为无效（无 reward、scorer 内部错误、judge 不可用、模型不可用且 0 分） | invalid |
| 其余 | valid |

  只有 `valid` 的分数进入均分；无效或未知单独列出，不静默计入。清理状态汇总两个 Run 的 `cleanup`。
- **重试归并**：`POST /bench/jobs/:id/consolidate` / `orbit bench consolidate <job> [sources...]`
  默认只预览；`--apply` 才执行。只接收全部 trial 已完成、Run 已清理且无后台更新的任务；同 benchmark、methods、options、metrics，
  按 task × method × seed 对齐。有效重试只替换无效位置，拒绝覆盖有效成绩（包括 0 分）或从多份有效成绩里挑选。
  保留目标 trial ID、来源 Run ID、原产物与 source_job/source_trial 标签；daemon 在单事务内更新归属并移除来源 job，
  再调用已有 RunService 删除废弃 Run。`--prune-invalid` 清除无效 Run 与无效评分历史，保留任务位置及失败原因。
  `--append-tasks` 追加尚未出现的任务（同 methods × seeds），更新任务列表并保留新增 trial 的有效/无效/未知结果及产物；
  不可和 `--prune-invalid` 同用。拒绝来源之间重复的新任务位置。新增 Run 记录保留 source_benchmark 与原 auth。
  `--allow-transport-differences` 显式允许同 checkout 路径、adapter、config、已记录 git source、指标与方法的代理配置别名：
  只允许 HTTP(S)/ALL/NO_PROXY 和 hostNetwork 差异，auth 别名必须使用相同凭据及模型端点；其他环境变量不放宽。
  旧 job 未记录 git source 时双方都须为空；注册配置不是不可变快照，调用方仍需确认没有改过 benchmark 内容。
  不碰镜像与下载缓存；文件删除失败通过 leftovers 返回。Web job 页的 Merge retries 提供预览和确认。
- **指标**（`contracts.MetricSpec`，规则只在 `contracts/metrics.ts`，daemon、CLI、Web 共用）：适配器在 `tasks` 回复里声明
  `metrics[{ name, label, description?, unit?, range?, higherIsBetter, primary, reference? }]`（至多 20 个，至多一个 primary），
  `score` 回复的 `metrics{ name: number }` 给出每个 trial 的值。内置指标 `score` = `100 · score / maxScore`（%，0–100）始终存在，
  声明同名项只改标签、单位、说明、参考值和是否 primary；没有声明 primary 时 `score` 是主指标，旧适配器不用改。提交时
  解析后的声明存入 `BenchJob.metrics`（旧 job 只有 `score`）。
- **聚合**：所有指标都是均值，每个指标只用 valid trial：先在每个任务内对 seed 取均值，再对任务取均值；标准误按任务聚类
  （同一任务的 seed 不是独立样本），给出正态近似的 95% CI（少于两个任务时没有 CI）。比率型指标（通过率等）让适配器
  每个 trial 报 0 / 100。跨 job 对比时列为 `<job>/<method>`，只比较所有 job 都有的指标；每个指标给出全部任务均值、
  **配对均值**（只取每一列都有值的任务）和相对第一列的**配对差**（逐任务差的均值与 95% CI，CI 不含 0 才判为更好 / 更差），
  避免方法在不同任务子集上比较。参照 Anthropic《A statistical approach to model evaluations》、Inspect 的 `stderr(cluster=)`、
  Terminal-Bench 排行榜（resolution rate ± 95% CI）。
- **Run 指标**：trial 结束时把各指标值写成 verify Run `metrics.jsonl` 的一行（`bench/<name>`），Run 详情与 Run 对比照常显示。

**适配器协议**（`bench/protocol.ts` 调用方，`bench/adapter.ts` 内置适配器一侧；契约 `contracts.Adapter*`）。
内置与外部适配器只有这一种机制，用户的 Agent 写一个可执行文件即可接入新 benchmark，不需要重新构建 Orbit：

- 调用：daemon 执行 `<adapter> <op>`（内置为 `orbit __adapter <name> <op>`），cwd 为 benchmark 目录，stdin 为一个 JSON
  请求，stdout 为一个 JSON 回复；退出码非 0 即失败（stderr 末尾几行作为原因）。环境只含 `PATH`、`HOME`、`USER`、
  `LANG`、`LC_ALL`、`TZ`、`TMPDIR` 与 `ORBIT_ADAPTER_PROTOCOL=1`，daemon 环境里的密钥不传给适配器。每次调用 120 s 超时。
- 请求：`{ protocol: 1, op, benchmark: { name, path, config }, trial?, solve?, verify? }`；`trial` =
  `{ id, task, method, seed, options, timeoutMin?, staging, hostNetwork }`（`staging` 是 trial 私有的宿主目录，用于要挂进
  Run 的副本，trial 结束时删除）；`solve` / `verify` = `{ run, output }`（Run 记录与其 `$ORBIT_OUTPUT` 的宿主路径）。
- 回复：`tasks` → `{ tasks: BenchTask[], metrics?: MetricSpec[] }`；`solve` / `verify` → `{ spec, issues? }`；`score` →
  `{ score, maxScore?, invalid?, issues?, review?, metrics? }`。`review`（可选）告诉 trial 页展示什么：
  `files[{ label, phase: solve|verify, path(相对该 Run 输出目录), kind?, fallback? }]`、`items[{ criterion, score?,
  maxScore?, weight?, type?, reasoning? }]`、`details{ key: 短值 }`。`kind` 是封闭集合 `markdown | image | text | json |
  table`，样式全由 Web 决定，adapter 不能传 HTML / CSS；不认识的 `kind` 依次退回 `fallback`、文件扩展名、纯文本，并在页面
  标注。未知字段保留（`looseObject`），在 Details 中按键值显示；长文本截断，条目数有上限。`review` 随 Outcome 保存，
  分数无效时也保留。没有 `review`（旧 trial、旧 adapter）时 trial 页退回猜测：solve 的 Markdown 报告与 verify 的 JSON。适配器只生成 Run 描述、读文件，不提交 Run，不判定取消、超时、未启动。
- Run 描述是 RunSpec 字段，但不能含 Orbit 自己管的字段（`name group params project snapshot auth agentBundle agent
  parentId priority passEnv`），且 `command` 与 `agentTask: { instruction }` 二选一。Agent 方法（codex / claude-code）的
  solve 用 `agentTask`：Orbit 按方法生成 Agent CLI 命令（`harness.agentCommand`，参数只在这里维护），并设置 auth、bundle 与
  网络；也可以给 `command`（原生 runner 自己启动 Agent，如 ASI），Orbit 同样设置 auth 与 bundle。oracle / empty 只能给
  `command`，verify 不能请求 Agent。Orbit 再加上 benchmark `env`（两个 Run）、`passEnv` 与 `priority = 1`（verify），
  `snapshot = false`，最后按 RunSpec 校验。
- **任务资源文件**（`contracts.BenchResources`，`bench/resources.ts`）：`orbit bench add --resources <file>` 登记一个
  JSON：`{ version: 1, default, tasks: { <task>: { cpus?, memGB?, gpus?, gpuMemGB?, timeoutMin?, evidence?, confidence?,
  note? } } }`，未知字段报错，`evidence` 等只给人看。只覆盖 solve Run：任务条目 > `default` > 适配器给的值，
  `orbit bench run --timeout` 仍优先于 `timeoutMin`。登记时与提交 job 时校验（文件中不存在的任务 id 报错）；提交时
  把每个任务解析后的值存入 `BenchJob.resources`，之后改文件不影响已提交的 job。文件由人（或其 Agent）维护，
  Orbit 从不写它。
- **用量建议**：`orbit bench usage <job>...`（`GET /bench/usage?jobs=`）汇总 Agent 方法 solve Run 的实测峰值（oracle /
  empty 不计），与当时的申请对比并给出建议：内存与显存 = 峰值 × 1.2 向上取到档位（2…256 GB），OOM 后至少升一档，
  至少两次运行且有一半余量才建议调低；CPU 取峰值档位；超时 = 最长耗时 × 1.5 取整小时，超时过则至少 ×1.5；
  GPU 数量从不建议（是否需要 GPU 是对任务的判断）。`--suggest` 输出资源文件片段（带 evidence），只打印不写回。
- 提交 job 与 daemon 重启后恢复 trial 都在后台依次推进（每次调用是一个进程），不阻塞 API 与 daemon 启动。

内置适配器：

1. **Harbor 格式**（`bench/harbor.ts`，TB-Science）：任务目录含 `task.toml`、`instruction.md`、`environment/`、
   `tests/`、`solution/`。solve Run 用 `[environment] docker_image`（Harbor 优先用它），否则从 `environment/Dockerfile`
   构建，以 root 与 `workdir`（缺省为镜像 WORKDIR）运行；资源、超时来自 `task.toml`；Agent 方法给出 `agentTask`
   （`instruction.md`），oracle 把 `solution/` 挂到 `/solution` 执行 `solve.sh`。顶层 `artifacts` 声明的路径在 solve
   结束时采集（`RunSpec.collect`，写入 `output/collected/<abs path>`）。verifier 模式按 Harbor 规则解析：显式
   `environment_mode`，否则有 `[verifier.environment]` 即 separate，否则 shared。shared：solve Run 带 after 阶段——
   方法结束后把 `tests/` 复制到 /tests，以 Harbor 的命令（`chmod +x` 后执行 `/tests/test.sh`，输出写
   `/logs/verifier/test-stdout.txt`）、`[verifier.env]`、`[verifier] timeout_sec` 与 verifier 阶段网络运行，采集
   `/logs/verifier`；不再起 verify Run，从 solve Run 的 `output/after/` 评分，after 阶段未运行 / 超时记为 invalid；
   环境已不在，不能 `bench rescore`。separate 的镜像顺序同 Harbor：
   `[verifier.environment] docker_image` → `tests/Dockerfile`（二者自带 /tests）→ `tests/docker-compose.yaml`（不支持）
   → 任务环境的新副本（继承其资源、网络、变量，`tests/` 挂到 /tests）。verify Run 把采集到的产物复制挂载到目标路径，
   运行 `bash /tests/test.sh`，采集 `/logs/verifier`，读取 `reward.json`（`reward` 键或唯一键）或 `reward.txt`。
   网络按阶段解析：`[agent]` / `[verifier]` 的 `network_mode`，否则所在环境的（缺省 public）。
   `environment/docker-compose.yaml`（`bench/compose.ts`）翻译成服务容器：`main` 取 `environment`、`working_dir`、
   `depends_on`、`networks`（其 `command` 是 Harbor 的保活命令，忽略；task 的 `[environment.env]` 覆盖 compose 的值），
   其他服务取 build/image、command、environment、working_dir、cpus、mem_limit、healthcheck、depends_on（started /
   healthy）、networks、init、read_only、tmpfs、cap_add/drop、security_opt、pids_limit、shm_size；`main` 的 `image`
   只接受与 `[environment] docker_image` 相同的值；`[[verifier.collect]]` 变成 hooks；顶层 networks 只认 `internal`。
   插值同 Compose（`${VAR}`、`${VAR:-d}`、`${VAR-d}`、`$$`），变量为 CONTEXT_DIR、CPUS、MEMORY、PREBUILT_IMAGE_NAME 与
   任务变量；未知变量、其他键（volumes、ports 等）都列为不支持。`service = "<名>"` 的 artifacts 从该服务采集。
   未实现的设置一律标为不支持而不是忽略（否则分数不再对应任务条件）：compose 中未实现的键、
   复用 compose 环境的 separate verifier、`allowlist` 网络、非 linux、`gpu_types`/`tpu`、`mcp_servers`、`skills_dir`、`healthcheck`、`[agent]`/`[verifier]`
   `user`、`[[verifier.collect]]` 的 `user`、`[[steps]]`、`${VAR}` 变量模板；Harbor 也忽略的未知字段照样忽略。
   指标：主指标 `resolved`（reward ≥ 1 的 trial，%，即 Terminal-Bench 的 resolution rate），`score` 标为 Reward（平均 reward）。
2. **原生包装**（`bench/asi.ts`，ASI-Bench seed31415）：solve Run 以 **process 后端**运行
   `config.python -m ai4sci_bench.cli run`（单实例、单 prompt level，`--output-dir $ORBIT_OUTPUT/native`）；Agent 方法走
   ASI 自己的 `codex_cli` / `claude_code_cli` 适配器，oracle 用 `--agent-cmd` 复制 `reference/` 中的声明输出，empty 为
   `true`。verify Run 把 solve 结果复制到自己的输出目录，给没有产出任何声明文件的结果补一个空 `.outputs/`
   （原生 scorer 否则直接报错），再运行 `ai4sci_bench.cli score`；分数取该实例最新 attempt 的 `final_score / max_score`。
   指标：主指标 `score`（`final_score / max_score` 的 %），另有 `fullMarks`（满分 trial 的 %）。
   ASI checkout 只读：进程 cwd 是 Run 目录，`PYTHONPATH` 指向 checkout，`PYTHONDONTWRITEBYTECODE=1`。
   solve 显式启用 `--fail-on-agent-error`。Agent 方法在规划时通过 `config.python` 的 AST 解析，
   检查所选 Codex/Claude 源码是否仍把任意日志中的 `timed out` 放在成功退出判断之前，以及 CLI
   是否声明失败退出码选项；已知不兼容版本拒绝启动并提示更新注册 checkout，不 monkey-patch 第三方代码。
   native result 和 score report 分别按 attempt 数值选择最新项；review 的 `attempt_status` 只依赖
   native 执行状态，评分有效性独立保留。该检查不修改历史 Run 或退出码。
   verify 默认 30 分钟，TSP 为 90、Max3SAT 为 60 分钟，以覆盖其 native solver 的
   3600/1800 秒固定预算及启动收尾；仍请求 1 CPU、4 GiB、0 GPU，内部 task 预算不变。

**process 后端**（`RunSpec.backend = "process"`，`runs/process.ts`）：命令直接在宿主以独立进程组运行，
cwd 默认为代码快照（有快照时），否则 `project`，再否则 Run 目录；HOME 为 Run 私有目录；环境包含 `spec.env`、`passEnv`、`ORBIT_OUTPUT`、
`CUDA_VISIBLE_DEVICES`（租约中的 GPU）。PATH 最前面是 Run 私有的 `docker` shim（`orbit __docker-shim`，
`runs/shim.ts`）：给 runner 启动的容器加 `orbit.parent=<run>` 标签，把 `--gpus` 换成租约中的 GPU（没有租到 GPU 则拒绝），
有 auth 时注入 Agent CLI 与凭据挂载，`hostNetwork` 时 build 用宿主网络，其余参数原样传给真实 docker。
取消 / 超时向进程组发 SIGTERM（宽限后 SIGKILL）并停止子容器；只有进程组与带标签的子容器都消失才释放租约。
daemon 重启后按 pid + 启动时间重新接管进程。运行中的 process Run 日志在 API 中不返回（写完后统一脱敏）。

**接口**：API `GET/POST /benchmarks`、`DELETE /benchmarks/:name`、`GET /benchmarks/:name/tasks`、
`GET/POST /bench/jobs`、`GET /bench/jobs/:id`、`POST /bench/jobs/:id/{cancel,rescore}`、`GET /bench/compare?jobs=a,b`；
CLI `orbit bench add|ls|rm|tasks|run|jobs|show|cancel|rescore|compare [--metric]|usage`（`add --adapter <name|path> -c KEY=VALUE
--resources <file>`）；Web `/bench`（job 列表与登记的 benchmark）、
`/bench/<job>`（方法均分、有效性分布、任务 × 方法分数矩阵、问题列表与 solve/verify Run 链接）、
`/bench/compare?jobs=`（逐任务对比、全部与配对均值 ± 95% CI、相对第一列的配对差、带参考线的排名条；`?metric=` 切换指标）。接入新 benchmark 见
[guides/bench-adapter.md](guides/bench-adapter.md)。

- **外部适配器示例**：ResearchClawBench（`examples/bench-adapters/researchclawbench/`）。solve 为 Ubuntu 22.04 容器，
  任务 workspace 在 `/task`（`data/`、`related_work/` 只读，其余可写，结束时采集），原版指令模板，RCB 的 venv 按宿主路径
  只读挂载；verify 为 process Run，在 RCB `.venv` 中调用原版 `evaluation.score.score_run`。没有 report 为有效 0 分，
  judge 调用失败为 invalid；分数 0–100（50 ≈ 原论文水平），多次 judge 取均值。RCB 没有参考解，oracle 不可用。
- **接入验收（任意新 benchmark）**：oracle 满分（没有参考解时省略）、空答案零分、抽样与原版结果一致。
- **已知限制**：verify Run 在 solve 结束后才提交，group 通知可能在 job 中途（某一时刻组内无排队/运行 Run）提前发出；
  ASI 包装每个 trial 调一次原生 runner，不复用其并行调度。

## 8. 多节点（R4）

每台机器运行一个 daemon。Agent 所在节点为**主节点**，其他机器为 **worker**；不引入 Ray。
操作步骤见 [guides/multi-node.md](guides/multi-node.md)。

**加入**：worker 上 `orbit node expose --listen <addr>:<port>` 开启集群监听（`/cluster/v1`，
`Authorization: Bearer <cluster token>`；token 在 `cluster.json`（0600），与本机 daemon token 无关），
主节点 `orbit node add <url>` 登记（终端里提示输入 token，不回显；也可 `--token-stdin` 管道或 `--token-env`）（`nodes.json`，0600）。协议为明文 HTTP，只用于
Tailscale / 内网 / SSH 隧道；cluster token 等同于在该节点运行容器的权限。节点名取 `ORBIT_NODE` 或主机名，
`ORBIT_GPUS` 限定本 daemon 管理的 GPU（同机仿真多节点时使用）。

**放置**（`runs/service.ts` 决定，`cluster/` 实现 `RemotePlacement`）：先本机，再按名字顺序的在线 worker；
都不能运行时排队，原因按节点列出。以下 Run 只在提交节点运行：process 后端（含 bench 与 `auth test`）、
宿主路径 mount、`snapshot: false` 的项目。`resources.node` 可钉住节点。worker 的资格按其心跳上报
（资源、活动租约、数据集名、auth profile 名及 CLI 是否可用）判断；主节点为已派出但尚未上报的 Run
保留预测租约，避免重复放置。

**派发**：主节点把 Run 置为 `starting`、`remote: true`、`node: <worker>`，同事务写 `remote_sync` 行；
随后上传 bundle 并 `POST /cluster/v1/runs`（按 Run ID 幂等）。worker 拒绝则记住该节点并重新排队，
不可达则重新排队，结果未知由同步循环判定。worker 以同一 ID 保存 Run（`origin` = 主节点名，钉在本节点），
按本机规则排队和执行；密钥、passEnv 与 auth 取 worker 上的同名配置。

**代码**：工作区快照、仓库外的 Dockerfile 目录、agent bundle 按目录树内容哈希（路径、类型、可执行位、
链接目标、文件 sha256）打包传输，worker 校验哈希后缓存在 `cache/bundles/<hash>`，已有则跳过上传。
Dockerfile 在仓库内时用快照中的文件（gitignored 文件不在快照中）；本机运行同样如此（以快照为构建上下文，镜像与提交时的代码一致；快照中没有该 Dockerfile 时才用原文件）。Run 记录镜像名（`image`）与启动时的镜像内容 ID（`imageId`，`sha256:…`）。

**数据**：`orbit data add <name> <path>` 在每个节点各自登记同名数据集；mount `{dataset, target}` 在执行
节点解析为本地路径。调度只选登记了全部数据集的节点，从不复制数据。

**镜像同步**：主节点每个周期对未完成的远端 Run 拉取状态、事件（保留原时间）、日志与指标增量
（按本地文件长度续传），并转发待发的取消。worker 上 `queued` 映射为主节点的 `starting`（原因注明）。
worker 返回 404：已确认的 Run 记为 `lost`，未确认的重新排队。产物与文件不复制，通过主节点 API 代理读取，
worker 不可达时返回 502。终态且 worker 已完成清理后同步结束。

**已知限制**：bundle 缓存不自动回收；worker 离线期间其上的镜像 Run 保持原状态，直到它恢复或被
`orbit node rm`（此时记为 `lost`）；worker 重启并重新附着 Run 时镜像日志可能被截断重拉，以 worker 上的
日志为准；Agent 会话与 diff 只在主节点。

## 9. 预留

- 具身：资源类型可扩展为独占设备（如机械臂），executor 可增加设备后端。现在不写代码。
- 手机监控/对话、Slurm：出现具体需求再设计。

## 10. 路线

| 阶段 | 目标 | 验收 |
| --- | --- | --- |
| R0 | 清理旧实现、TS 骨架、规则与设计 | `pnpm verify` 通过；`orbit resources` 在本机读出真实 GPU/CPU/内存 |
| R1 | 单机日常科研闭环 | Codex 估算资源并提交 3-seed GPU sweep，排队、`orbit wait`、失败留证据；Web 看到 diff、曲线、日志、会话；Codex 与 Claude Code 都走通 |
| R2 | 认证模块与通知 | login / API key / relay 三类 profile 可用于容器内 Codex、Claude Code；完成/失败通知 |
| R3 | 刷榜 | ASI 原生包装、TB-Science Harbor 格式在同一 Run/租约上运行；方法对比页面；新 bench 接入指南 |
| R4 | 多节点 | 一个 Agent 调度两台机器 8 张 GPU；已实现，仅同机双 daemon 仿真验证（§8） |

## 11. 来自 v0（Python 版）的教训

v0 的代码、文档与任务记录保留在标签 `v0-python-final`。

- 控制权放在 infra（冻结 Task、容器 Planner、研究方案审批）导致流程重、不被使用。Agent 主导，Orbit 只执行和记录。
- 科研与 benchmark 各有一套控制器、租约、存储和结果格式，互相看不见资源。只保留一套。
- 失败路径先抛异常后收集产物，丢失证据；日志按固定块读取可能截断。终态先采集、读到 EOF。
- 评测链异常仍可能被显示为已评分；原生 timeout 标签与真实终止事件不一致。评测有效性必须独立判定并参与汇总。
- ASI 容器内旧版 Codex CLI 导致模型拒绝；harness 版本必须固定并在 doctor 中检查。
- GPU 映射：Docker `--gpus device=<UUID>` 或 CDI `--device nvidia.com/gpu=<UUID>`，启动后核对实际映射与租约一致。
- 文档与流程记录量接近代码量，拖慢迭代。只保留本文、status 与必要的任务记录。
