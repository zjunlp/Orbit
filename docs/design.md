# Orbit 设计

状态：R0 已确定的目标设计；R1–R3 已实现；R4（多节点，§8）已实现，仅在同机双 daemon 仿真上验证；
R5（任意 Agent + 跨场景评测规范，§6、§9）部分实现，包含 Agent 注册、benchmark 目录与独立 Policy 原生具身评测。实现进度见 [status.md](status.md)，文档分工见 [docs/README](README.md)。
本文是架构与接口的唯一权威来源。改变模块边界、公共契约或关键决策时，在同一分支更新本文。

## 1. 定位

定位（2026-11-12）：**Orbit: Learn and Evolve in Any Environment.** Agent 开始自己干活、自己改进自己，人退到验收的位置；
Orbit 是让验收有据可依的实验室，位于做决策的 Agent 与负责隔离的沙箱之间，提供四件事：
手（隔离容器与资源租约）、证据（代码快照、完整记录、统一轨迹）、验收（独立评测，执行结果与评分有效性分开）、
进化门（Agent 的每次改动是带血缘的版本，由配对统计决定是否接受）。
标题中的 Evolve 需要证据证明进化是真的，Any Environment 是证明的方式：
跨多类 benchmark 与多种 Agent 是进化门的前提，只在诞生地测过的改进不算验证。

前三项已实现（范围见 [status.md](status.md)）；统一轨迹（§9.8）已有 ATIF 契约、Codex / Claude Code 转换、Run 生命周期及 API/CLI 接入，环境对齐仍待完成；进化门仍在设计中、尚未写入本文，
目前只有配置版本、血缘与配对统计（§9.16）。在进化门的设计写入本文之前，§9.16 的"不做方法进化声明"继续有效。
统一轨迹、导出、分叉、进化门与进化实验的分步计划见 [evolution-plan.md](evolution-plan.md)；它是计划而不是设计，
各工作包落地时把定稿写回本文；§9.8 已采用 ATIF，Run 生成、存储、重建与读取已实现。
具身设备后端是未来方向。规划、分析与迭代仍由 Agent 主导，Orbit 不提出改动，只提供执行、证据与判定依据。

> Orbit 让 Codex / Claude Code 等 Agent 在隔离的 Docker 中按资源规则运行实验，
> 并完整记录过程与结果；Web 用于本地复盘。

- **Agent 是本体**：规划、写代码、分析由 Agent 和人完成。Orbit 不启动"规划 Agent"、不审批研究方案、不编排科研流程。
- **Orbit 是插件和规范**：提供 CLI（Agent 通过 bash 调用，`--json` 输出）、薄 MCP、skill 与约定（指标、产物、实验笔记的写法）。
- **两种用法，同一个执行原语 Run**：
  1. 日常科研：宿主机上的 Agent 改代码 → `orbit run` 把代码快照放进容器跑 → 监控、比较、复盘。
  2. 刷榜：`Agent + 模型与评测配置 × Benchmark`，每个 trial 在容器中运行 Agent，再独立评测，保留轨迹和分数。
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
  ├─ auth        credential profiles per Agent (login / API key / relay base URL)
  ├─ harness     Agent registry: definitions, install, credentials, argv, transcripts
  ├─ records     logs, metrics, artifacts, events, notes
  ├─ sessions    native Agent evidence, ATIF conversion, storage and transcript projection
  ├─ bench       adapters, agent profiles + method bundles, trials, outcomes
  └─ cluster     node join, heartbeat, code bundles, remote placement and mirroring (R4)
  ▼
Web (local SPA served by the daemon): runs, compare, logs, sessions, bench review
```

技术栈：TypeScript（Node 24，开发时直接运行 `.ts`），`node:sqlite`（无原生依赖，便于 npm 安装），
直接调用 `docker` / `nvidia-smi` / `git` 命令行，Hono HTTP，zod 契约，commander CLI，
vitest 测试，Biome 格式/lint，tsdown 打包。发布为单个 npm 包 `@zjunlp/orbit`，命令 `orbit`。

分发：`pnpm pack:release` 先构建 Web、CLI 与契约 JS / 声明文件，生成包含 Web、README、MIT 许可与第三方依赖完整许可的
tarball（含共享 skills 与 dsh 薄入口）；pnpm 的 `publishConfig.exports` 将仓库内源码入口替换为发布包的 `dist` 入口。
Vite 按实际打包依赖生成 `dist/web/THIRD_PARTY_LICENSES.md`，保留字体及前端库的版权和许可文本。
Web 引用根目录 `assets/` 中的品牌图标，由 Vite 打包到 Web 静态资源中并随 npm 包分发。
`pnpm smoke:package [tarball]` 在仓库外安装，验证 CLI、导出、自动 daemon、Web 资源与第三方许可。
用户通过 `npx -y @zjunlp/orbit doctor` 试用或 `npm install -g @zjunlp/orbit` 安装。
`orbit plugin install [claude|codex|dsh|pi]` 调用各平台原生安装器，省略平台仍默认 Claude。
Claude / Codex 注册 `zjunlp/Orbit` marketplace 后安装 `orbit@orbit`；Codex 使用根 `plugin.json` 和
`.agents/plugins/marketplace.json`。dsh 必须指定带 skills 服务的 `--profile`，通过 npm bundle 的
Cordis patch 挂载薄入口，委托宿主的 filesystem provider；本地包通过 `file:` 安装，避免目录链接在
profile 外解析不到宿主依赖。pi 通过 npm 包的 `pi.skills` 发现 skills；本地目录注册需保留该目录。
dsh / pi 默认安装与当前 CLI 相同版本的 npm 包，不引用 npx 临时缓存。各平台只有
`plugin/skills/` 一份源文件，构建时复制入包；无全局 CLI 时使用 npx。安装器不改 daemon 状态或凭据。
插件支持不扩展容器内 Agent 定义、auth 或会话解析（内置 12 个 Agent，其中只有 Codex / Claude Code 有会话解析器）；MCP 独立待实现。
维护者可登录 npm 发布已验证的 tarball；配置 npm trusted publisher 后，也可通过 GitHub Release 的
`v<version>` 标签触发发布工作流。两条路径都要求使用未发布过的新版本号，见[发布指南](guides/releasing.md)。

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
assets/        canonical project logo and icon; referenced by README and the Web build
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
| web (`packages/web/src`) | 自身文件；`@zjunlp/orbit` 只能 `import type` 自 `@zjunlp/orbit/contracts`，另可在运行时使用无依赖的 `@zjunlp/orbit/naming`（Run 显示名规则）、`@zjunlp/orbit/metrics`（bench 指标的取值、聚合与格式化）与 `@zjunlp/orbit/taxonomy`（六维词表与匹配） |

模块内按职责拆分，以上依赖方向不变：`contracts/index.ts` 保留统一导出，schema 分入 runs、resources、auth/notify、
bench、adapter、cluster、records 和 folders；`RunService` 保留公共 API、调度与共享状态，远端放置/镜像、启动、服务、
阶段/hooks、process 后端、清理、采样与日志收集由 `runs/` 内函数接收所需依赖。`bench/consolidate.ts` 计算纯归并计划，
service 负责读取、await 后重新校验、单次 store 事务和清理；汇总/对比在 `bench/summary.ts`，用量行在 `bench/resources.ts`，
校准 job 提交后的生命周期（一次重查、policy 检查的预算计时与执行结束判定）在 `bench/calibration.ts` 的 `CalibrationLifecycle`；
trial 状态机（推进、提交 solve/verify、评分、取消与重启认领）在 `bench/trials.ts` 的 `TrialMachine`，`BenchService` 只做 job 级操作，
经 `isBusy`、`advanceAll`、`stopRuns` 等公开方法触及 trial。
某个 benchmark 专有的行为放在它的 adapter 内（如 Harbor 的 EFE 轨迹导入），service 只依据 adapter 声明的 `capabilities` 判定，不按 adapter 名分支。
`daemon/routes/` 按 runs、bench、settings、cluster/datasets、folders 注册，鉴权仍在 `createApp`，错误映射共用 `daemon/http.ts`。
CLI 的运行/试跑/等待共用 `cli/run.ts`，表格与选项解析共用 format/options；私有 JSON 的临时文件、0600 权限和 rename
统一由 `lib/private-json.ts` 的 `writePrivateJson` 处理。Web 的 Runs / Bench / Trial 子组件分别放在 `pages/runs/`、`pages/bench/` 和 `pages/trial/`；
全部页面的地址、侧栏、`g x` 快捷键与命令面板条目只在 `packages/web/src/routes.ts` 定义一次。

- **源码文档与个人使用记录分开**：`docs/` 只记录通用架构、功能、问题和开发验证。个人实验成绩、批次进度、
  重跑/归并过程、私有资源配置及账号或机器清单放在源码仓库外的用户侧笔记中，不进入任务文档、提交说明或 PR。
  Orbit 的运行记录仍由 daemon 管理；需要给 Run 添加笔记时使用现有 `orbit note` API 路线。
- **daemon 是本机状态的唯一写者**。CLI/MCP/Web 只通过 HTTP API 访问；CLI 需要时自动拉起 daemon。
  daemon 只监听 `127.0.0.1`（默认端口 7717，被占用时——同一台机器上另一个用户的 daemon——自动换空闲端口；`ORBIT_PORT` /
  `--port` 指定的端口被占用则报错），启动时生成随机 token，与地址一起写入
  `~/.orbit/daemon.json`（0600）；所有 `/api/v1` 请求需 `Authorization: Bearer <token>` 或 Web 登录后的
  HttpOnly cookie（token 比较为常数时间；凭 cookie 的写请求须同源，否则 403）。`ORBIT_HOME` 可覆盖 `~/.orbit`。
  打开数据库前独占 `<home>/daemon.lock`，记录 PID、启动时刻与 boot ID；活跃持有者阻止第二个 daemon，退出时释放，
  失效或 PID 被复用的锁可接管。锁记录原子发布，失效锁回收也串行化；CLI 用 `daemon.spawn.lock` 串行自动启动，
  取得锁后重新检查连接。不同 home 仍可使用端口回退。
- **事务与通知**：Store 的嵌套事务用 SAVEPOINT；Run change 事件只在最外层提交后发出，回滚丢弃相应事件。
  监听器可开始自己的事务，SSE 和 bench 不会读到未提交状态；数据库版本高于当前程序支持的 migration 时拒绝打开并提示更新。
- **小状态与大数据分开**：`ORBIT_HOME`（默认 `~/.orbit`）只放数据库、profile、配置与 daemon 端点；Run 目录、bench
  staging、代码 bundle 放在**数据目录**（`ORBIT_DATA`，否则 `<home>/config.json` 的 `dataDir`，否则 `ORBIT_HOME`）。
  `orbit config data <dir>` 写配置（比环境变量可靠：自动拉起的 daemon 总能读到），重启 daemon 生效，已有 Run 不自动搬。
  `doctor` 报告数据目录与 Docker `DockerRootDir` 的剩余空间，在系统盘上或空间不足（少于磁盘的 10%，下限 50 GB、上限 500 GB）时给 `warn`。
  资源探测的磁盘也是数据目录所在的盘。
- **私有状态权限**：新建 `ORBIT_HOME`、数据目录、`runs/`、`cache/`、`cache/bundles/`、bench staging 与
  `<home>/tmp/` 为 0700，SQLite 数据库及 `-wal` / `-shm` 为 0600。daemon 启动时也收紧已有的 home、
  上述 Orbit 子目录和数据库文件，以及 auth/notify/nodes/cluster/datasets/benchmarks/daemon JSON、daemon.log、daemon.lock。
  若 home 本身是当前用户拥有的符号链接，检查并收紧其同属当前用户的目标目录；不跟随根目录下的链接，不递归进入 Run，
  不改独立的已有数据根目录或其他用户拥有的路径。修改记入 daemon 日志；EPERM / EACCES 不阻止启动，`doctor` 对仍不私有或无法检查
  的路径给 `warn`。这会撤销这些路径原有的组/ACL 访问，适用于 Orbit 的单用户状态。
- `src/` 根目录下的文件（如 `bin.ts`）是组合根，可引用任意模块，但不能被模块引用。
- 同类能力只有一份实现：一个 Run 状态机、一个资源账本、一个记录库。
- Docker、sqlite 句柄不出现在 contracts 中。

## 4. 核心契约（R1 目标，字段以 `contracts/` 为准）

**ResourceRequest**：`{ gpus, gpuMemGB?, gpuIds?, cpus, memGB, node? }`。Agent 按任务估算后提交；
没有可满足要求的节点时预检拒绝，符合条件的设备暂时被占用时排队。
`gpuMemGB` 按每张卡总显存筛选。共享服务的显存预算由 `roleRequests` 加到 `gpusOf` 指定的拥有者，
不增加 GPU 数量；拥有者和各独立角色分别检查容量、型号与指定卡，避免把主角色的门槛套到其他角色。
预检与实际分配共用 GPU 筛选及联合匹配，确认独立角色能同时获得不同的卡；预检使用全部探测到的卡，
实际分配排除忙碌与已租用的卡，区分硬件无法满足和暂时等待。

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
createdAt/startedAt/endedAt, cleanup: pending|done|failed, usage?, trajectory, tokens }`

- `state`: `queued → starting → running → succeeded | failed | cancelled | lost`。
- `trajectory`：`{ schema, steps, completeness, importer: { name, version } } | null`，仅存摘要；完整 ATIF 和媒体留在 Run 文件中（§9.8）。旧记录默认 null。
- `tokens`：`{ input, cachedInput, cacheWrite, output, reasoning, calls, costUsd?, source: "session" } | null`；由 ATIF 记账，未知字段为 null，费用只保留 CLI 自报值（§9.8）。旧记录默认 null。
- 执行结果（state/exitCode）、清理状态（cleanup）、评测有效性（bench 中）是三个独立字段。
- `remote`：主节点上的镜像记录，Run 实际在 `node` 上执行；`origin`：worker 上替主节点执行的 Run 的主节点名（§8）。
- mount 二选一：`source`（本机绝对路径）或 `dataset`（命名数据集，在执行节点解析为本地路径）；
  `target` 为绝对路径、互不重复、不含 `..`，且不能落在 `/orbit` 下（有 project 时也不能落在 `/workspace` 下）。
  mount target 与各阶段 `collect` 路径先拒绝原始 `..`，再按 POSIX 规范化；保留路径与 mount 重复检查使用规范化后的值。
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
的文件到快照目录。生成 diff 的临时 index 与新 blob 都放在临时目录，以原仓库的绝对 objects 路径作为
alternate（兼容 linked worktree），结束或失败后删除，不向用户仓库的对象库写入。
临时 index 保留复制前原 index 的修改时间，维持 Git 对同时间戳、同大小文件改写的内容复核，避免变更清单和 diff 漏项；复制或设置时间失败时直接报错。
子模块 gitlink 和 `ls-files` 返回的目录不递归复制，路径记入 `CodeSnapshot.skippedSubmodules`（旧记录默认 `[]`）；
提交时发出 warning 事件，CLI show 与 Web Code 页提示子模块内容未被快照。数据和权重不进快照，用命名 dataset 只读挂载。

**容器**：GPU 优先用 CDI（`--device nvidia.com/gpu=<UUID>`，Docker `info.CDISpecDirs` 声明的目录中存在
NVIDIA spec 时）；未启用或能力查询失败则用 `--gpus device=<UUID>`，不能只凭本机文件判定。首次使用时探测，
Docker 应答后固定结果；查询失败（如 daemon 先于 Docker 启动）至多每分钟重试一次。启动后核对 `nvidia-smi -L` 与租约一致。默认以宿主用户
`uid:gid` 运行（产物归属正确），`--root` 例外。每个 Run 的记录目录挂载为 `/orbit`（rw）。
`commandUser` / `--command-user` 可在 root 初始化之后，只把主命令切到镜像内已有的命名账户；
后续验证阶段保留镜像用户。仅支持无 project、无 checkpoint 的 Docker Run，镜像需包含
`runuser`、`getent`、`find` 与 coreutils；非 root 镜像会明确失败。只授权本 Run 的 Agent home、
输出、metrics 和声明的 mkdirs，私有宿主祖先目录保持私有；托管可写目录保留 daemon 组访问，
不改变任务镜像内私有评分器的权限。CLI/API 共用 RunSpec，Web 显示命令账户并保留在复现命令中。
没有租到 GPU 的容器设置 `NVIDIA_VISIBLE_DEVICES=void`，避免镜像默认值暴露全部 GPU。`image` 本地不存在时先
`docker pull`（输出写入 Run 日志），拉取失败记为环境失败。daemon 重启后重新附着容器时，日志截回启动时记录的
偏移再重新跟随，避免重复。

**会话关联**：CLI 提交时识别调用它的 Agent：`ORBIT_AGENT=<name>[:<id>]` 优先（`name` 是已注册的 Agent 名）；否则祖先进程中最近的
`claude` / `codex` 决定 harness（Agent 相互嵌套时子进程会继承父 Agent 的环境变量），会话 ID 取
`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`；Codex 无 ID 时按 cwd 找最近的会话文件。daemon 读取
`~/.claude/projects/**/<id>.jsonl` 或 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`，
经同一套原生转换器生成 ATIF，再投影为 `SessionMessage`（text / thinking / tool_call / tool_result），Web 标出提交该 Run 的那一步。
Run 内运行的 Agent（auth profile、bench solve）的会话随 Agent home 留在 Run 目录（`orbit/agent/{codex,claude}`），
选择最新主会话（跳过 Codex child rollout；Claude subagents 嵌入主轨迹）。`GET runs/:id/session` 从 ATIF 投影，
返回 `RunSessions { submitter, submitterError, agent, agentError }`；无 Agent 证据返回 null，读取/转换失败明确提示。
Web 两种都有时左右两栏（左提交者、右 Run 内 Agent），只有一种时单独显示，截断轨迹带提示。
远端 Run 的 Agent 轨迹与媒体由 worker 提供，经主节点转读；提交者会话仍只在主节点查找。

**失败也要保留证据**：任何终态都先采集日志与 `$ORBIT_OUTPUT`，再清理容器；日志读到 EOF，截断必须标记。
执行超时计时在确认容器 / 进程退出后立即停止，日志排空、产物采集与用量收尾不计入执行时限；
daemon 重启时仅对仍在运行的任务重新计时。bench 的超时 issue 与用量统计只识别调度器的完整超时原因，
不匹配日志或其他错误文本中的 timeout 字样。

**失败快照与续跑**（`runs/checkpoint.ts`）：`RunSpec.checkpoint { maxSizeGB }` 显式启用本地 Docker
失败快照。保存和恢复属于通用 Run 生命周期，不读取 benchmark 名、任务 ID、任务文件格式或评分器；普通
`orbit run` 走相同路径，bench job 的同名字段只传给 solve Run。目前是失败捕获后显式请求续跑，不是全后端
自动重试或运行中周期快照。命令非 0 退出且不是用户取消时，先停止容器，在 hooks / after
评测之前保存变更层为本机 `orbit-checkpoint/<run>:saved` 镜像，单独复制 `/orbit`、项目工作区和 after copy 输入；
移除副本的凭据和旧阶段文件，清空镜像配置中的注入密钥变量。共享基础镜像不重复归档；上限按 writable layer
和副本文件的逻辑字节数估算，不等同于全部 Docker 磁盘用量。`Run.checkpoint` 独立记录 ready / failed、镜像内容 ID、
大小、会话 ID、执行耗时和原因；保存失败仍执行原有采集、清理和租约释放。该失败路径跳过 hooks / after。
不支持 process、服务容器、外部可写挂载和非快照项目；只读挂载继续引用原路径。快照 Run 不能派发到 worker。
镜像声明的 VOLUME 不在 commit 中；未被显式挂载替换的 VOLUME 在容器启动前拒绝，避免漏存数据。

`POST runs/:id/resume`（`RunResume { command? }`）与 `orbit resume <id> [--command '<shell>']` 在原 Run
终态且清理完成后创建普通的新 Run，`parentId` 指向原 Run；镜像和快照文件只从 daemon 中读取并在入队前还原。
缺少必需的 `/orbit` 或项目工作区快照时拒绝恢复，不创建残缺的排队 Run。文件复制保留修改时间。
缺省使用原生 session ID 续接直接启动的 Codex / Claude 命令，保留 model / effort；command 覆盖用于离线检查，
不运行 hooks / after。续跑请求重新注入当前 auth，沿用原执行时间的剩余预算；不恢复进程内存、tmpfs 或连接。
原记录不变，新的 Run 不属于原 bench trial，也不自动计分。Web 概览显示快照及续接入口。删除原 Run / job 时
删除快照镜像；仍有排队或运行中的恢复 Run 时拒绝删除来源。使用与限制见 [checkpoints](guides/checkpoints.md)。

**实测用量**（`Run.usage`，`runs/usage.ts`）：执行节点每 5 s 采样一次运行中的 Run：docker Run 读容器的
cgroup v2（`memory.peak`/`memory.current`、`cpu.stat`、`memory.events` 的 `oom_kill`）；process Run 读其进程组
的 `/proc` RSS 与 CPU 时间，加上带 `orbit.parent` 标签的子容器的 cgroup；租到 GPU 时按这些进程的 host pid 匹配
`nvidia-smi --query-compute-apps` 的显存。记录 `{ samples, peakMemGB, peakCpus, meanCpus, peakGpuMemGB, oomKills,
oomKilled }`，运行中写库（不发变更事件），终态前再采一次并写一条 `usage` 事件；daemon 重启后接着累计（OOM 计数
不重复）。`oomKilled` = 容器被标记 OOMKilled 且非 0 退出（reason 为 `out of memory (limit N GB)`）；`oomKills` 记容器
内被杀的进程（Run 可能照常结束）。从未读到进程的极短 Run 不记 usage。远端 Run 的 usage 随镜像同步。

## 5. HTTP API 与 Web

`/api/v1`：`health`、`POST login-code`、`resources`、`doctor`、`ledger`（资源 + 活动租约 + 排队原因）、`GET/POST runs`、
`runs/:id`、`runs/:id/{cancel,note,wait,events,logs,log.txt,metrics,artifacts,files/*,diff,session}`、
`GET runs/:id/trajectory`、`POST runs/:id/trajectory/rebuild`、`GET runs/:id/trajectory/files/media/*`（§9.8）、
`POST runs/check`（运行前检查）、`POST runs/delete`、`stream`（SSE：`run` 变化推送，`deleted` 删除推送）、`GET/POST auth`、`DELETE auth/:name`、`POST auth/:name/test`、
`GET/POST notify`、`DELETE notify/:name`、`POST notify/:name/{test,pair}`，bench 路由（§7），
`GET/POST cluster/nodes`、`DELETE cluster/nodes/:name`、`GET/POST cluster/expose`、`GET cluster/token`、
`POST cluster/token/rotate`、`GET/POST datasets`、`DELETE datasets/:name`（§8），`GET folders`、`POST folders/move`、
`POST folders/export`（文件夹，见下）。`POST runs` 与 `POST bench/jobs` 可带 `?folder=`，`GET runs` 可按 `?folder=` 筛选（含子文件夹）。
`GET runs` 按 `createdAt DESC, id DESC` 分页，返回 `{ runs, next }`；`next` 是 `{ createdAt, id }` 或 null，
下一页将其 JSON 编码为 `?before=`，并保留原来的 limit/state/group/folder 条件。游标不依赖该条记录仍在库中；
整页末尾可能再请求一次空页。客户端 `list()` 仍返回一页数组，新增 `listPage()` 保留游标。
`POST /api/v1/login-code` 只接受 bearer token（cookie 不可签发），返回 `LoginCode { code, expiresAt }`：
随机 24 字节、内存保存、30 秒有效、只能兑换一次，重启即失效。`GET /login?code=&next=` 兑换后设置与 token 登录
相同的 HttpOnly / SameSite=Strict cookie。保留 `GET /login?token=&next=`；两者只跳转到站内路径，拒绝外站、
URL 解析后 pathname 以 `//` 开头的目标（含 `/.//x` 与同源绝对 URL）以及反斜杠。签发和登录响应禁止缓存。
`orbit web [id] --open` 先签发 code，浏览器启动参数只携带 code；终端打印的链接仍用 token，方便稍后复制粘贴
（30 秒 code 不适合打印后长期使用）。两种方式都支持定位到 Run，Web 后续请求仍使用 cookie。
`files/*` 以 `O_RDONLY | O_NOFOLLOW` 打开文件，校验同一 fd 为普通文件，且 `/proc/self/fd/<fd>` 的 realpath
仍位于输出根目录内，然后直接从该 fd 发送（完成或取消时关闭），daemon 与 worker 共用；拒绝最后一级符号链接。
以 `Content-Security-Policy: sandbox`、
`nosniff` 返回，避免产物中的 HTML 以 Web UI 的身份执行脚本。非法百分号编码返回 400；数字查询参数
（`limit`、`offset`、`after`、`timeout`）必须是非负安全整数，否则返回 400，省略或空值仍取默认值。
`wait` 在 Run 终态且清理结束后返回；CLI `wait -g` 与 `rm -g` 使用相同的 10000 条组内 Run 查询上限。
HTTP wait 按 Run ID 保存等待者，与全部 SSE 订阅共用一个 Run change 监听器；SSE 删除通知也共用一个监听器。
完成、超时或断开后删除对应等待者、计时器与 abort 回调，不随请求数量增加 RunService 监听器。
运行中的 process 日志按原始字节偏移分页；每次多读窗口前后最多 `maxSecretBytes - 1` 字节作脱敏上下文，
只返回请求窗口，并暂缓 EOF 附近可能尚未写完的密钥尾部。`next` 可能暂时不前进；整份日志下载也不输出这段尾部。

Web 页面（参考 W&B / Neptune 的实验对比、Modal / E2B 的沙箱运行详情、GitHub 的 diff 视图）：

- **Runs**：按 group 折叠、状态筛选、全文过滤（名称/参数/标签/分支），多选对比，键盘导航。三类条目：单个 Run、
  `-g` 实验组、bench job（显示为 job 行：benchmark、trial 进度、各配置均分；展开为 trial 行，每行 solve → verify
  状态、分数、有效性，点击进入 trial 页）。顶部按 All / Experiments / Benchmarks 筛选。首次加载及 SSE 重连时逐页加载全部 Run；
  加载期间的 SSE 更新和删除覆盖快照，加载途中断线重连会再取一遍，文件夹计数与筛选不再受 1000 条上限影响。
- **Trial**（`/bench/<job>/trials/<trial>`）：页头只有一个结论（进行中的状态、评测无效/未知、二元 benchmark 的完成与否；标量只显示分数）、
  issues、非正常的 execution / cleanup，以及与分数不重复的指标；solve → verify 时间线、实测用量和历次评分收在 Execution details
  （有回放视图时默认折叠）。标签由 adapter 的 `review` 决定，按证据形态而不是 benchmark 名称（`lib/review.ts` 的 `reviewTabs`）：
  回放（`trajectory` / `conversation` / `episode`）与测试报告（`tests`）各占一个标签并排在最前；没有回放时 Markdown 报告和视频也各占一个；
  其余文件合并为 **Evidence**（左侧文件列表，一次看一个；只有一个文件时直接是标签）；**Rubric** 来自 `items`（逐条得分、权重、理由，
  可只看失分项）；Details 来自 `details` 与未知字段。每个 kind 由 `pages/trial/Review.tsx` 的 `FILE_VIEWS` 渲染，新增 kind 时类型检查要求补齐；
  文件读取共用 `lib/run-file.ts`，各视图保留自己的预览上限。之后固定有 Configuration、Agent session 与 Outputs（两个 Run 的全部文件）。Markdown 只生成 React 元素，不渲染 HTML、不加载外部图片，
  图片按相对路径取同一 Run 的文件。bench 的 solve / verify Run 页面包屑为 `Bench / job / trial / phase`，带 “← Trial”。
  Runs 页选中整个 job 行可删除该 job。
- **Run 详情**：Overview（生命周期时间线、清理核对、笔记、指标迷你图、日志尾）、Logs（虚拟列表、ANSI、
  搜索、跟随）、Metrics（uPlot，平滑、同步十字线）、Artifacts、Code（相对快照 commit 的 diff）、
  Session（提交者会话标出提交点，与 Run 内 Agent 会话并排）、Events。
- **Compare**：`?ids=` / `?group=`，按 seed 聚合 mean ± std、相对基线的变化、曲线叠加、配置差异。
- **Resources**：GPU 卡片（Orbit 租约 / 外部占用 / 空闲、显存与利用率，以及占用显存的每个进程：用户、
  命令、PID、容器或 Run、已运行多久）、租约与队列、worker 节点表（§8）。
- **Bench**：job 列表、job 详情（分数矩阵，格子进入 trial 页）、配置对比（§7）。Merge retries 对话框提供来源 ID 和选项解释，
  先预览 adopted、reclassified（task/kind）、removed runs/jobs，再输入目标 job ID 并携带 digest 应用；改选项后必须重新预览。
  使用原生 modal dialog 管理焦点与 Esc，关闭后恢复入口焦点。
- **页面框架**：一级页面在面包屑下有统一的 `PageHeader`（标题 + 一句说明），内容区最宽 `--content-max`（1600px）居中；
  侧栏底部为连接状态与快捷键 / 主题 / 折叠三个图标；job 状态用彩色徽标，`<details class="card">` 统一带折叠箭头。
- **地址**：旧地址先由 `legacyHref` 重定向；`routes.ts` 之外的路径显示 “Page not found”，不再回落到 Overview。
- **轮询**：`useAsync` 与 Logs 在隐藏标签页暂停轮询，重新可见时刷新一次后恢复；进行中的请求仍可完成，SSE 继续接收。
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
  job 与 trial（`jobs/<id>.json`）和 `index.json`；`dest` 须为空且不在数据目录内，输出留在其他节点或复制失败的 Run 列入 `skipped`；复制失败不写 `run.json`，不计入成功数量与字节数。
- **Run 显示名**：未给 `-n` 时由 `contracts/naming.ts` 的固定规则从命令得出（去掉 `python`、`torchrun`、`accelerate
  launch`、`uv run`、`sh -c` 等启动器，取脚本或模块名，加 `key=value` / `--flag value` 参数，去掉路径与长文本，最多 60 字符；
  认不出时用截断的命令）。只影响显示，记录中的 name 仍为空、command 完整保留。
- **Settings**：容器内 Agent 版本、auth profile（掩码、测试、删除）、通知目标（发测试、删除）、浏览器通知开关。
  Web 不录入密钥：添加 profile / 目标只走 CLI。

## 6. 认证（auth）、Agent 注册表与通知

**Agent 定义**（`contracts.AgentDefinition`）：Orbit 能驱动的每个 Agent 都是一份声明，见 `harness/definitions.ts`
（内置）与 `~/.orbit/agents.json`（用户，0600）。Agent 名同时是 auth profile 的 `harness`、bench method 的
`agent` 和会话的 `harness`，因此是稳定标识而不是显示名。

```
{ name, description?, install, auth, command, env, capabilities, verified, origin }
```

- `install`：`host`（挂载宿主已有的 CLI：`binary`、`mount`、`pathDirs`、`pathEnv`，`withNode` 时同时挂载 daemon 的
  Node 运行时供 Node 脚本使用）| `install`（在容器内跑 `script`，要求镜像有对应工具链与网络）| `image`（任务镜像自带）。
- `auth`：`kinds`（login / api-key / relay）、`secretEnv`（每种 kind 的密钥变量名）、`env`（可含 `{model}` /
  `{baseUrl}` / `{home}`）、`baseUrlEnv`、`modelEnv`、`home` + `homeEnv`（CLI 自己的状态目录，位于 `/orbit/agent/<name>`）。
- `command`：`run` 与可选 `resume` 的 argv 模板（不是 shell 字符串），占位符 `{instruction}` `{model}` `{effort}`
  `{session}` `{home}`，可选参数写成 `{when:model} … {end}` 组；`transcript` 给出 CLI 自己的会话轨迹 glob 与格式。
- `command.mcp`（默认 `{kind:"none"}`）声明 MCP 接线：`claude-json` 的 flag 指向 Agent home 的 `orbit-mcp.json`；`codex-toml` 向该 home 的 `config.toml` 增加 server 表。工具声明通过 trial 私有 bundle 随原启动流程写入，保留已有配置、拒绝同名 server；未接线但声明 MCP 能力的定义在 `agent show` 显示 `MCP declared, not wired`。
- `capabilities`：`oneShot` / `multiTurn` / `mcp` / `gui`，在提交 bench trial 前与 benchmark 的要求比对。
  Codex 与 Claude Code 声明 `gui`；Codex 的 BrowserGym/MiniWoB 截图与 CLI 工具路径已通过真实开发校准和独立签名核验，
  不扩展为其他 GUI 后端的实跑声明。GUI 的私有服务需要容器网络与可达的模型连接，拒绝 `hostNetwork` profile。
- `verified`：该定义在本机真实跑出过预期结果。内置的 codex 与 claude-code 为 true，其余为 false，直到
  `orbit agent test` 验证。

内置定义：`codex`、`claude-code`（带专属配置写法的代码路径），以及 `pi`、`opencode`、`kimi-cli`、`gemini-cli`、
`aider`、`goose`、`qwen-code`、`copilot-cli`、`mini-swe-agent`、`dsh`（纯数据，走通用启动路径）。命令行、安装方式与
会话位置对照 Harbor 的 `agents/installed/`（`f6cf2e2`，2026-11-03）核对；除 codex / claude-code 外均未在本机运行过。
内置名不能被用户定义覆盖或删除。

HTTP：`GET/POST /agents`、`GET/DELETE /agents/:name`（模板占位符、`{when:…}` 配对、`resume` 是否带 `{instruction}` 在写入前校验）。
CLI：`orbit agent ls|show|add|rm|check`。`orbit doctor` 为每个定义报告本机是否可用与版本。

**Auth profile**（`contracts.AuthProfile`，公开字段不含密钥）：

```
{ name, harness: <Agent 名>, kind: login | api-key | relay, baseUrl?, model?,
  env(非密钥附加变量，如 HTTPS_PROXY), hostNetwork, secretHint, createdAt, updatedAt }
```

- 保存在 `~/.orbit/auth.json`（0600，只有 daemon 写），codex 登录态（Codex 的 `auth.json` 内容）也内联在其中。
  API 与 Web 只返回公开字段和掩码提示；密钥只经本机 HTTP 提交一次，CLI 从 stdin 或环境变量读取，不走 argv。
- 注入由 profile 的 `kind` 与该 Agent 定义的 `auth` 决定；密钥变量名不在代码里硬编码：

| Agent / kind | 容器内 |
| --- | --- |
| codex login | `$CODEX_HOME/auth.json` 为 profile 登录态的副本；run 结束后若 token 已刷新则写回 profile |
| codex api-key | `$CODEX_HOME/auth.json` = `{ OPENAI_API_KEY }` |
| codex relay | `$CODEX_HOME/config.toml` 定义 provider（`base_url`、`env_key = ORBIT_RELAY_API_KEY`），密钥经环境变量 |
| claude-code login | `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成的长期 token） |
| claude-code api-key | `ANTHROPIC_API_KEY` |
| claude-code relay | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| 其他 Agent | 定义里的 `secretEnv[kind]`，加上 `env` / `baseUrlEnv` / `modelEnv` 与 `home` / `homeEnv` |

- 密钥环境变量通过 0600 的 `--env-file` 传给 `docker run`，启动后删除（`docker inspect` 仍可见，仅限本机
  docker 用户）。run 结束后删除容器内写下的凭据文件（内置两个 Agent 的已知路径，以及其他 Agent home 顶层的
  常见凭据文件名）；日志写入前按当前所有密钥脱敏（`[redacted]`）。
- `orbit auth test <name>` 用该 profile 提交一个真实的小 Run（`auth-test` 组），让 Agent 回复固定口令并检查日志；
  结果作为 Run 保留。

**Harness**：`RunSpec.auth = <profile>` 时，`prepareAgent` 按定义准备那次 Run：`host` 定义把宿主 CLI 只读挂载进容器
（codex 为静态 musl 二进制，挂到 `/opt/orbit/codex`；Claude Code 原生二进制需 glibc，挂到 `/opt/orbit/claude`），
`install` 定义在执行前跑安装脚本，`image` 定义依赖任务镜像。按镜像的 `PATH` 追加这些目录，并在事件中记录版本。
Agent 的 home 放在 `/orbit/agent/<name>`，会话轨迹随 Run 记录保留。
容器本身就是沙箱：容器内 codex 用 `--dangerously-bypass-approvals-and-sandbox`，claude 用
`--dangerously-skip-permissions`；其他 Agent 的免确认参数写在各自定义里。profile 设置 `hostNetwork` 时 Run 使用
宿主网络（例如代理只监听 127.0.0.1）。方法 bundle 复制到 `/orbit/agent/<name>`，`AGENTS.md` 与 `CLAUDE.md` 互相补齐。

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
`orbit notify add --url-stdin` 从 stdin 读取 webhook URL（终端不回显）；`--url-env VAR` 保留。
兼容 `--url`，但 stderr 警告 URL 会出现在进程参数中。见[通知指南](guides/notifications.md)。

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
Configuration = Agent definition + model + effort + auth + optional bundle, or Policy snapshot, or external entrypoint + config
Benchmark     = tasks + per-task environment + instruction + verifier + aggregation
Trial         = task × Configuration × seed → solve Run (Agent inside) + verify Run (separate)
Outcome       = { execution, evaluation: valid|invalid|unknown, score?, maxScore, metrics?, issues[], cleanup }
```

当前产品使用“评测配置”（Evaluation configuration）：选择运行器、模型、思考强度和可选提示词 / skills 包，
或选择 Policy / external 的具体配置。独立 Method 的身份、定义与生命周期尚未设计，留待后续引入。
为兼容已有作业与调用方，类型 `Method`、API / JSON 的 `method(s)` 字段和 CLI 参数保留原名；以下接口说明中的旧名称均指评测配置。

- **评测配置**（兼容类型 `contracts.Method`）：`{ name, agent, auth?, model?, effort?, bundle?, policyRef?, policySnapshot?, entrypoint?, config?, passEnv? }`。
  `agent` 是一个已注册的 Agent 名（§6；`codex`、`claude-code`、`pi`、`opencode`…），或 `external`（adapter 自己的策略）、
  `oracle`（跑参考解）、`empty`（不作答，用于检验适配器），或 `policy`（独立具身策略，见 §9.4a）。这些保留名不能注册为 Agent。
  `policy` 通过 `policyRef` 选择已登记定义，提交时保存 `policySnapshot`；不接收 CLI 的 auth、model 或 bundle。
  提交 job 前检查 Agent 已注册、auth profile 的 harness 与之一致且 kind 受该 Agent 支持；`agentCommand` 由定义的模板渲染。
  `install` 型 Agent 在 Docker solve Run 的命令前安装（`orbit/agent/setup.log`），安装失败记为环境失败、不 verify；
  process Run 拒绝 `install` 型 Agent。ASI 与 LongDS 的原生 runner 只启动 codex / claude-code，由 adapter 在 `capabilities.methods` 中声明，
  提交与兼容矩阵按同一声明拒绝其他 Agent（`<benchmark> does not support <agent> methods`）。
  `bundle` 目录（AGENTS.md / CLAUDE.md、skills）复制进 Agent home（`RunSpec.agentBundle`）；Agent 版本由 Run 的
  `harness` 事件记录。`external` 必须有 adapter 解释的 `entrypoint`，可带非密钥 `config`、`model`、`effort`，
  不接受 CLI 的 auth/bundle；其 `passEnv` 只把 daemon 环境中的指定变量注入 solve，变量值不进入 Method。
  `entrypoint/config/passEnv` 仅用于 external；这些方法计入 Agent 资源用量统计。核心不实现新的 Agent 循环。
- **Benchmark 登记**：`~/.orbit/benchmarks.json`（0600，daemon 写）存 `{ name, adapter, path, config, env, passEnv[] }`。
  `adapter` 为内置名（`harbor`、`asi`）或适配器可执行文件的绝对路径；`config` 是适配器自己的非密钥设置（如 asi 的
  `python`、`instances`）；`env` 进入两个 Run；`passEnv` 只记变量名（如评审模型的 API key），只给 verify Run，启动时
  从 daemon 环境读取，不落盘。登记时先调用一次适配器的 `tasks`，失败则不保存。
  registry 按文件 mtime 缓存解析结果；替换、删除与 daemon 自己的写入也使缓存失效，返回值仍与缓存隔离。
- **Job / Trial**：sqlite 表 `bench_jobs`、`trials`。每个 trial 独立推进：`pending → solving → verifying → done`；
  新 job 保存登记配置快照 `benchmarkSnapshot` 和适配器的可选 `capabilities`，执行、重启恢复及重查使用同一快照；旧 job 仍回退当前登记。快照不包含凭据值，也不冻结路径下的文件或镜像标签内容。
  job 和全部 trial 在同一事务内提交；`BenchService` 监听 Run 变化推进，daemon 重启后从库中恢复未完成的 trial。
  trial 结束时 staging 删除失败只记日志，继续完成 job 状态更新。solve 与 verify 都是普通 Run
  （同一租约、队列、记录、Web 详情），`group = bench-<job>`，tags `{bench, job, trial, phase}`；verify Run
  `priority = 1`，排队时先于新的 solve 调度。
  非 bench Run 的事件在查询 trial 前跳过。trial 完成时通过未完成 trial 的部分索引判断 job 是否完成；job 列表用一次
  SQL 聚合查询取得各方法计数和有效 trial 的精简指标字段，再用共享指标函数计算逐任务均值与跨任务统计，
  保留原来的浮点累加顺序与响应形状，不加载或 zod 解析完整 trial。
  取消先保存 cancelled job 并取消关联 Run，再在后台串行推进 trial；HTTP 不等待适配器评分，CLI / Web 仍显示 job 状态。已持久化 cancel 意图的 Run 不重复取消，避免更新事件反复触发同一请求。
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
| solve 内的 Agent 从未产生成功模型回复，且最后一轮以明确的认证、额度、模型不可用或连接错误结束，或未结束但可信 CLI 日志尾部明确停在模型重连/认证刷新拒绝（`sessions.runAgentFailure` 读 Run 的 Agent home 与日志尾；`harness.agentErrorKind` 先看结构化错误码——Codex `codex_error_info` 及其 HTTP 状态码、Claude Code 的 `error`——再看文本；对所有适配器生效）：不提交 verify，记 `verify skipped` 并保留 OOM、服务失败等问题；显式 rescore 时照常评分并保留分数 | invalid |
| Codex 在 session 创建前因无法读取 Run 私有 `config.toml` 而退出；仅在无 Codex/Claude transcript 时识别日志头前 16 KiB 内完整的原生权限错误，允许已知 PATH 提示与 Orbit after 阶段边界；不从普通工具权限错误推断 | invalid / `infra`（`agent_configuration_failed`），保留 shared verifier 的原始分数 |
| verify 未启动、超时、内存不足，没有分数，或适配器判为无效（无 reward、scorer 内部错误、judge 不可用、模型不可用且 0 分） | invalid |
| 调用 adapter `score` 失败：adapter 进程出错或回复无效（`AdapterError`）记 `scorer_error`；Orbit 自身在评分路径上的异常记 `infra`，issue 写 `score: Orbit error: …` 并写入 daemon 日志 | invalid |
| 其余 | valid |

  只有 `valid` 的分数进入均分；无效或未知单独列出，不静默计入。清理状态按 failed > pending > done 汇总 Run 的 `cleanup`。
  Agent 失败检查在推进、评分和归并时共用同一条件：`solveVerdict(run).verify`，包括正常退出与 after 阶段的 solve；
  成功模型回复后的失败仍正常评分；用户文本、工具输出、非零退出或没有 GUI 动作都不能单独作为模型故障证据。after 已有分数保留，评测有效性独立判定。错误摘要先脱敏再截断。
  BenchService 启动时对 done 且 outcome.cleanup 为 pending 的 trial 重算其全部关联 Run（含评分历史）的清理状态，
  逐条记录修复的 trial ID；重复启动不再写入已修复结果。后续 Run 通知也使用同一汇总规则。
- **重试归并**：`POST /bench/jobs/:id/consolidate` / `orbit bench consolidate <job> [sources...]`
  默认只预览；`--apply` 才执行。每个计划返回 `digest`（对 adopted、reclassified、removedRuns、removedJobs 的规范排序内容计算 SHA-256）；
  apply 可带 `expect`，CLI / Web 都传入已确认预览的 digest。daemon 在任何写入或删除前重新计算，摘要不符则拒绝并提示
  `plan changed since preview; preview again`。只接收全部 trial 已完成、Run 已清理且无后台更新的任务；同 benchmark、methods、options、metrics，
  按 task × method × seed 对齐。归并先重读符合上述条件的 solve 的会话末轮错误及已知的 session 前配置故障；这些启动或模型访问问题
  会把旧的 valid / unknown 标记改为 invalid（包括同一次 solve 的评分历史），原始分数保留，结果的 `reclassified`
  列出这些 trial；不带来源时只做这一复核；预览不写回。读取后重新检查终态及归属。
  有效重试只替换无效位置，拒绝覆盖真正有效的成绩（包括 0 分）或从多份有效成绩里挑选。
  `--replace-failed` 显式采用 solve 正常成功的新尝试：允许替换实际 solve 为 failed、但仍有 valid 分数的位置及其历史，
  不以分数高低选择；已正常成功的有效 solve 仍受保护。新尝试若为 invalid 且 solve 已成功或失败结束（非 lost），仅可替换原本无有效分数及有效历史的位置，
  保留其 invalid 状态、错误和全部产物，不可和 `--prune-invalid` 同用。同一次归并拒绝多个来源替换同一位置。
  保留目标 trial ID、来源 Run ID、原产物与 source_job/source_trial 标签；daemon 在单事务内更新归属并移除来源 job，
  再调用已有 RunService 删除废弃 Run。`--prune-invalid` 清除无效 Run 与无效评分历史，保留任务位置及失败原因；
  本次从 valid / unknown 改为 invalid 的 trial 保留全部 Run 与历史，复核后下次调用才可清除。
  带 prune 的调用若还要用来源替换刚重分类的位置，或丢弃刚重分类的来源 trial，则拒绝该组合，须先单独复核。
  `--append-tasks` 追加尚未出现的任务（同 methods × seeds），更新任务列表并保留新增 trial 的有效/无效/未知结果及产物；
  不可和 `--prune-invalid` 同用。拒绝来源之间重复的新任务位置。新增 Run 记录保留 source_benchmark 与原 auth。
  `--allow-transport-differences` 显式允许同 checkout 路径、adapter、config、已记录 git source、指标与方法的代理配置别名：
  只允许 HTTP(S)/ALL/NO_PROXY 和 hostNetwork 差异，auth 别名必须使用相同凭据及模型端点；其他环境变量不放宽。
  旧 job 未记录 git source 时双方都须为空；新 job 还比较保存的登记配置和能力声明，新旧记录之间不能归并；路径下的 benchmark 内容仍须由调用方保持一致。
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
  适配器独立进程组运行；超时立即拒绝调用并向整组发 SIGTERM，250 ms 后 SIGKILL，关闭管道并解除子进程引用，
  不等待后代持有的 stdout 关闭。正常完成仍读到 stdout 末尾。
- 请求：`{ protocol: 1, op, benchmark: { name, path, config }, trial?, solve?, verify? }`；`trial` =
  `{ id, task, method, seed, options, timeoutMin?, resources?, staging, hostNetwork }`（`resources` 为 job 固定的任务 solve 资源覆盖值，供原生 runner 同步设置子容器限制；`staging` 是 trial 私有的宿主目录，用于要挂进
  Run 的副本，trial 结束时删除）；`solve` / `verify` = `{ run, output }`（Run 记录与其 `$ORBIT_OUTPUT` 的宿主路径）。
- 回复：`tasks` → `{ tasks: BenchTask[], metrics?: MetricSpec[], capabilities?: BenchCapabilities, official?: OfficialRule }`；`solve` / `verify` → `{ spec, issues? }`；`score` →
  `{ score, maxScore?, invalid?, issues?, review?, metrics?, failure?, episode? }`。`official` 与报告修订见 §9.7（已实现部分）。`review`（可选）告诉 trial 页展示什么：
  `files[{ label, phase: solve|verify, path(相对该 Run 输出目录), kind?, fallback? }]`、`items[{ criterion, score?,
  maxScore?, weight?, type?, reasoning? }]`、`details{ key: 短值 }`。`kind` 是封闭集合：六种文件视图 `markdown | image | video | text | json |
  table` 与四种专用视图 `trajectory | episode | conversation | tests`（`tests` 读标准 CTRF 测试报告；名为 `ctrf.json` 的文件即使未声明 kind
  也按测试报告显示，旧 trial 无需重新评分），样式全由 Web 决定，adapter 不能传 HTML / CSS；不认识的 `kind` 依次退回 `fallback`、文件扩展名、纯文本，并在页面
  标注。未知字段保留（`looseObject`），在 Details 中按键值显示；长文本截断，条目数有上限。`review` 随 Outcome 保存，
  分数无效时也保留。没有 `review`（旧 trial、旧 adapter）时 trial 页退回猜测：solve 的 Markdown 报告与 verify 的 JSON。适配器只生成 Run 描述、读文件，不提交 Run，不判定取消、超时、未启动。
- `capabilities` 描述身份、六维分类（`taxonomy`）、支持的 method（具体名保持原义：`["codex"]` 只允许 Codex；`cli` 显式允许所有 Agent CLI）、固定条件、二元/标量成绩和 `evidence | score | none` 重查语义；`requires`（`oneShot | multiTurn | mcp | gui`，默认空）列出 CLI method 必须在 Agent 定义中声明的能力；daemon 在提交时检查 method 与 `requires`（要求 MCP 时还需实际接线），Web 不按 benchmark 名称猜能力。任务 HTTP 接口返回这些可选信息，旧客户端仍可只读 tasks。旧 adapter 回复中的 `category` / `profiles` / `domains` / `kind` 被忽略（§9.10）；分类标签不替代准入检查。
- `GuiTrajectory` 是版本 1 的 JSON 产物：goal、连续 steps 和可选 stopReason；step 0 是无动作初始截图，后续行记录动作后的截图、奖励、动作错误和终止标志。路径相对 solve 输出目录；Web 在请求截图前验证结构和路径，不执行动作。BrowserGym 从原始 JSONL 生成该视图，核验时同时检查视图一致性与哈希；旧输出保持兼容。
- `contracts/trajectory.ts`：`GuiStepContext`（step 的 `actionId` / `at`，用于把 Agent 会话中的工具调用与 GUI step 精确对齐，不按时钟猜）与
  `EpisodeTrajectory`（版本 1、`kind: "episode"`：多相机帧/视频、动作与本体感知曲线、奖励；只含保存的媒体和数值，不含可执行动作）。
  review `kind` 因此增加 `episode`，Web 按该 schema 校验后渲染具身时间线。
- CLI Agent 驱动 GUI 时，环境运行在可信 service 中，Agent 只经 `orbit-computer`（CLI / MCP）拿观测、发动作；证据只由 service 写出并在
  收集时进入 `services/<name>/`。service 每个 trial 生成 Ed25519 密钥，私钥只在 service 内，公钥写进 solve Run 的 service env；
  verify 与 score 用 Run 记录里的公钥核验签名，伪造或缺失签名记 `scorer_error`（无效）。daemon 采集时只写入真实目录（不跟随运行
  预置的符号链接，含 output 根目录），复制失败时目标处不留运行自己写的内容。
- Run 描述是 RunSpec 字段，但不能含 Orbit 自己管的字段（`name group params project snapshot auth agentBundle agent
  parentId priority passEnv`），且 `command` 与 `agentTask: { instruction, tools? }` 二选一。`tools` 最多 8 个 stdio MCP server（`name`、非空 `command` argv、可选 `env`），只交给 Agent 启动，不能覆盖 Orbit 管理的 Run 字段；旧 adapter 无需增加字段。Agent 方法（codex / claude-code）的
  solve 用 `agentTask`：Orbit 按方法生成 Agent CLI 命令（`harness.agentCommand`，从该 Agent 定义的 `command.run` 模板渲染），并设置 auth、bundle 与
  网络；也可以给 `command`（原生 runner 自己启动 Agent，如 ASI），Orbit 同样设置 auth 与 bundle。oracle / empty 只能给
  `command`；external 也给 adapter 自己的 `command`，Orbit 只加方法的 solve `passEnv`，不注入 CLI 或强改网络。
  verify 不能请求 Agent。显式 `passEnv` 在对应阶段优先于 adapter 的同名环境默认值，避免 Harbor 模板空值遮住凭据；变量值仍不入记录。Orbit 再加上 benchmark `env`（两个 Run）、`passEnv` 与 `priority = 1`（verify），
  `snapshot = false`，最后按 RunSpec 校验。
- **任务资源文件**（`contracts.BenchResources`，`bench/resources.ts`）：`orbit bench add --resources <file>` 登记一个
  JSON：`{ version: 1, default, tasks: { <task>: { cpus?, memGB?, gpus?, gpuMemGB?, timeoutMin?, evidence?, confidence?,
  note? } } }`，未知字段报错，`evidence` 等只给人看。只覆盖 solve Run：任务条目 > `default` > 适配器给的值，
  `orbit bench run --timeout` 仍优先于 `timeoutMin`。在调用适配器前按 CLI > 任务条目 > `default` 解析 solve 时限，
  通过 `trial.timeoutMin` 传入，返回的 solve spec 也使用该值；都未设置时保留适配器默认值。verify 时限不受此覆盖。
  登记时与提交 job 时校验（文件中不存在的任务 id 报错）；提交时
  把每个任务解析后的值存入 `BenchJob.resources`，之后改文件不影响已提交的 job。文件由人（或其 Agent）维护，
  Orbit 从不写它。
- **用量建议**：`orbit bench usage <job>...`（`GET /bench/usage?jobs=`）汇总 Agent 方法 solve Run 的实测峰值（oracle /
  empty 不计），与当时的申请对比并给出建议：内存与显存 = 峰值 × 1.2 向上取到档位（2…256 GB），OOM 后至少升一档，
  至少两次运行且有一半余量才建议调低；CPU 取峰值档位；超时 = 最长耗时 × 1.5 取整小时，超时过则至少 ×1.5；
  GPU 数量从不建议（是否需要 GPU 是对任务的判断）。`--suggest` 输出资源文件片段（带 evidence），只打印不写回。
- 提交 job 与 daemon 重启后恢复 trial 都在后台依次推进（每次调用是一个进程），不阻塞 API 与 daemon 启动。

内置适配器：

1. **Harbor 格式**（`bench/harbor.ts`，TB-Science）：任务目录含 `task.toml`、`instruction.md`、`environment/`、
   `tests/`、`solution/`。solve / verify 按 ID 直接定位平铺任务，只解析选中的任务；嵌套短名与重名的相对路径 ID
   保留 listing 的四层目录发现规则，但只扫描目录元数据。score 直接读取 verifier 输出。
   solve Run 用 `[environment] docker_image`（Harbor 优先用它），否则从 `environment/Dockerfile`
   构建，以镜像用户初始化并遵守 `workdir`（缺省为镜像 WORKDIR）；声明的 `[agent] user` 通过 `commandUser` 切换主命令账户；资源、超时来自 `task.toml`；Agent 方法给出 `agentTask`
   （`instruction.md`），oracle 把 `solution/` 挂到 `/solution` 执行 `solve.sh`。顶层 `artifacts` 声明的路径在 solve
   结束时采集（`RunSpec.collect`，写入 `output/collected/<abs path>`）。verifier 模式按 Harbor 规则解析：显式
   `environment_mode`，否则有 `[verifier.environment]` 即 separate，否则 shared。shared：solve Run 带 after 阶段——
   方法结束后把 `tests/` 复制到 /tests，以 Harbor 的命令（`chmod +x` 后执行 `/tests/test.sh`，输出写
   `/logs/verifier/test-stdout.txt`）、`[verifier.env]`、`[verifier] timeout_sec` 与 verifier 阶段网络运行，采集
   `/logs/verifier`；不再起 verify Run，从 solve Run 的 `output/after/` 评分，after 阶段未运行 / 超时记为 invalid；
   环境已不在，不能 `bench rescore`。separate 的镜像顺序同 Harbor：
   `[verifier.environment] docker_image` → `tests/Dockerfile`（二者自带 /tests）→ `tests/docker-compose.yaml`（不支持）
   → 任务环境的新副本（继承其资源、网络、变量，`tests/` 挂到 /tests）。verify Run 把采集到的产物复制挂载到目标路径，
   使用与 shared 相同的 `chmod +x`、直接执行命令和 `/logs/verifier/test-stdout.txt` stdout/stderr 采集，
   采集 `/logs/verifier`，读取 `reward.json`（`reward` 键或唯一键）或 `reward.txt`。
   网络按阶段解析：`[agent]` / `[verifier]` 的 `network_mode`，否则所在环境的（缺省 public）。
   `environment/docker-compose.yaml`（`bench/compose.ts`）翻译成服务容器：`main` 取 `environment`、`working_dir`、
   `depends_on`、`networks`（其 `command` 是 Harbor 的保活命令，忽略；task 的 `[environment.env]` 覆盖 compose 的值），
   其他服务取 build/image、command、environment、working_dir、cpus、mem_limit、healthcheck、depends_on（started /
   healthy）、networks、init、read_only、tmpfs、cap_add/drop、security_opt、pids_limit、shm_size、restart、
   `network_mode: none`、volumes（顶层声明的命名卷，或任务 environment 目录内的相对路径 bind）；`pid: host` /
   `cgroup: host` 只在登记时 `-c hostNamespaces=allow` 后接受（资源监控容器能看到本机全部进程）。`main` 另取 volumes 与
   pids_limit；`main` 的 `image` 只接受与 `[environment] docker_image` 相同的值；`[[verifier.collect]]` 变成 hooks；
   顶层 networks 只认 `internal`，顶层 volumes 只认无配置的项目卷。命名卷随 Run 创建（`orbit-<run>-<name>`，带
   `orbit.parent` 标签），清理时在容器与网络之后删除。服务名允许 `_`（与 Compose 一致）。
   插值同 Compose（`${VAR}`、`${VAR:-d}`、`${VAR-d}`、`$$`），变量为 CONTEXT_DIR、CPUS、MEMORY、PREBUILT_IMAGE_NAME 与
   任务变量；未知变量、其他键（ports、外部卷等）都列为不支持。`service = "<名>"` 的 artifacts 从该服务采集。
   未实现的设置一律标为不支持而不是忽略（否则分数不再对应任务条件）：compose 中未实现的键、
   复用 compose 环境的 separate verifier、`allowlist` 网络（登记 `-c allowlistNetwork=public` 时按公网运行并记为偏差）、非 linux、verifier 环境的 `gpu_types`、`tpu`、`mcp_servers`、`skills_dir`、`healthcheck`、`[agent]`/`[verifier]`
   `user`、`[[verifier.collect]]` 的 `user`、`[[steps]]`、没有默认值的 `${VAR}` 变量模板（整值 `${VAR:-d}` 取默认值，
   记为偏差，因为 Harbor 读宿主环境）；Harbor 也忽略的未知字段照样忽略。允许的偏差写入任务 tag `deviations`，
   并作为 `deviation: …` issue 记在每个 trial 上。
   指标：主指标 `resolved`（reward ≥ 1 的 trial，%，即 Terminal-Bench 的 resolution rate），`score` 标为 Reward（平均 reward）。
2. **原生包装**（`bench/asi.ts`，ASI-Bench seed31415）：solve Run 以 **process 后端**运行
   `config.python -m ai4sci_bench.cli run`（单实例、单 prompt level，`--output-dir $ORBIT_OUTPUT/native`）；Agent 方法走
   ASI 自己的 `codex_cli` / `claude_code_cli` 适配器，oracle 用 `--agent-cmd` 复制 `reference/` 中的声明输出，empty 为
   `true`。verify Run 把 solve 结果复制到自己的输出目录，给没有产出任何声明文件的结果补一个空 `.outputs/`
   （原生 scorer 否则直接报错），再运行 `ai4sci_bench.cli score`；分数取该实例最新 attempt 的 `final_score / max_score`。
   指标：主指标 `score`（`final_score / max_score` 的 %），另有 `fullMarks`（满分 trial 的 %）。
   ASI checkout 只读：进程 cwd 是 Run 目录，`PYTHONPATH` 指向 checkout，`PYTHONDONTWRITEBYTECODE=1`。
   solve 显式启用 `--fail-on-agent-error`，原生 `--timeout` 与 solve Run 使用同一个已解析时限。Agent 方法在规划时通过 `config.python` 的 AST 解析，
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
有 auth 时注入 Agent CLI 与凭据挂载；Agent home 参数位于 runner 参数之后、镜像之前，使原生 runner 的 home 设置不会覆盖 Orbit 的认证与会话目录；其他 profile 环境默认值仍可被 runner 覆盖。`hostNetwork` 时 build 用宿主网络，其余参数原样传给真实 docker。
取消 / 超时向进程组发 SIGTERM（宽限后 SIGKILL）并停止子容器；只有进程组与带标签的子容器都消失才释放租约。
daemon 重启后按 pid + 启动时间重新接管进程。运行中的 process Run 日志通过 API 读取时按 §5 脱敏，结束后在磁盘上统一脱敏。

**接口**：API `GET/POST /benchmarks`、`DELETE /benchmarks/:name`、`GET /benchmarks/:name/tasks`、
`GET/POST /bench/jobs`、`GET /bench/jobs/:id`、`POST /bench/jobs/:id/{cancel,rescore}`、`GET /bench/compare?jobs=a,b`；
CLI `orbit bench add|ls|rm|tasks|run|jobs|show|cancel|rescore|compare [--metric]|usage`（`add --adapter <name|path> -c KEY=VALUE
--resources <file>`）；Web `/bench`（job 列表与登记的 benchmark）、
`/bench/<job>`（配置均分、有效性分布、任务 × 配置分数矩阵、问题列表与 solve/verify Run 链接）、
`/bench/compare?jobs=`（逐任务对比、全部与配对均值 ± 95% CI、相对第一列的配对差、带参考线的排名条；`?metric=` 切换指标）。接入新 benchmark 见
[guides/bench-adapter.md](guides/bench-adapter.md)。

Web `/bench/new` 支持环境/任务选择、评测配置编辑或导入、复制已有 job、运行数量预览与提交。固定环境条件只读，复制使用当前登记并提示与原快照的差异。详情区分有效零分和评测异常，支持任务/配置/seed 筛选；重查期间根据 trial 刷新，不因 job 已结束停止更新。Compare 可选择任意配置为基线，复用共享统计函数重算配对差，按任务改善/退步筛选并链接到 seed 列表；筛选不改变整体统计。Trial 的 trajectory 查看器提供动作前后画面、步骤链接、键盘导航、原图/缩放和缺失记录提示，默认仅加载选中截图，保留 Markdown 与非 GUI review。指南：[GUI Web](guides/gui-bench-web.md)。

- **外部适配器示例**：ResearchClawBench（`examples/bench-adapters/researchclawbench/`）。solve 为 Ubuntu 22.04 容器，
  任务 workspace 在 `/task`（`data/`、`related_work/` 只读，其余可写，结束时采集），原版指令模板，RCB 的 venv 按宿主路径
  只读挂载；verify 为 process Run，在 RCB `.venv` 中调用原版 `evaluation.score.score_run`。没有 report 为有效 0 分，
  judge 调用失败为 invalid；分数 0–100（50 ≈ 原论文水平），多次 judge 取均值。RCB 没有参考解，oracle 不可用。
- **LongDS-Bench 示例**（`examples/bench-adapters/longds/`）：process solve 调用 DataMind 原版 Codex / Claude runner，
  一任务一容器、原生会话按顺序发送全部轮次；任务定义与参考答案保留在宿主，不挂入 Agent 容器。CPU/内存请求与
  native Docker 限制使用同一已解析资源覆盖。完整任务与原版 judge 源码随 solve 保存，独立 process verify 使用保存的
  `judge_one` 和输出函数重建评分输入；空答案有效零分，参考答案回放仅供 oracle 校准，缺轮/失败 turn/judge 错误均 invalid。
  每任务为全部 turn 正确率，Orbit 对任务均值等权汇总，对齐原版 `task_avg_score`；支持保存产物重评。
  版本/split 使用独立任务列表，缺数据明确 unsupported；GPU 请求拒绝。此 native process 路线尚不支持失败断点恢复。
- **PostTrainBench 示例**（`examples/bench-adapters/posttrainbench/`）：native 方法从采集到的
  `home/ben/task/final_model` 验证和评分，其他方法使用 `task/final_model`；仅 `native=empty` 挂载完整 checkout
  和 dotenv 并设置 `AGENT_ENV`，其他方法只挂载 `src/`，避免通过 `/repo/.env` 暴露凭据。
- **接入验收（任意新 benchmark）**：oracle 满分（没有参考解时省略）、空答案零分、抽样与原版结果一致。
- **BFCL multi-turn 示例**（[adapter](../examples/bench-adapters/bfcl-multiturn/)）：直接登记工具工作流，一 trial 一完整会话。独立离线 verify 从保存的调用文本重建原版 Python 工具环境，调用固定版本的
  状态/响应 checker；不采用 solve 写出的分数、返回值或状态。包与数据固定，参考序列自检失败及环境异常为 invalid，
  不能按工具开放顺序执行的上游参考任务显式 unsupported；沿用现有 Run、SDK 与 JSON review，无新增执行路径。
- **GUI 第一阶段**（[BrowserGym/MiniWoB](../examples/bench-adapters/browsergym/README.md)）：外部 Python adapter/runtime，
  固定 BrowserGym 0.14.3 与 MiniWoB commit，五个 CPU 浏览器任务；单容器内完成原版 reset/step/validate。
  external 工厂接收截图、目标、动作错误（bid 模式另有 accessibility tree），返回原版高层动作；empty 为 noop 后停止。
  不新增资源账本或 GUI 状态机。原版奖励在 solve 期间产生；独立 verify 仅检查完整轨迹、奖励与哈希，
  rescore 是保存证据重查，不是原环境重评或动作回放。截图、JSONL、Markdown 复用现有 Trial review。
  策略与环境同进程，面向可信研究代码；无通用 oracle、GPU 策略、桌面/Android 或 GUI 状态恢复。
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
上传时同时限制压缩字节数和解压后的 tar 字节数（含元数据）不超过 `MAX_BUNDLE_BYTES`（2 GiB），
提取出的文件总大小也须通过同一上限的树校验；超限或上传失败会停止解包进程、取消输入流并删除临时目录。
Dockerfile 在仓库内时用快照中的文件（gitignored 文件不在快照中）；本机运行同样如此（以快照为构建上下文，镜像与提交时的代码一致；快照中没有该 Dockerfile 时才用原文件）。Run 记录镜像名（`image`）与启动时的镜像内容 ID（`imageId`，`sha256:…`）。

**数据**：`orbit data add <name> <path>` 在每个节点各自登记同名数据集；mount `{dataset, target}` 在执行
节点解析为本地路径。调度只选登记了全部数据集的节点，从不复制数据。

**镜像同步**：主节点每个周期对未完成的远端 Run 拉取状态、事件（保留原时间）、日志与指标增量
（按本地文件长度续传），并转发待发的取消。worker 上 `queued` 映射为主节点的 `starting`（原因注明）。
worker 返回 404：已确认的 Run 记为 `lost`，未确认的重新排队。产物与文件不复制，通过主节点 API 代理读取，
worker 不可达时返回 502。终态且 worker 已完成清理后同步结束。

**已知限制**：bundle 缓存不自动回收；worker 离线期间其上的镜像 Run 保持原状态，直到它恢复或被
`orbit node rm`（此时记为 `lost`）；worker 重启并重新附着 Run 时镜像日志可能被截断重拉，以 worker 上的
日志为准；提交者会话与 diff 只在主节点。Agent 轨迹摘要随 Run 同步，结束后重建或补建的摘要在主节点读取时更新。

## 9. 跨场景评测规范

目标：让用户在自己的机器上**丝滑地**评测任意 Agent / Policy：bench 足够多、Web 能按场景看懂实验、轨迹形式统一、
资源管理可靠。本节在 [docs/research](research/) 对 12 个 GUI / 具身项目的源码调研基础上修订（`gui-bench/`、`embodied-bench/`）；
Agent 注册表（§6）、独立 Policy 与原生具身评测（§9.4a）、轨迹产物与复盘（§9.9）和产品目录（§9.18）已有实现。其余能力按各小节的状态与 [实现进度](status.md) 查阅。

### 9.0 调研后的修正

| 原规划 | 调研事实 | 修正 |
| --- | --- | --- |
| Harbor 形状"在具身上根本不适用" | Embodied First Exam（EFE）用 Harbor task + 可信仿真 sidecar 承载 35 个 benchmark / 1,154 个任务，评测 coding agent | 错误判断。**workspace + 可信 sidecar** 是"CLI Agent × 交互环境"的主路径，不需要先造新环境协议 |
| 先定义 Orbit 自己的 HTTP+JSON 环境协议 | 已有成熟协议：CUA-Lite `LiteBaseEnv`（GUI，canonical tool call，坐标 `[0,1000]`）、vla-eval WebSocket+MsgPack（policy，sync/live，action chunk）、EFE `eai-standard/2.x` + RCB1 二进制封包、BrowserGym Gymnasium | Orbit 只管生命周期、资源、证据与轨迹索引；**episode 内语义透传原生协议**，按需写桥，不再造轮子 |
| 被评测对象 = Agent | 具身有两类对象：会写代码的 coding agent（EFE）与逐帧出动作的 VLA policy（vla-eval、Isaac Lab-Arena） | Method 增加 **policy**：一个 GPU 模型服务，与仿真共同调度（Arena 的 evaluator + server 同组） |
| 一个个写 adapter 扩充数量 | Hub 已聚合大量 bench：CUA-Lite 18 套、Cua Bench 11、BrowserGym/AgentLab 10–12、vla-eval 20+ 目录、EFE 35、Harbor 80+ | 先接 **hub**，一次得到一族 bench；每条按本机校准如实标注（hub 声称 ≠ 本机验证） |
| valid-only 均值是唯一口径 | vla-eval 把基础设施 error 计入成功率分母；Gym-Anything 的 reward 尺度随 `reward_type` 变化；OSWorld 部分 evaluator 异常转 0 | 同时保存**官方原始指标与官方聚合**和 Orbit 有效性口径，命名区分，不以重算值冒充官方 |
| 环境资源 ≈ 暖池 | 需分层准入（CUA-Lite）、能力探测与创建中预留（Gym-Anything）、setup 前标脏（OSWorld）、设备/后端/任务对象三层复位（MobileWorld）、实际资源对账回收（CUA-Lite reaper）、非幂等 step（CUA-Lite、EFE operation id） | 见 §9.6 |
| — | hub 自带内部并发（shard、Ray、多进程队列、`-n`），与 Orbit 各自扩张会超卖 | 内部并发必须由 Orbit 预算：一个 trial 一个 episode，或 adapter 声明 `slots` 由 Orbit 一次租齐 |
| 统一 Web 一个页面 | 好用的界面各有专长：MobileWorld 可提交/取消/补跑，AgentLab X-Ray 逐步看 DOM/a11y，OSWorld/Gym-Anything 看截图与录像，静态 HTML 导出便于分享；实时 VNC 与历史回放是两件事 | 按场景设计 trial 视图 + 实时画面 + 静态导出（§9.9） |

所有 hub 都有自己的队列或状态库（SQLite、Redis/Postgres、内存 master、结果目录续跑）。**Orbit 是跨 trial 的作业状态、
资源分配与清理的唯一权威**；runner 可以在 Orbit 给定的租约和固定样本清单内维护私有执行记录（如 vla-eval 的 SQLite），
作为产物单向导入，不成为第二个状态源。每个样本的分派与重试由谁负责必须明确，避免双重调度。

本节经过一轮设计审查（R1–R8 及复审，记录见 Git 历史中的 `docs/design-review.md`）后修订。

### 9.1 三层职责

```
Orbit（唯一状态）  资源账本与租约、Run/Trial、排队、节点、清理确认、证据归档、轨迹索引、Web、统计
  │  adapter 协议（现有，§7）
Hub / 原生 runner  episode 循环、环境 reset/step、动作语义、原版 evaluator（CUA-Lite、vla-eval、EFE、BrowserGym…）
  │
Benchmark 语义     任务、初始状态、成功判定、官方指标与聚合规则
```

原则：语义尽量交给原生实现（不重新解释同一个仿真器）；资源与状态只在 Orbit；每个 hub 先以 `native` 方式包装跑通、对齐，
再按需增加工具桥与轨迹转换。Orbit 不自研 Agent 循环；原生具身评测可在容器内使用薄的同步 driver 调用官方环境，
daemon 不参与逐步控制，任务、控制器和成功判定仍由 benchmark 提供（§1、§9.4a）。

### 9.1a 评测身份

| 对象 | 含义 |
| --- | --- |
| Run | 一次资源分配与执行生命周期 |
| 逻辑样本 | task、variant、初始状态、seed 等确定的评测单位 |
| 执行尝试 | 某个样本的一次执行；重试产生新尝试，保留前次证据 |
| slot | 并行容量，不是统计样本 |

默认一个 Trial 对应一个逻辑样本、一个 solve Run。原生具身 adapter 声明固定批次能力后，可通过 `--batch-size` 让多个
Trial 顺序共享一个 solve Run；每个 Trial 仍独立 verify、score 和重评。`trial_runs` 按 Run、Trial、阶段关联，保存 episode
及尝试身份；事件通过 `trialsByRun` 推进全部关联项。批次只有不可变计划，执行状态仍由既有 Run 和 Trial 管理。
轨迹事件带 sample / attempt / source / step 身份；计划数、完成数、有效数注明计数单位。

### 9.2 Bench 家族与接入路径

| 家族 | 规模（上游口径） | 被评测对象 | Orbit 接入 | 关键资源 |
| --- | --- | --- | --- | --- |
| **CUA-Lite** | 18 套：桌面 6（OSWorld、OSWorld-V2、WAA、Cua×3）、浏览器 6（WebArena、VisualWebArena、MiniWoB++、WebVoyager、Online-Mind2Web、WebGym）、移动 4（AndroidWorld、AndroidLab、MobileWorld、MobileGym）、grounding 2 | VLM agent；可桥接 CLI Agent | 其 env-server 作为 service；agent 侧用原生 rollout 或 Orbit 桥 | VM/KVM、AVD、浏览器池、共享网站后端 |
| **Cua Bench** | 3 registry taskset + 8 外部适配 | VLM agent；`--agent harness` 可在环境内跑 CLI Agent | native；结果已含 Harbor 字段 + ATIF，直接导入 | 容器 / VM（gVisor、QEMU） |
| **BrowserGym + AgentLab** | 10 浏览器套件 + OSWorld/GAIA | agent × task × seed | 现有 external adapter 扩展到全套；依赖图交给 Orbit 共享状态组 | 网站后端实例 |
| **OSWorld-V2 / MobileWorld / Gym-Anything** | 各 1 个旗舰 benchmark（108 / 201 / CUAWorld） | VLM agent | native 单任务调用；或经 CUA-Lite 统一 | KVM、快照、后端数据库 |
| **Harbor 生态** | 80+（含 OSWorld-Verified） | CLI Agent | workspace（已有），补 compose 缺口 | 容器、compose sidecar |
| **EFE** | 35 benchmark、1,154 任务、2,260 模式目录 | coding agent | workspace + 可信 GPU sidecar；`standard` / `privileged` / `standard-realtime` 分别登记 | GPU sim service、monitor、named volume |
| **vla-eval harness** | LIBERO、SimplerEnv、CALVIN、ManiSkill2、RoboCasa、RoboTwin、BEHAVIOR-1K… | VLA policy | native（一 trial = 一组 episode）；policy 作为 GPU service | sim 容器 + 模型服务 GPU |
| **Isaac Lab-Arena** | Isaac Lab 生态任务 | VLA policy（OpenPI / GR00T 等） | native 包装 Experiment Runner；不引入 OSMO/K8s | RTX GPU，evaluator + server 两张卡 |
| 科研 / 代码 / 答题 | ASI、LongDS、RCB、HarnessGrad 59 个数据集… | CLI Agent | 现有 native / external；answer kind | CPU 为主 |

"规模"是上游声明的口径（套件数 ≠ 任务数 ≠ 已验证数），Web 与 CLI 显示时必须同时给出本机校准情况（§9.10）。

### 9.2a 专用原生 adapter

AutomationBench uses its native tool agent and an independent original rubric over saved world state;
public and simple splits remain separate. Chartography uses the original no-tools Inspect solver and
an independent native judge; its dummy sample pack is never represented as the released dataset.
Their images pin upstream code/dependencies; read-only runtime wrappers remain external-adapter code.
FrontierSWE/WANDR wrappers reuse Harbor rather than adding an executor: frozen catalogs, task-account
execution, native tar artifact exclusions, oracle-only release flags, native invalid markers and WANDR's
12 metrics. All four routes preserve API/scorer failures as invalid and keep evidence for review.
Separate Harbor verifiers preserve their own GPU model restrictions, including when they reuse the
solve environment. Independent verifier environments do not inherit solver model choices. Shared
verifiers cannot replace their running GPU allocation with a separate environment declaration.
GPU model matching uses whole name tokens in order, allowing form-factor tokens between model and
memory variants (for example A100-SXM4-80GB for A100-80GB); different memory variants remain distinct.
Unavailable originals and exact protocol gaps are recorded in [availability](guides/benchmark-availability.md).

### 9.3 任务形态（kind）

| kind | 适用 | Orbit 负责 | 原生负责 |
| --- | --- | --- | --- |
| `answer` | 题目 → 答案 | 容器、答案收集、oracle/empty | 官方评分函数 / 固定 judge |
| `workspace` | Agent 在容器内工作；**可带可信 sidecar**（仿真器、桌面 VM、网站） | Run + services + after/hooks、GPU/设备、停止顺序、证据 | 任务、sidecar 内在线判定、verifier |
| `session` | 多轮对话、模拟用户 | 按轮驱动、续接、轨迹 | 轮次、评分 |
| `episode` | policy / VLM agent 的 reset-step 循环 | sim service + policy service 共同调度、生命周期、轨迹导入 | 协议（vla-eval、LiteEnv、Gymnasium）与 evaluator |
| `native` | hub runner 整体包装 | 资源预算（含内部 slots）、产物、结果导入 | 全部内层 |

原规划的 `env` 拆成两条：**CLI Agent 驱动交互环境 → `workspace` + sidecar**（EFE 模式）；**policy 驱动 → `episode`**（vla-eval 模式）。

### 9.4 被评测对象：Agent 与 Policy

- **Agent**：已实现的注册表（§6），任意 CLI，含自定义 harness。
- **Policy**：独立于 benchmark 登记的 `PolicyDefinition`（`policies.json`，daemon 唯一写者），固定模型 service、connector、
  语义 profile、checkpoint 与归一化摘要，以及命名权重 dataset。`Method.agent = policy` 通过 `policyRef` 选择定义，提交时保存
  权威快照；benchmark adapter 不解释模型启动参数。已实现 `openpi-ws`、`groot-zmq`、`openvla-ws` 与 `policy-ws`，
  具体语义边界见 §9.4a。policy 为独立 GPU service，与仿真整组准入；仅接受固定镜像，模型 readiness 与
  SDK 身份握手分别检查，权重以命名 dataset 只读挂载。
- **按角色分配**：租约持久化 `main / sim / policy → gpuIds / devices / limits`，满足异构要求（如 sim 需 RTX、policy 需大显存）；
  首阶段同节点原子分配，逐组件核对设备映射，启动失败整组清理，清理确认前保留租约。
- **native 的承载**：`native` 表示保留上游语义，不绑定宿主 process 后端。首个 vla-eval 接入采用：上游仿真镜像作为 Orbit Docker
  main，运行原版 `vla-eval run --no-docker`，Policy 为 Orbit service。adapter 必须完整映射上游 Docker wrapper 原本设置的镜像、
  env、volume、GPU、shm、输出路径，网络寻址变化记为条件偏差。process + services 与"按角色分配的 docker shim"是后续候选，
  须先定义子资源的创建前登记、容量限制、取消后禁止新建、重启对账与清理确认，不能只删除现有校验开放。
- 能力匹配：bench 声明 `requires`（`multiTurn`、`policyProtocol`、`gui`、`obs: rgb|depth|proprio`、`action: joint|ee|chunk`），提交前与
  Agent / Policy 声明比对，不匹配直接拒绝。

### 9.4a 独立 Policy 与原生具身评测

验证结果见任务记录（[Independent policies](tasks/20261105-embodied-eval.md)、[Policy endpoints](tasks/20261106-embodied-endpoints.md)、
[Policy batches](tasks/20261106-embodied-batches.md)、[Policy checks](tasks/20261106-policy-calibration.md)），本节只记录设计决定。

- **入口**：`orbit policy add / ls / rm`、`bench add-file`、`bench run --sample-plan [--batch-size]`、`bench calibrate --policy`
  都走现有 HTTP 控制面。原生路径为 `examples/bench-adapters/embodied` 加容器内 `examples/sdk/orbit_embodied`，不依赖 vla-eval；
  旧 vla-eval 登记保持原行为。
- **源码布局**：原生登记使用公共 `adapter.py`。benchmark 的准备工具和镜像配方按家族放在 `embodied/benchmarks/`，
  模型服务、镜像配方与权重工具放在 `embodied/policies/`。[具身适配器索引](../examples/bench-adapters/embodied/README.md)。
- **语义绑定**：`BenchCapabilities.embodied` 声明评测 profile、观测与动作语义、显式映射及可选的重规划步数。提交时核对
  已声明的重规划步数，并逐项核对单位、frame、相机与动作描述。若一维动作声明了分量顺序，其长度必须与动作维数一致，
  分量名必须唯一。通过后生成不可变 `ResolvedBinding`。
- **Policy 登记**：`PolicyDefinition` 是共享形状（固定镜像、readiness、checkpoint/归一化摘要、命名权重 dataset、随机流声明）；
  各 connector 的必需字段（OFT 的 8 步 LIBERO recipe、GR00T 的执行长度/动作顺序/backbone 摘要）在 `bench/policies.ts` 登记时检查。
  提交时保存权威快照。`gpusOf: main` 允许模型服务共享模拟器已租的 GPU，不另设 role/GPU。
- **样本身份**：`spec.samplePlan` 是带摘要的有序计划；sampleId 由任务、profile、初态资产摘要与索引、环境 seed、模型 seed 和重复
  编号生成。新分支用 sampleRef、禁止 seed，联合契约拒绝混用；旧 seed 作业、报告与 n→n−1 规则不变，新报告为 `orbit-report/2`，
  报告与 Trial 导航按计划顺序列出样本。WidowX 的重置种子为 `environmentSeed + initialStateId`，计划和批次拒绝别名到同一重置的样本。
- **比较条件**：计划摘要与配对共用冻结条件：适配器配置、非秘密环境值、源码、协议、options、逐任务生效资源/timeout，以及固定
  批次的划分。批次划分与条件使用同一生效预算规则（`splitBatches`），共享模型服务与分别启动不会被当作同条件。配对要求相同
  有效样本；Web 对比把后端未配对的任务列为 “No paired result”。新旧作业不直接归并，归并逐样本核对冻结预算。
- **SDK 与证据**：Benchmark adapter、PolicyClient、connector、driver、证据写入分离；SDK 核心只依赖标准库与 NumPy。原生判定与
  Orbit 有效性分开，可选媒体失败不改变分数。证据原子封存，含 contract、binding、初态、逐步动作、请求的动作块、源码包摘要；
  有命名转换（如 LIBERO 夹爪）时同时保存模型原始输出，验证器重算转换。批次 episode 的期限写入 contract，driver 在每次环境
  步之后检查，验证器拒绝越过期限的有效结果。有效失败须到达 horizon 或原生终止（Gym truncation）。证据 v2 起必须带求解实现包。
  重评只读 solve 证据，不启动模型或仿真，验证容器以宿主用户、无网络运行。
- **随机性**：OpenPI/GR00T/OFT 服务没有远端 RNG reset，按 service 作用域声明（JAX key 0 / Torch seed 0），不宣称与参考 runner
  任意 episode 的随机状态等价。
- **Connector**：`openpi-ws`（OpenPI 预处理在客户端）、`groot-zmq`（官方 GR00T 服务，`ioAdapter` 在原生 LIBERO 与 GR00T 输入间
  转换，亦接 SimplerEnv WidowX 七个任务与 Google Robot 六个任务）、`openvla-ws`（官方 OFT 推理在模型端，`libero-oft-native` 是独立评测 recipe）。
  `policy-ws` 把 Binding 选出的观测交给 Policy 服务，由服务负责图像、状态、语言与动作转换，返回 benchmark 控制器使用的动作块。
  握手核对冻结的动作维数、重规划步数、权重和归一化摘要以及随机流约定。
  Google Robot 固定矩形相机、xyzw 状态、单步重规划及原生 sticky gripper，复用 Gym driver。
  SimplerEnv 固定网格可独立登记 RT-1/Octo 的策略终止协议，直接执行 7 维原生动作并另收终止信号，最终一步的原生 done 决定成功。
  原始动作在任何转换前检查数值类型与有限性，拒绝的数组以禁止 pickle 的文件保存，归为 `policy_act`。
- **LIBERO 套件**：Spatial、Object、Goal、Long 共用原生 driver，并各自登记评测配置。π₀.₅ 共用官方多套件权重，GR00T 按
  suite 选择权重，OFT 可选联合权重。OFT 的 `normalizationKey` 随 Policy 冻结并与服务握手核对。[套件说明](guides/libero-suites.md)
  Fast-WAM Spatial 配方单独冻结 MuJoCo 3.3.2、30 步预热和 400 步控制上限。两个推理模式以独立 Policy 登记，复用相同的样本计划。
- **RoboCasa365**：Atomic-Seen 使用原生 PandaOmron Gymnasium 环境。每个样本以 `environmentSeed + initialStateId` 创建首个
  rollout，仿真资产经摘要核对并以只读数据集挂载，临时 XML 写入容器内的链接视图。`robocasa-native` I/O 保留原生 12 维动作，
  以任务聚合并将无效样本计入失败。[接入说明](../examples/bench-adapters/embodied/benchmarks/robocasa365/README.md)
  GR00T N1.5 共用环境 driver，以 RoboCasa 1.0.1 原生 horizon 运行。每 16 步重规划，按动作段末尾的原生成功信号计分。
  OpenPI 和 GR00T 的 recipe 分别登记，GR00T recipe 的统计排除无效样本。
  Diffusion Policy 使用 RoboCasa 1.0.0，向 Policy 端发送两帧原生观测，每 8 步重规划。
  原生奖励任一步为正即计成功，动作段结束时按上游单环境规则决定是否提前停止。
  新证据单独保存原生 `done`，验证器据此重算停止点。旧证据可重评，验证记录会标明停止点未经复核。
  固定任务目录、Lifelong 的阶段及累计套件独立于模型登记，复用每任务的原生步数和判定。
- **原版 RoboCasa**：v0.2 Atomic-24 固定旧版物体资产和 B 划分，在 PandaOmron 上执行 7 维操作臂动作。
  原生控制器接收补齐后的 12 维动作，按任务注册表设置步数上限，原生成功时提前停止。重评核对动作补零和停止点。[接入说明](../examples/bench-adapters/embodied/benchmarks/robocasa-v02/README.md)
- **RLBench**：MT100 的种子场景与 RVT-18 的测试初态独立登记。RVT 保留四路相机、世界坐标点云、原生位姿规划和碰撞标志。
  CoppeliaSim 使用 Xvfb 和 Mesa GLX，每个 episode 启动独立进程以保持相机输出一致。RVT 规划失败保留原生异常类型，计为有效失败。[接入说明](../examples/bench-adapters/embodied/benchmarks/rlbench/README.md)
  原版 RoboCasa 和 RLBench 从固定提交导出构建输入，登记时校验构建清单及入口。
- **RoboTwin 2.0**：`demo_clean` 通过 SAPIEN 运行 Aloha-AgileX，首个任务为 `adjust_bottle`。Benchmark 负责专家筛选、原生重置、
  控制和判分。`robotwin-native` 将三路相机转为 CHW，保留 14 维关节与夹爪语义。社区 π₀.₅ 独立登记，每次预测最多执行
  50 步绝对动作。专家拒绝保留为 `sample_rejected`，批次继续执行后续冻结样本。[接入说明](../examples/bench-adapters/embodied/benchmarks/robotwin/README.md)
  X-VLA 在 Clean 和 Randomized 各使用独立的末端位姿配置，沿用原生场景和专家筛选逻辑。策略输出转换为 16 维原生控制目标，每 30 步重规划。
- **ManiSkill3 与 Meta-World**：两个 RLinf recipe 分别使用原生 SAPIEN WidowX 和 MuJoCo Sawyer 环境。冻结样本种子、观测和控制语义，
  以原生 `info.success` 判定 episode。Meta-World 用同一个 `environmentSeed + initialStateId` 生成 MT1 目标并重置环境。
  Policy 服务分别提供 OFT 和 π₀.₅ 推理。
  ManiSkill3 桌面套件按机器人、观测和原生关节动作语义独立登记，沿用原生任务步数和成功判定。隐藏目标的任务将原生目标坐标声明为策略输入并保存到证据。
- **CALVIN ABC→D**：一个样本对应冻结目录的一条五指令序列。仿真仅在序列开始时重置，原生 oracle 完成一段后，driver 丢弃剩余动作并
  用下一条指令重规划。独立 verifier 从封存的动作证据核对子任务进度、重规划边界和停止条件。主分数为完成的连续子任务数。
  Scene D 的 benchmark 可独立登记，checkpoint 的训练场景属于策略来源。
- **RoboMimic**：从 PH v1.5.1 数据集冻结五个环境的控制器、动作顺序和步数上限。低维与图像模式分别登记，Transport 使用双臂。
  种子重置后恢复初始仿真状态，并按原生成功或终止判分。[接入说明](../examples/bench-adapters/embodied/benchmarks/robomimic/README.md)
- **VIMA-Bench**：独立登记四档官方测试划分，保留图文提示、实例分割和原生抓放动作。变长提示资产使用显式编码字段，
  VIMA 推理由独立 Policy 服务执行，登记时核对其镜像构建清单中的 SDK 文件摘要。证据记录原生动作与终止，供 CPU 重评核对。
  [接入说明](../examples/bench-adapters/embodied/benchmarks/vima-bench/README.md)
- **MolmoSpaces-Bench**：固定官方 MS v1 操作轨道的 episode JSON 和资源，按轨道和 episode 序号选择场景。DROID 关节命令与原生
  `judge_success()` 构成独立的 Policy I/O 和判分契约。[接入说明](../examples/bench-adapters/embodied/benchmarks/molmospaces/README.md)
- **Colosseum V2**：固定 ManiSkill 任务和原生扰动预设，分别声明单臂末端增量与双臂关节位置。执行到原生任务步数上限，分别核对
  过程内是否成功及最后一步成功状态。[接入说明](../examples/bench-adapters/embodied/benchmarks/colosseum-v2/README.md)
- **VLA-Arena**：固定套件、难度、初态及语言和视觉探针。安全协议保存原生逐步代价与最终修正，CPU verifier 复核累计代价和判定。
  [接入说明](../examples/bench-adapters/embodied/benchmarks/vla-arena/README.md)
- **LIBERO-PRO**：固定初版的四套件和五类排行榜扰动。用上游扰动器生成 BDDL，并从同一 BDDL 取得策略指令与原生目标。
  初态用索引选取确定性构造种子，独立保存场景状态摘要。[接入说明](../examples/bench-adapters/embodied/benchmarks/libero-pro/README.md)
- **BiGym 2.0**：按 G1 的躯干俯仰动作和本体状态布局分别登记。按任务冻结 100 个种子、控制步数上限和 50 Hz 原生控制，
  并在 CPU 验证中核对原生终止和跌倒状态。[接入说明](../examples/bench-adapters/embodied/benchmarks/bigym2/README.md)
- **CLIPort**：冻结语言条件测试集的 oracle 合格种子及各样本 reset 后的原生步数上限，转发 RGB-D 和当前子目标。
  16 个吸盘抓放任务与 2 个铲形末端推扫任务分别登记动作契约。推扫只接收两个世界坐标 XY 端点，CPU 验证核对原生命令和样本上限，
  并逐步重算累计奖励。[接入说明](../examples/bench-adapters/embodied/benchmarks/cliport/README.md)
- **RoboDojo 与 RoboLab**：两者沿用原生具身 driver 和独立 Policy，使用各自固定的 Isaac Sim 运行时及只读资产，并要求 RTX GPU。
  RoboDojo 的 `environmentSeed` 选择原生布局分区，`initialStateId` 是分区内按文件数字排序的布局序号，不能相加为新种子。
  目录保留缺布局任务的不可用原因；成功记 1，否则按原生过程分数除以 100，仿真拒绝的布局保留为 `sample_rejected`。
  CPU verifier 核对布局身份、动作计数、终止记录和过程分数。RoboLab 保留 DROID 绝对关节与夹爪控制、双重 reset、
  每任务原生时限以及 `get_env_results` 的终止结果；初始物理异常产生的 Gym 标记不直接算成功。
  两者的源码/资产检查与实际 GPU 任务校准分别记录，接入配置不代表已校准。
  Isaac 启动器只在 Linux 查询到一致的实际 R535.256+ 驱动时，采用 NVIDIA 公布的 Vulkan 版本误报兼容参数，并记录版本与处理原因；
  其他版本或查询失败保留原生驱动检查。该处理不修改主机驱动、原生场景或成功判定。
- **证据封存**：benchmark 可在 `finalize_evidence` 中关闭原生写入器，再计算必需证据摘要；例如 HDF5 的 close 会改变文件，flush 不能替代。
  收尾失败使 episode 无效，保留已有失败原因；视频等可选媒体仍可在封存后结束。取消中的未完成样本不新增封存。
- **固定批次**：`spec.batchSize` 按方法、计划顺序和相同生效预算拆分，成员、attemptId、episodeId 与清单摘要提交时冻结；模型服务
  每 Run 启动一次，逐 episode 重建环境并清空连接器状态。容器 watchdog 为逐 episode 预算之和。已封存且独立验证通过的 episode
  不被后续服务失败、OOM 或取消覆盖；共享文件由 Run 持有，随最后所属作业删除；重试结果采用时旧尝试存入 `Trial.priorAttempts`。
- **取消与重启**：取消停止关联 Run 以及已持久化但尚未关联的 solve。重启时在 RunService 调度前，按启动时仍存活的 solve 快照
  补发已取消作业的停止意图；待处理 Trial 认领自己（或所属批次）的未关联 solve，而不是重复求解，清理确认前保持 cleanup pending。
- **存储**：SQLite 第 7 次迁移让 `trial_runs` 支持多引用。迁移前 `VACUUM INTO` 生成含已提交 WAL 的备份
  `<db>.backups/v<版本>.sqlite`（0600，重试时替换），独立校验完整性与版本后在单事务内迁移，失败回滚并停止启动。
- **接入验收**：端点协议、benchmark 原生语义与模型完整套件成绩分别验证，互不替代。新 benchmark 先核对目录与资产，挑代表任务
  做初始化、控制步、原生判定与正负例；新模型优先复用已校准 benchmark。`bench calibrate --policy --sample-plan --budget` 只接受
  真实模型、2–5 个冻结样本与固定批次，默认 20 分钟、最多 30 分钟，覆盖排队、启动、求解、逐 episode CPU 验证与首次重评。
  预算到期持久记录并取消（含未关联的所属 Run），`calibrationExecutionEndedAt` 冻结评分工作完成时间，预算只到这里；`endedAt`
  在全部所属 Run 清理、租约释放后写入。报告标为 policy 接入，不代表 benchmark 本身已校准。完整统计对照是单独的研究任务。
- **后置**：跨 Run 模型池、共享 verify、通用语义直连、独立进程逐位可复现与完整 suite 统计等价。

### 9.4b 具身 harness benchmark（Agent 评测）

RLE-Bench, EmbodiedCLBench and EmbodiedLab evaluate an Agent together with its harness,
tools and task conditions. They use the existing external adapter protocol and `agentTask`
CLI launch path; they do not register an independent VLA Policy or introduce an Agent loop.
Model selection and credentials remain Method/auth configuration, including Ark Agent Plan.

- **RLE-Bench** delegates planning to the built-in Harbor adapter and retains native task
  instructions, budgets and independent verifier images. Its wrapper preserves the complete
  task catalog. Native infrastructure/scorer failures invalidate evaluation; proven submission
  format or size rejections remain valid failures. Tasks whose submitted code can modify the
  native grader and unsupported Harbor runtime conditions remain explicitly unsupported.
- **EmbodiedCLBench** runs the native graph environment and image-producing MCP tools in a
  private service. One in-context learning trial contains the complete ordered prerequisite
  and target sequence in one CLI session. Basic and zero-shot trials retain their own native
  conditions. Skill-summary evaluation is unsupported until its fresh-session boundary can
  be preserved. An independent verifier replays native action evidence with the native grader.
- **EmbodiedLab** runs Isaac Sim and the native experiment worker in an Orbit-managed GPU
  service. The Agent receives the public T0 robot API, task card and writable submission
  workspace; private instance state and scoring evidence stay inside the service. The
  independent verifier consumes sealed service evidence and the submitted experiment result,
  using the native experiment evaluator. T1's additional services and unreleased T2 are
  explicitly unsupported.

Native images, datasets, instance state and run evidence stay outside the source checkout.
Readiness, execution outcome, cleanup and evaluation validity remain separate. Unusable
model backends and missing or untrustworthy environment evidence are invalid evaluations. Discovery metadata uses §9.17 and
retains per-profile support limits; sampled checks do not establish full-suite parity.
Implementation and validation: [task record](tasks/20261110-embodied-harness-benchmarks.md).

### 9.5 Agent 与环境的桥

| 场景 | 桥 | 依据 |
| --- | --- | --- |
| CLI Agent × GUI（桌面/浏览器/手机） | 容器内 computer-use 工具：CLI 命令 + MCP，动作模式取 CUA-Lite canonical tool call（坐标 `[0,1000]`、computer / mobile 两族、finish 工具），后端连 env-server 或 Cua session | 让 Claude Code、Codex、pi… 直接操作 GUI；观测/动作权限作为实验条件记录 |
| CLI Agent × 机器人仿真 | 沿用 EFE 客户端（`/spec /observe /submit`，RCB1） | coding agent 写控制程序，sidecar 在线判定 |
| Policy × 仿真 | 原生协议直连（vla-eval HELLO/EPISODE_START/OBS/ACTION，sync/live） | Orbit 不在每步路径上，避免延迟 |
| VLM agent × GUI | hub 原生 rollout | 先对齐官方分数 |

已实现的 GUI 桥只有一个 `examples/tools/orbit-gui-service`：服务持有 episode、动作 id 去重、预算、finish 与签名；
backend 只实现 `spec/reset/step/close`。BrowserGym 保留原高层动作语言，CUA-Lite MiniWoB 使用原生 canonical tool call 与截图权限；
WebVoyager / Online-Mind2Web 的 CLI 路径仍明确拒绝。`orbit-computer` 可经 CLI 或 MCP 使用，实际 MCP 工具名来自会话并显示在 review details；
签名证据布局与旧 BrowserGym 重评兼容。服务只连接 Run 内部 gui 网络，模型连接仍由 main 使用。

桥的协议规则（来自 CUA-Lite / EFE）：step 非幂等，不盲目重发。协议支持操作查询（如 EFE `eai-standard/2.4` 的 operation id）时
按 id 查询；不支持时（如 RoboTwin 样例的 2.1）记录"动作结果未知"，终止本次尝试并确认清理；重建实例后以新尝试身份继续，
不续接原 episode，且不额外授予重试次数。容量不足用可重试错误（503 + Retry-After）与真实失败区分。

### 9.6 资源与环境生命周期

0. **兼容清单先行**：接入一个固定版本任务前，先列出它用到的全部能力（容器、网络、卷、设备、监控、restart、变量模板、namespace
   语义），实现范围按清单定；删掉 monitor、放宽网络等改动的运行单独记为偏差，不算原版对齐。
1. **资源契约**：`ServiceSpec` 增加 `gpus`、`gpuMemGB`、`gpuFeatures`（rtx/egl/vulkan）、`devices`（kvm、dri、net/tun）、
   `volumes`（命名缓存卷，如 OSWorld qcow2、仿真资产）、`ipc`/`shmGB`、`stopGraceSec`、`capAdd`；`leaseRequest` 把 service 的 GPU/设备计入。
   compose 翻译补齐 `devices`、`deploy.resources.reservations`、命名卷、`x-gpu-memory-gb`；仍不支持的键继续报 unsupported。
2. **节点能力探测**：doctor/心跳上报 KVM、`/dev/dri`、GPU 型号与 RT core、Android SDK、可用 runtime；placement 只选具备能力的节点（Gym-Anything preflight）。
3. **分层准入**（CUA-Lite）：主机保护（内存、负载、磁盘、swap）→ 租约容量 → 环境内部容量 → 创建/reset 限流（避免同时解包镜像、同时起 32 个 AVD）。
4. **内部并发归 Orbit**：adapter 回复 `slots: n` 与每 slot 资源，Orbit 一次租齐；或一 trial 一 episode。禁止 hub 自行扩张。
5. **环境实例**按所有权分类（CUA-Lite）：`dedicated`（每 trial 独占）、`pooled`（可复位复用）、`singleton`（共享后端，如 WebArena 网站）、
   `remote`（外部托管）。实例是租约资源；**setup 前即标脏**（OSWorld），复位需覆盖设备、后端数据、任务对象三层（MobileWorld），
   复位确认后才释放，失败进 `quarantined`。共享后端用 `shared_state` 组串行或分实例（AgentLab 依赖图）。
6. **对账回收**：周期比对"账本中的实例"与"实际带 Orbit 标签的容器/VM"，处理 tracked-but-gone 与 live-but-untracked；查询失败跳过本轮而非全部释放。
7. **阶段时长**：agent 截止 ≠ 释放。sim finalize、视频渲染、verifier 仍占资源（EFE 样例：agent 30 min，sim collect 最多约 38 min）；租约覆盖整段。
   停止顺序固定：先阻止 agent 继续发动作（quiesce）→ sidecar 在线判定落盘（finalize）→ 再渲染视频（render）→ 再收集与清理（collect）。
8. **结束阶段持久化**：扩展现有 Run 阶段记录，逐阶段保存进度、独立 deadline 与幂等或查询机制；daemon 重启后从记录继续，不重复
   finalize；取消时可跳过 render，但不跳过 finalize 的落盘。服务按依赖顺序停止，而不是现在的并行停止。评分有效性与媒体完整性分别记录。
   验收覆盖 finalize 中重启、取消、丢失 verdict、视频失败。

**P5 核心实现**：`Run.phases` 在原 Run JSON 中保存上述五阶段（默认空数组兼容旧记录），`stopRequested` 保存取消/超时意图；
主命令退出码在收尾前落库，执行时限不会覆盖收尾。每阶段先写状态与绝对 deadline，再执行；Docker I/O 服从阶段剩余预算。
hook、after 与可选 `after.render` 用容器内原子 claim / PID / exit 标记和 watchdog 恢复，不重复执行已完成命令；
取消仍执行 finalize 并采集，只跳过独立 render。原有 hook 内混合的 finalize/视频不可拆分跳过。
服务 hook 单独挂载私有状态目录（目录内部允许镜像用户写入），不会暴露主容器凭据；服务按逆拓扑顺序串行停止，
每步停止结果在 `Run.services` 中保存。重试采集先复制到临时目标再替换，保留 after 前的 solve 快照；
租约直到主容器、服务、网络和卷确认删除才释放。旧 after 文件协议仍能恢复，升级前没有 hook 标记的操作无法追溯防重。

`NodeResources.devices` 探测 KVM、DRI render 节点、TUN、adb 与串口，失败在 detail 中显示而不使整次探测失败；
设备类可扩展，已知 /dev 路径由 probe 提供，随角色租约保存并传给主/服务容器的 `--device`。
`RunSpec.devices` 与 `resources.devices` 二选一；服务设备要求显式且唯一的 role。设备缺失在提交期拒绝，
数量已占用则排队，exclusive 类只给一个 Run；adb 仅代表可用性能力槽位，不声称枚举或转发 Android 硬件。
按 GPU 名称匹配角色 gpuFeatures；EGL/Vulkan/CUDA 只保留声明并提示未验证。整组匹配可重新安排未限定型号的角色，
避免占住其他角色唯一能用的卡；没有 role 的服务 CPU/内存也计入准入。Compose 只翻译 NVIDIA count + capabilities:[gpu]
reservation 与 x-gpu-memory-gb，其他 deploy 设置继续拒绝。带 `x-orbit-role` 的服务独占自己的卡（P4/P5 规则）。
**没有 `x-orbit-role` 的 reservation 按 Compose 单机语义共享**（P6.5 修正：EFE 的 1,294 个 GPU 任务都是这种写法，
Compose 在一台机器上给每个 `count: N` 同样的前 N 张卡）：`main` 有 reservation 时由 main 租用（privileged 模式，
Agent 本身用 GPU）；否则由第一个不在宿主命名空间里的服务租用并成为同名角色（standard 模式的 sim）；其余服务
（如测 GPU 用量的 rcb_monitor）用 `ServiceSpec.gpusOf` 看到同一组卡而不额外租用。组内 count 必须相同；
`x-gpu-memory-gb` 求和作为该卡的最小显存；已折叠到拥有者的预算不再重复累加。直接声明的 `gpusOf` 服务保留自身
`gpuMemGB`，在通用角色规划中加入拥有者；未声明预算的监控服务保持原行为。`main` 另取 `shm_size`（`RunSpec.shmGB`）；服务的列表 `entrypoint`
拆成 Docker 的可执行文件与前置参数。`[environment] gpu_types` 变成拥有该组卡的角色的 `gpuModels`（任一型号，
名称整词顺序匹配），本机没有这些型号时提交即给出原因；登记 `-c gpuTypes=any` 时不限制型号并记为偏差。

**启动看门狗**：镜像拉取与构建（`docker pull` / `docker build`）在启动阶段没有期限，网络或构建代理卡住时 Run 会一直停在
starting，占用启动名额却没有任何进展。现在两者都有 `ORBIT_IMAGE_DEADLINE_MIN`（默认 60 分钟）的期限：到时先 SIGTERM
再 SIGKILL docker 子进程，日志写明原因，Run 以失败结束并给出可读理由（属基础设施，bench 记为 invalid 而不是 0 分）。
构建/拉取的输出仍完整保留在 Run 日志里，便于区分"慢"与"卡住"。

**P7 实现**：第 6 条对账回收在 `runs/reconcile.ts`：daemon 每 10 分钟（`orbit reconcile` 立即）列出带本 home 标签的容器、
网络与卷，只删除其 Run 已结束且清理确认、或 Run 记录已不存在的资源；没有 Run 标签的、仍在被观察的 Run 的一律不动；
任何一个列表失败则整轮跳过。活动租约若其 Run 已结束且清理确认（或已删除）则释放。第 3 条主机保护在租约之前：数据盘
剩余不足 5 GB 时本机不启动新 Run；同时处于 starting 的 Run 超过 `ORBIT_MAX_STARTING`（默认 4）时其余排队并写明原因
（镜像拉取、构建、VM 解包不再同时发生）。多节点放置对设备与 GPU 型号逐角色判定（`remoteBlocker` → `infeasible` 带角色）。
**后置（有具体 hub 需要时再做）**：第 4 条 `slots`（目前没有需要内部并发的 hub）；第 5 条 pooled / singleton 实例账本
（需要新的实例状态机，等 WebArena 共享后端或 OSWorld VM 复用接入时与其一起设计与验收）；高级回放与 LeRobot/ATIF 导出
（统一轨迹导入器更多后）；两台真机验收（无第二台机器）。

### 9.7 结果、有效性与可复现

- `Outcome` 增加 `episode { steps, terminated, truncated, endedBy, successSignal }`、`official { metrics, aggregation }`（原样保存）、
  `failure`（封闭枚举：`env_start`、`env_step`、`reset_failed`、`sample_rejected`、`policy_start`、`policy_act`、`server_unreachable`、`call_watchdog`、
  `resume_failed`、`scorer_error`、`judge_unavailable`、`model_unavailable`、`budget_exceeded`）。执行 / 评测有效性 / 清理三态不变。
- **两个口径**：官方聚合（照 bench 规则，如 vla-eval 把 error 计入分母）与 Orbit 有效口径（valid-only，任务聚类 CI）。Web 并列显示并命名。
  官方聚合在 **job × method** 层计算，不对 native summary 再求平均（两批 1/1 与 1/9 的批次均值 55.6%，episode 成功率 20%）。
- **已实现（P2）**：`Outcome.failure`（封闭枚举，classify 与 adapter 填写）与 `Outcome.episode`；adapter 声明的 `OfficialRule`
  （`errors: exclude|fail`、`unit: sample|task`、`failValue`、`metric`）在提交时存入 `BenchJob.official`，`MethodSummary.official`
  给出官方值、样本数、missing 与 partial；`bench_reports` 表按 `(job, revision)` 追加报告（`buildReport`，`orbit-report/1`），
  在 job 结束、取消、重新评分或归并后、且结果与上一修订不同时写入，旧 job 首次读取时补一份 `backfill`；计划 digest 由
  benchmark、tasks、seeds、methods、options 计算。API `GET /bench/jobs/:id/reports`，CLI `orbit bench report`，Web job 页 Reports。
  原生具身评测已支持固定共享 solve 批次及逐 episode 尝试定位；通用 attempt/retry 的显式计数与自动重试规则仍后置。
- **报告修订**：计划集合（样本清单 + digest）固定，追加任务或 seed 产生新集合版本；报告不可原地覆盖，每版记录采用的
  attempt/result 清单、错误与缺项的分母规则、聚合器版本；补跑产生新修订，旧报告与原始失败保留。只有遵循上游的结果选择、
  重试与缺项规则，才继续称为官方口径。
- **attempts 与 retries 分开**（Cua Bench）：attempt 进入 pass@k 统计；retry 只修复基础设施失败，最多一次且条件完全相同（EFE `SAME`）。
- 完整性：计划数 / 完成数 / 有效数 / `partial`；hub 结果缺项时标 partial，不当全量。
- **指纹**：源码 SHA、任务 digest、镜像 digest（解析后）、协议版本、模式、seed、观测/动作权限、网络、资源、时钟；跨指纹比较给出警告（OSWorld release manifest、EFE `effective_config`）。
- **证据信任级**：每个产物标 `producer`（agent / sidecar / verifier / monitor）、`trust`（trusted / self-reported）、视频来源 `live | render`。

### 9.8 统一轨迹

Agent 侧直接采用 Harbor 的 **ATIF**，不再另建封闭的 `events.jsonl` 事件格式。`contracts/atif.ts`
定义严格的 zod 契约：读取 v1.5–v1.8，转换器写 v1.7，未知版本或未知标准字段报错。
校验连续 step_id、Agent 专属字段、同一步的工具结果引用、嵌入子轨迹 ID 与多模态内容；旧版子轨迹引用兼容其 session_id 语义。
Orbit 扩展放在 `extra.orbit`，包含来源文件摘要、导入器版本、CLI 版本、完整度以及步骤的原生游标、思考类别、环境和检查点引用。
标准规定的 `extra.context_management` 记录压缩边界；原生用量保留在 `metrics.extra`。

**转换边界**：`sessions/codex.ts` 与 `sessions/claude.ts` 提供同步纯转换器，输入原生 JSONL 字符串，
返回 `{ trajectory, media }`；`sessions/atif.ts` 共用 JSONL 解析和媒体抽取，`sessions/index.ts` 保持公开入口。
转换器不读写文件、不启动 Agent、不依赖 Python。`sessions/files.ts` 负责有界文件读取与主会话发现，
`trajectory.ts` 负责文件转换/存储，`projection.ts` 唯一投影 `SessionTranscript`；旧的逐消息原生解析路径已移除。
模型失败判定共用原生读取和 JSONL 解码，仅 CLI 自身的响应/错误事件可作为诊断证据；该诊断也保存在轨迹 provenance 中。
检查点直接读取原生续跑 ID，即使会话尚无消息也不依赖是否能形成 ATIF 步骤。

- Codex 按模型调用合并 message / reasoning / function 或 custom tool call，用 call_id 将结果归回发起步骤。
  重复 token_count 去重，逐次 last_token_usage 求和，原生累计总量保留供核对；compacted 写成压缩边界。
  输入一个 rollout；已标注 ordinal 的子会话跳过复制的父上下文，不自动发现或聚合其他 rollout。未知事件保留并标记截断。
- Claude 沿 uuid / parentUuid / logicalParentUuid 选择活跃分支，同一个 message.id 的分块合并并补齐并行工具结果，用量取最后值。
  压缩记录若指向缺失的历史父消息，保留诊断并标截断，不推测拼接遗失分支。
  prompt_tokens 包含 input、cache read 与 cache creation；主文件 sidechain 和调用者提供的 subagent JSONL 嵌入子轨迹，
  主轨迹合计只覆盖本身的调用。缺失用量不冒充零用量。
- 原生会话始终是真源。加密或签名思考只标记 opaque；轨迹不携带其密文或签名，续跑仍依赖原生文件。
  图片在轨迹内用 `media/` 相对路径，返回独立的 base64 资产或来源文件引用供调用者物化，不内嵌到轨迹正文。
- 完整的 Agent 转换标 `agent-only`，损坏记录、未知事件、缺失工具结果等标 `truncated` 并保留诊断，不静默跳过。
  `complete` 与 `environment-only` 留给组合证据；GUI、Episode、Conversation 保留各自 schema，通过步骤引用对齐，
  高频动作、视频和数组仍用原格式，不进 sqlite。

**Run 持久化**：收集 Agent home 并确认执行资源已移除后，在 cleanup 完成前生成
`<run>/orbit/trajectory/trajectory.json` 和相对 `media/`；摘要写回 Run。原生来源路径相对 `orbit/agent/`，
附来源 hash 和 run/trial/job/task 关联。媒体仅物化内联内容或 Agent home 内的本地文件，不自动下载远程 URL。
读取原生 JSONL 有 256 MiB 总量上限，本地单媒体 32 MiB；拒绝越界、符号链接逃逸和非普通文件。
轨迹字符串经 Run 脱敏器处理后原子替换（0600）；媒体是原始证据，不承诺图片内容脱敏。

`GET /runs/:id/trajectory` 返回 ATIF 或 null；已结束的旧 Run 无文件时按需补建，无可转换 Agent 证据返回 null。
运行中只返回临时预览，不落盘。`POST /runs/:id/trajectory/rebuild` 仅允许终态且清理完成的 Run，
从原生文件重建；前版按 `trajectory.<importer>-v<version>.json` 保留首份，失败不覆盖上一份。
同一个 Run 的生成/重建串行，生成期间禁止删除；转换失败记录 `trajectory_error` 并在读取时提示，
不改变执行结果、分数、有效性或阻止资源释放。worker 生成/持有原始文件，主节点代理 ATIF、媒体和重建请求。
CLI：`orbit trajectory show <run> [--json]`、`orbit trajectory rebuild <runs...> [--json]`。
详细使用见 [轨迹指南](guides/trajectories.md)。

**Token 记账（T3）**：`sessions/tokens.ts` 从 ATIF 生成 `Run.tokens`，在轨迹生成/重建、缓存读取补记及 worker 同步时保存，沿用同一 Run 生命周期。
根轨迹与嵌入子轨迹各计一次，忽略复制上下文和非模型调用。`input` 含缓存读取/写入，`output` 含 reasoning；细分字段不能再加到总量上。
未记录的字段为 null，全部未记录则整项为 null；不把代理缺失用量、缺失前缀或溢出计作 0。
`costUsd` 仅采纳 ATIF 明确记录的费用或 Claude 原生 `cost-state` 中同一 session 的最后一项 `totalCostUSD`；后者已含子会话，不再叠加。不查询价格、不估价。

`orbit show`、Run 概览/对比显示用量；`bench usage`、报告配置汇总和 Bench Compare 按不同 solve Run 合计，包含失败与重试，共享 batch Run 去重，排除 verifier。
报告条目记录当前选用 solve Run 的完整用量，batch 条目可能指向同一 Run，不能直接相加。聚合带 `runs` / `recordedRuns` 覆盖率，只合计有记录的 Run；其中任一 Run 缺失的细分项仍为 null。
计数仅供查看，不参与分数、有效性或置信区间。报告保留不可变修订；旧报告字段可缺省，读取不重写，后续新报告/重评分修订才写入统计。

**后续接入**：T4 对齐环境引用；T5 增加 Harbor / Cua 直通及其他来源。
开发期可用隔离环境中的 Harbor validator 校验输出；它不进入 daemon 或 CI 依赖。

P6 的首个具身导入器 `bench/trajectory.ts` 是纯函数：读取 EFE MetaWorld+ standard/2.1 的 journal、已执行动作矩阵、最终奖励与 render 视频，
产出既有 `EpisodeTrajectory`。Harbor adapter 的 `score` 对 `metaworldplus-*` 任务读取 solve 的 Agent 会话、写 solve 的 `orbit-trajectory.json`
并追加 episode review（按需加载导入器，其他 adapter 调用不受影响）；导入失败只加 issue，不改分数或有效性。
原始 NumPy 数据仍保留；预览抽样保留调用边界，未保存的 proprioception 不补造。新增可选 `completeness`（complete/environment-only/truncated）、
sample 的 `sessionMessageIndexes`（引用同一 Run 会话）和 video 的 `timeMap`（仿真步与 render 帧的精确时间映射），旧索引兼容。会话按调用完成时间关联，GUI 仍按动作 id 精确关联。
Docker root 的 agentTask 通过既有 main 收尾 hook 先把私有 Agent 目录归还 daemon 用户，再运行 adapter hooks，保证会话可读与凭据清理；不改变模拟器评分。

原生 RoboTwin、LIBERO、RoboDojo 和 RoboLab 的 verifier 从已验证的动作与批次记录生成 `EpisodeTrajectory`，索引保存在 Verify 产物中。
`mediaPhase: "solve"` 将相机路径限定在同一 Trial 的 Solve 产物中。`frameBeforeAction` 标记每步画面取自动作前，状态和奖励取自动作后。
动作批次可带 `inferSeconds`。录像以控制步取样，时间轴按录像帧率排列，推理时长使用实际测量值。
除 LIBERO 的固定字段外，动作与状态通道名来自冻结的 Binding profile；没有声明顺序的状态字段不猜测通道。
RoboDojo 录像为 25 FPS，RoboLab 使用冻结配置中的控制频率。索引以紧凑 JSON 写入，按实际 UTF-8 字节数限制在 2 MiB 内；
必要时抽样并标为 `truncated`，保留首尾与最慢动作批次的跳转位置和原始视频时间。原始动作、状态与录像仍完整保留。
Web 对长批次列表显示耗时摘要和最慢批次跳转；抽样后的列表与统计明确标为所显示的记录。

### 9.9 Web：按场景的视图

- **作业中心**（参考 MobileWorld eval-server，但状态来自 daemon）：选 bench 家族 → 任务子集 → Agent/Policy × seed，显示资源预估与
  能力检查；提交、取消、**补跑缺失/无效**、复制配置。
- **Trial 视图**按 kind/profile 选择：
  - GUI：截图帧 + 动作叠加（点击点、拖拽轨迹、输入文本）、a11y/DOM 标签页、Agent 思考并排、视频、终止原因；
  - 具身：多相机同步时间轴、动作/关节曲线、action chunk 边界、实时模式的迟到与 stall 标记、在线判定与证据信任徽章；
  - 文本环境 / 多轮：对话视图；代码：diff 与终端（已有）。
- **实时画面**：运行中的 noVNC / 视频流（只读默认），与历史回放分开。
- **对比与榜单**：同指纹的方法比较、官方与 Orbit 两种口径、校准与条件徽章；跨条件比较给出警告。
- **静态导出**：一个 job 或 trial 导出为自包含 HTML（MobileWorld），用于论文附录、分享和社区传播。

### 9.10 描述一个 benchmark：分类、接入与验证

每个 benchmark 只用三件事描述，不再叠加其他分级或类别：

| 问题 | 概念 | 位置 |
| --- | --- | --- |
| 它是什么 | **六维分类**（领域、任务类型、评测目标、接口与模态、环境与交互条件、评分方式） | §9.17，`contracts/taxonomy.ts` |
| Orbit 怎么接入、怎么执行 | **接入方式**（`harbor`、`manifest`、`sdk`、`native`，见 §9.14）与**执行形态** kind（§9.3），以及具体 adapter 文件 | adapter 的 `capabilities`；产品目录的 `integrations` |
| 验证过什么 | **校准记录**：empty / oracle 的实际结果、重复一致性、清理与重评，绑定作业与时间 | `orbit bench calibrate` 生成的报告（§9.14、§9.15） |

验证只列事实，不分级。当前阶段只要求**校准**，即确认管线接通：empty 得最低分、oracle 得满分（没有参考解时省略）、
重复 seed 一致、清理确认、从保存证据重评分数不变。期望值可由 benchmark 声明（`calibration`）；脚本正例只算校准，
不冒充真实模型。与官方 runner 或官方公布结果的对照（判分逐题对照、真实 Agent 端到端对照）是后续按需对经典 benchmark
人工进行的工作；有结果时作为证据说明记入 `capabilities.parity`，不作为等级。条件改动列入 `deviations`，无法按原条件运行的任务显式 unsupported。

接入新 benchmark 时需要说清（与接入方式无关）：

```text
identity     原始任务来源 + 版本 + 任务/实例 digest；包装改变了考题时，包装本身是 identity
io           输入输出、可见信息、工具与动作权限、结束信号
environment  组件及归属、就绪 / 复位 / 停止 / 清理、隔离范围
resources    按角色的 CPU / 内存 / GPU（型号、显存）/ 磁盘 / 设备 / API 配额 / 时钟预算
scoring      原版 scorer + 版本 + 输入证据 + 指标单位与方向 + 官方聚合与缺项规则
validity     原版错误 → 封闭失败类型；任务失败与设施故障的边界（设施故障不得记 0 分）
trajectory   原生格式 + 统一索引映射 + 完整度 + 产生者与信任级
calibration  empty / oracle / 重复的期望，及其依据
```

**已移除的旧字段**：早期的 C1–C7 接入类别（`capabilities.category` / `profiles` / `kind`）、旧 `domains` 词表、产品目录的
`verification.level` 与登记的 `fidelity` 已从契约中删除。旧 adapter 回复里的这些键被忽略；校准期望只来自 `CALIBRATION_DEFAULTS`
与 benchmark 的 `calibration` 声明（原来按类别给的宽松默认值已写入各 adapter）。数据库迁移把旧类别隐含的期望冻结进已有校准作业，
旧报告结果不变；读取旧登记时，登记标签的 `domains` 按精确对应转为 taxonomy 领域。Harbor 登记的 `-c category` / `profiles`
仍被接受，`category` 只作为条件记录。

### 9.11 具身两阶段

- **第一阶段（仿真）**：EFE（coding agent，workspace + GPU sidecar）与 vla-eval / Arena（policy，episode / native）两条线并行；EFE 先跑 CPU 任务（P3），GPU sidecar 与按角色分配随 Policy 路线（P4）交付。
- **第二阶段（真机）**：设备作为资源类（`robot:<class>`、独占），设备提供者实现 `reserve / health / reset / stop / release`；
  `reset` 支持 `operator_confirmed`；cancel 先 `stop()` 并确认停稳；`operator` 事件入轨迹；校准指纹入结果；控制循环留在设备侧。
  第一阶段 episode 协议与证据结构不变，第二阶段只换"环境提供者"。

### 9.12 不做

不引入 hub 的队列/数据库为第二状态源；不内嵌 OSMO / Kubernetes / Ray 控制面；不移植 Harbor 运行时；不让 daemon 依赖 Python
（hub 在各自隔离环境里跑）；不把 hub 声称的覆盖数当作支持数；不用重算口径冒充官方分数。

### 9.13 路线与验收

按审查 R6 重排：正确性前提（共享实例互斥、标脏、复位确认、dedicated 实例优先）随首次接入交付；最小接入包、版本固定、
依赖检查与 smoke 随第一个新 hub 交付；暖池、多节点、复杂分层准入与公开 catalog 后置。

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 Agent 注册表 | 已完成；bench 契约断点已修复（R1） | §6；codex、claude-code 与容器内安装的 dsh 经真实 bench trial 验证 |
| P2 样本身份与官方聚合 | 已实现：failure / episode、OfficialRule 与官方值、报告修订；attempt/retry 计数与批量 Run 后置 | 契约与统计测试；fixture adapter 真实 job 与重新评分验证 |
| P3 两个小而完整的接入 | 已完成：MiniWoB++ 全量 125；EFE MetaWorld+ standard（compose 卷、restart、偏差登记） | empty 125/125；EFE oracle 1 / empty 0 |
| P4 Policy 路线 | 已完成：`Lease.roles` 按角色分配、service GPU 与 `entrypoint`、vla-eval 适配器（LIBERO 真实任务） | 角色独占卡、整组排队；LIBERO empty 0 分 valid |
| P5 扩大覆盖（核心能力与 GUI hub 适配器已完成；EFE GPU 原版校准、Arena 未做；见 tasks/20261104-p5-core、p5a） | 用已验证模板增加同家族 bench：CUA-Lite、Cua Bench、OSWorld（KVM + 缓存卷）、MobileWorld、EFE GPU 任务、Arena；结束阶段持久化；GUI / 具身 trial 视图 | 新接入主要是配置与少量适配；每家族至少一个任务校准通过 |
| P6 CLI Agent 桥（已完成；见 tasks/20261104-p6-mainline） | 共享 GUI 服务、BrowserGym / CUA-Lite MiniWoB、MCP 接线、模型故障识别、EFE CPU 与统一轨迹 | Claude Code 两个浏览器后端与 EFE CPU 真实检查；Codex 经 MiniWoB 截图/CLI 开发校准启用 GUI；OSWorld 等 KVM 后端后置 |
| P6.5 接入层（§9.14，已完成；见 tasks/20261104-p65-integration） | calibrate / coverage、SDK、manifest 清单、Harbor 能力补全 | EFE 35 套件覆盖报告；新 bench 按接入方式的成本达标；迁移前后校准一致 |
| P7 规模优化（对账回收、主机保护与启动限流、能力路由、[catalog](catalog.md) 已完成；暖池/实例账本、slots、导出、两台真机后置，见 §9.6 P7 实现） | 暖池、pooled/singleton、分层准入、对账回收、多节点能力路由、批量 rollout、高级回放与导出、catalog | 吞吐、恢复、资源对账分别验收；两台真机 |
| P8 真机 | 设备提供者 | 需合作方、设备与安全流程才启动 |

### 9.14 后续改进方向：接入层（2026-11-04 复盘）

benchmark 以原始来源直接登记，hub 只是实现手段（§9.18）；描述 benchmark 的三个概念见 §9.10。

**判断**：§9.1–§9.7 的核心不变——成功判据沿用上游（分数可与官方对比），Orbit 统一执行、资源、有效性、聚合、
可信证据与对比视图。问题在接入层：除 Harbor 格式外，每个 hub 都是手写 adapter（几百到上千行），重复实现镜像固定、
readiness、证据哈希与签名、verify 复核、失败映射与评分回读；接入是否完成靠人工校准判断，大型 hub 的覆盖说不清
（EFE 2,260 个模式目录中只有 MetaWorld+ 一个任务经过 oracle/empty 校准）。

**原则**：跟随 hub 与协议，不逐个追 bench。新 bench 多数先进入某个 hub 或采用已有格式；Orbit 只支持少数事实标准，
不自造协议：任务格式 → Harbor（EFE、Cua Bench、TB 系列）；GUI 交互 → CUA-Lite canonical tool call 与 MCP computer-use；
具身 Policy → 独立语义契约与模型原生 connector（首个为 OpenPI WebSocket，可选 vla-eval-ws）；具身 coding agent → EFE `/spec /observe /submit`。

**接入方式**（新 bench 优先选靠前的方式）：

| 方式 | 适用 | 新 bench 需要做的事 | 目标成本 |
| --- | --- | --- | --- |
| `harbor` | 已是 Harbor 格式，或 hub 可导出 Harbor | `orbit bench add --adapter harbor`；缺的 compose 能力补进核心（惠及整类） | 分钟级 |
| `manifest` | 有镜像、入口命令、结果文件的 bench | `orbit-bench.yaml`：镜像 digest、任务枚举命令、运行命令、角色资源、结果文件与指标解析、上游错误 → `FailureKind` 映射、官方聚合规则；由 Orbit 内置的通用 adapter 执行 | 半天内 |
| `sdk` | 需要交互桥或特殊流程（GUI 环境服务、可信 sidecar） | 基于共享 Python SDK（`orbit_bench`：环境 service 框架、证据签名与复核、失败映射、评分回读、readiness），只写启动环境、reset/step、读结果 | 约 1 天、几十行 |
| `native` | 必须保留上游 runner 或原生仿真协议 | 内置包装（ASI）或原生具身 adapter（`examples/bench-adapters/embodied` + `orbit_embodied`，§9.4a） | 按 benchmark |

所有方式都编译成现有 adapter 协议 1（§7）的四个操作，不新增执行路径；SDK 的签名与证据格式沿用 §7 已实现的规则，
旧 trial 的 rescore 必须保持有效。

**接入的验收与盘点**：

- `orbit bench calibrate <bench> [--sample N] [-t task…]`（已实现，`cli/calibrate.ts`）：抽样任务（按 suite 轮转）
  跑 empty 与 oracle（benchmark 允许时）× 2 seed，逐项判 passed / failed / not_run：全部完成、全部 valid、empty 为 0、
  oracle 满分、重复 seed 一致、清理确认、从保存证据重评分数不变（期望可按 §9.10 由 benchmark 声明）。只用公开 client API，
  作业照常留在 Orbit 里；"已接入"以该报告为准。与原版分数的对照不在当前要求内，需要时人工完成。
- `orbit bench coverage <bench>`（已实现，纯函数 `contracts.benchCoverage`）：按 suite（task 的 `suite` tag，Harbor
  取 `tasks/<suite>/<task>` 目录；否则 id 前缀）统计 supported，原因去掉服务名与变量说明后计数排序。
  supported 只表示能在其条件下运行，不等于已校准，也不表示本机有对应 GPU 型号。

**已实现（P6.5）**：内置 `manifest` 适配器（`bench/manifest.ts`，`orbit-bench.yaml`；结果按路径选取上游写出的值，
`invalid` 规则映射到封闭失败类型；`examples/bench-manifests/vla-eval-libero` 与 Python 版 vla-eval 适配器条件相同）；
Python SDK `examples/sdk/orbit_bench`（协议入口、`valid/invalid`、`pinned`，失败类型由 TS 测试核对一致），
仓库内 9 个 Python 适配器改用它（顺带修复 vla-eval 出错仍以 0 退出）；GUI 共享服务仍在 `examples/tools/orbit-gui-service`。
Harbor 补全：共享 GPU 组、`gpu_types`、main `shm_size`、服务 `entrypoint`。未做：授权数据卷（BEHAVIOR 等，需用户数据目录
登记）、main 的 `cap_drop`/`healthcheck`、跨 bench 汇总视图。

**顺序**（取代 §9.13 中 P6 之后的排序，P7 规模优化在其后）：

1. `calibrate` 与 `coverage`，用它们盘点 EFE 35 个套件，确定 Harbor 能力缺口排名。
2. P6 主线第 1 项（共享 GUI service）扩展为 SDK；现有 6 个 adapter 逐步迁移，迁移前后校准结果一致。
3. manifest 清单与通用 adapter，以 vla-eval 改写为样板。
4. 按 coverage 排名补全 Harbor 能力：allowlist 网络、GPU 共享语义（EFE abc-sim）、`mcp_servers`、多步任务。
5. 跨 bench 汇总视图：各 bench 分数尺度不同，只并列"有效样本数、官方值、Orbit 值、最近校准"，不做跨 bench 平均。

统一 Agent 会话与环境轨迹是 §9.8 所列的后续工作。原生具身 Policy 的抽样校准、短上游对照及其适用范围见
[具身兼容矩阵](guides/embodied-compatibility.md)。

### 9.15 Web：Catalog 与工具和模拟用户对话视图（2026-11-05）

依据 [Web UI 调研](research/web-ui/landscape.md)。原则：结果与证据一起出现；总览是紧凑分组表、逐层展开；对话是主视图、树与原始
JSON 是辅助；"能跑 / 校准通过 / 真实 Agent 或 Policy 跑过 / 与官方对齐"四件事分开显示，不合成一个健康分。

**校准成为一等记录**（取代只在 CLI 内存中判定）：

- 判定逻辑（抽样、方法、期望、`judgeCalibration`）移到无依赖的 `contracts/calibration.ts`，CLI 与 daemon 共用一份。
- `BenchJobSpec.calibration`（可选）：提交时固定 `noOracle` 任务、是否重评。带它的作业就是校准作业；不靠作业名猜测。
- `POST /api/v1/bench/calibrations`：daemon 抽样、建作业；作业结束后若需重评，daemon 自动发起一次（重评前的分数留在 trial
  `history`），全部结束后由 `GET /bench/jobs/:id` 的 `calibration` 字段给出报告（`running` / `rescoring` / `done` + 检查列表）。
  报告按需从 trial 计算，不另建账本。`orbit bench calibrate` 改为调用这个 API，输出不变。
- `GET /api/v1/bench/catalog` 的 `entries[]`：每个已登记 benchmark 一行——登记信息、任务列表摘要（六维分类、supported/listed、按 suite
  的覆盖与原因；daemon 内存缓存、后台刷新，列表失败保留错误和上次成功时间）、最近 5 次校准（离散记录，不画连续健康条）、
  实际评测配置最近一次的主指标与 valid/total（配置版本按 §9.16 区分）。验证按 §9.10 只列事实：最近 5 次校准报告；
  与官方的对照由 adapter 在 `capabilities.parity` 写明证据，未声明显示"未验证"。另有 §9.18 的 `supported[]` 产品目录，与本地登记证据分开。

**工具与模拟用户对话轨迹**：新增 review kind `conversation`，契约 `ConversationTrajectory`（`contracts/trajectory.ts`）：

- 参与者（agent / user / system / tool 环境，带显示名）；按原始用户轮次分组的事件：消息、工具调用（`callId`、调用者、名称、参数、
  结果或错误、`rejected` 表示 scaffold 拒绝的非法调用）；轮次的 `check`（passed / failed / unchecked）与可选 before / after /
  expected 状态；整体 `verdict`（上游 checker 的类型与说明、首次检测到失败的轮次，可为空，不猜）；`producer` / `trust` / `completeness`。
- BFCL 与 τ² 的轨迹由 **verify** 产生（独立重放，可信），原生文件照旧保留。BFCL：重放实际调用与参考调用，逐轮状态；对前缀依次运行原版
  `multi_turn_checker` 得到首个失败轮次，之后的轮次标 `unchecked`。τ²：消息流按 `requestor` 区分 agent 与 user 的工具，终态 DB
  的期望/实际与 action / communicate 检查来自原版 reward；没有逐消息 DB 快照，不画逐轮状态。
- **TextArena 游戏记录**：Harbor 对明确的 `textarena/…` 任务及已识别的原生 game server，在任务 staging 中生成带记录器的副本，
  只读挂入游戏服务；不修改 benchmark 源文件、游戏接口或奖励。服务 stdout 保存初始观测、动作与返回观测，不记录结果接口的 token。
  score 从采集的 `services/game/log` 生成 Solve 产物 `orbit-conversation.json`，声明既有 `conversation` 视图；
  `producer: sidecar`、`completeness: environment-only`，未结束或被截断的记录标为 `truncated`。
  总判定只来自原 verifier reward，不推断每步正确性或 Agent 是否读取了某条观测。导入失败保留原奖励并附 issue；
  原始日志继续可查，预览上限 2 MiB。已有只含启动信息的日志不能还原对局；shared 模式不能 rescore，需重新运行才能记录。
- Web `pages/trial/Conversation.tsx`：轮次目录 / 对话 / 检查器三栏（窄屏单栏）；工具卡片按 `callId` 合并调用与结果，错误与失败相关
  内容默认展开；检查器有 Checker、状态 diff（只看变化字段）、期望 vs 实际、Raw；顶部 verdict 横幅可跳到失败轮次。键位：`h/l` 轮次、
  `/` 搜索、`e` 跳到失败证据。参考调用与实际调用的差异只作诊断，不当作判分规则。
- Trial 页通用：上一 / 下一 trial、下一个失败（按 task / method / seed 排序；`[` `]` `}`）。
- **工具工作流的 CLI Agent 路径**：BFCL 用 adapter 自带的 stdio MCP 服务（`get_user_message` / `list_functions` / `call_function`）
  让 Agent 在一次会话里逐轮完成对话；调用按 fixed driver 的 evidence 格式记录，verify 独立重放，Agent 与服务的输出都不作评分依据。
  这是 Orbit 脚手架，不是榜单的原生 FC 提示，conditions 中声明"不可与榜单直接比较"。任务文件由服务读取后删除，后续轮次不留在
  Agent 可读的磁盘上。模型只经 Agent 工具调用（ARK 等方案不允许脚本直接调用）；τ² 的用户模拟器需要单独的模型来源，暂未运行。

**不做**：跨类别总榜或单一健康分；从 Markdown 复制一份 Web 目录（目录共用 §9.18 的源码数据）；从缺失证据推测成功或补 0；把 Rescore 表述为重跑 Agent。

### 9.16 Web 信息架构：评测配置与结果比较（2026-11-10）

Web 围绕 **Agents**（运行器与已知策略入口）、**Benchmarks**（评测什么）和 **Evaluation configurations**（评测配置）组织；
Evaluations 与 Runs 保存执行记录。评测配置页面从历史评测聚合运行器、模型、思考强度、可选提示词 / skills 包，以及 Policy / external 配置，
按配置名称归组、按内容摘要区分版本。它没有独立登记的 Method 实体，模型或推理预算的变化也不代表方法进化。
Method 的定义与生命周期留待后续设计。[原信息架构调研](research/web-ui/information-architecture.md) 和
[原实现验收](tasks/20261106-web-ia.md) 保留历史名称；当前实现仍复用 registry、Job、Trial、Run 与报告。

**导航**：侧栏默认展开为“图标 + 文字”，可折叠为图标栏，偏好记在本地；窄屏自动折叠。名称与快捷键在悬停或键盘聚焦时可见。

| 组 | 项（快捷键） | 内容 |
| --- | --- | --- |
| — | Overview（`g o`） | 覆盖、Agent、当前执行与配置比较 |
| Evaluate | Benchmarks（`g b`） | Catalog 一级页 |
| | Agents（`g a`） | Agent 定义、能力、凭据与证据 |
| | Configurations（`g m`） | 评测配置版本与结果 |
| | Evaluations（`g e`） | 作业列表、作业、trial、作业对比 |
| Operate | Runs（`g r`）、Resources（`g s`） | 运行与资源；Runs 对比保留原入口 |
| 底部 | Settings（`g p`）、快捷键、主题、连接状态 | Settings 保留凭据配置并链接 Agents |

`/` 是 Overview，Runs 列表在 `/runs`；`/bench` 与 `/compare` 保留；旧 Catalog 地址 `/bench?tab=catalog` 转到 `/benchmarks`。
评测配置入口为 `/configurations`，页面标题为 “Evaluation configurations”；旧 `/methods` 地址保留兼容。界面文字为英文。

**Overview**：顶部展示产品库 benchmark 家族数（按产品 ID 去重）、已登记 Agent 数和评测配置版本数；
“On this node”另列本地登记数、最近一次校准通过的登记数、具有真实 Agent / Policy 运行记录的登记数，不能把产品目录当作本机可运行证据。
六维发现入口（§9.17）按子字段展示代表取值及命中的产品家族数；同一 profile 判断取值，按产品 ID 去重，取值间允许重叠。
点击取值进入 `/benchmarks?dimension=<group>&<field>=<value>`，展开对应维度并筛选；未知与明确空集合仍区分为
“Not annotated”与“None”。保留运行中的作业、排队原因、待复盘失败和同一评测条件下配置版本的配对比较。
即使本地没有登记，仍可浏览已适配产品；本地首次使用步骤为登记 benchmark → 配置凭据 → 校准 → 选兼容组合运行。
读取失败显示错误与重试，避免永久加载。

**Benchmarks**：

- 默认展示 Orbit 已适配的产品目录（§9.18），不依赖本机是否安装、登记或运行过；一个 benchmark 家族只有一张卡。
  本地登记是可切换的独立视图，保留登记级分类编辑、校准与运行入口；运行历史仍在 Evaluations 和 Runs。
- 六维入口与受控词表见 §9.17；页面支持多选分面、可移除筛选和 URL 保存状态，以及卡片、列表和领域 × 任务类型矩阵。
  联合筛选在同一个目录 profile 或本地 task 描述上判断，不能用集合并集制造交叉命中。
  [六维分类任务](tasks/20261109-benchmark-taxonomy.md) · [产品目录修正](tasks/20261109-benchmark-library.md)。
- 产品卡详情展开接入路径、suite/recipe、验收范围和来源。本地详情按六组展示任务分类；未标注与明确空集合分别显示
  “Not annotated” 与 “None”。
- `capabilities.identity`（`id`、`name`、可选 `version`、`variant`）声明 benchmark 身份。Catalog 按 `id` 归并登记；
  无声明时按 adapter 与数据路径派生稳定 ID，不以登记名猜测。标签优先于 adapter 声明，可通过 Web 或 `orbit bench label` 修改。
  `PATCH /benchmarks/:name/labels` 只改变展示标签，不改变执行；重新登记默认保留标签，清空后回退声明。
- 产品目录、variants、registrations 和 tasks 分别计数；多领域的计数之和可大于 benchmark 家族总数。
  聚合 adapter 仍是一个集合身份（如 “CUA-Lite collection”），不把它列出的全部 suite 宣称为已校准独立 benchmark。
  BrowserGym 的 MiniWoB 身份记录任务源码版本，运行框架作为 variant/conditions；vla-eval 的其他 benchmark 类不会冒充 LIBERO。
- 原生对话框编辑登记级六维默认值，具体 task 声明仍优先。CLI 通过 `bench label --taxonomy` 或
  `--taxonomy-file` 设置相同默认值；两种输入互斥。身份、分类与运行条件分开，不能通过改标签改变执行。
- 本地登记视图的 Evidence 筛选与统计仍按登记记录显示抽样校准、真实 Agent / Policy 运行与 parity；页面注明其登记和样本范围，
  不声称当前筛选命中的每道题都经过验证。覆盖视图只表达覆盖，不表达成绩。
  强制刷新只请求一次重列任务，随后轮询缓存进度。

交互参考 [Linear filters](https://linear.app/docs/filters) 的可组合筛选、
[Hugging Face datasets](https://huggingface.co/datasets) 的目录分面，以及
[Geist colors](https://vercel.com/geist/colors) 的中性色层次；沿用 Orbit 的本地数据与现有组件，不引入这些服务。

**Agents**：

- 列出所有注册定义（内置与用户定义），另列作业出现过的 external policy entrypoint。
- 安装方式、本机探测版本、凭据 profile 数与最近测试结果分别显示；能力分为声明、接线、有效 trial 证据三态。
  未接线的 MCP 不显示为已支持；`agent ls` 同样区分。证据链接到有效 trial 或成功凭据测试，不使用硬编码 verified。
- Agent × Benchmark 矩阵复用提交时的 `methods` / `requires` / MCP 检查，并检查凭据类型是否为 Agent 接受。
  历史实跑证据与当前准入分别保留，历史 valid 不掩盖当前 blocked / needs-auth。无 listing 显示 unknown。
  矩阵是登记级准入，不代替逐任务的镜像、设备、资源和 adapter 运行前检查。
- API：保留 `GET /agents`；新增 `GET /agents/catalog`（能力、profile、证据、使用情况）与 `GET /bench/compatibility`。
  本机探测版本不是历史 trial 的实跑版本；尚未记录的历史节点/版本不补造。
- 原生 VLA 策略独立登记在 `PolicyDefinition`，已有 `GET /policies`；当前 Agents 页仍只读取 CLI 定义与历史 external
  entrypoint，尚无原生 Policy 目录。后续可增加 VLA Policies 视图，列模型版本、可用配置与按 suite/recipe 验证的关系；
  不能把历史 external 列表冒充已适配模型目录，也不能把 VLA 模型加入 benchmark 的六维词表。

**Evaluation configurations：评测配置与比较**：

- 作业提交时保存每个配置的 `revision` 与 `basis`：Agent、解析后的模型、effort、凭据类型、提交节点可见的 CLI 版本、
  可选配置包文件内容 digest、Policy 快照摘要，或 external entrypoint / 配置。凭据值不进入摘要；Catalog 也按 revision 区分配置包，
  不再仅按 agent/model/effort 合并。配置包按安装时的解引用行为计算内容与执行位摘要并限制大小。
  同名不同内容为不同配置版本；模型、effort 或 CLI 版本变化也会产生新版本。旧作业按已有字段补算，缺少实际模型、CLI 或 external 运行镜像信息时标 “approximate”。
  摘要不冻结可变镜像标签、安装命令或提交后的配置包，因此不能当作完整运行环境指纹。
- 可选配置来源仍使用兼容字段 `BenchJobSpec.lineage[method] = { parent?, note?, informedBy[] }`，由用户或 Agent 显式填写
  （`orbit bench run --parent … --note … --informed-by …`）。旧作业的 approximate revision 也可作为来源版本；未改变的配置不能引用自身为来源。
  Trial 的 “Adjust configuration” 只复制当前 trial 对应的配置，并保留原任务选择供调整；无效 trial 可用原配置重试。
  这些字段记录配置复用和参考证据，不定义方法谱系。
- 兼容 API `GET /methods?metric=<name>` 返回配置名称下各版本及结果；缺省指标为 benchmark 主指标。结果包含评测条件摘要、任务集摘要、
  指标声明与已有不可变报告修订。条件包含 benchmark 源版本、运行配置、seed 与评分规则；不同条件不自动给出进步 Δ。
  dirty 源码的内容无法由 commit 标识，跨作业不自动比较。主指标存在匹配计划的报告时，从冻结 entries 计算汇总与 Δ；
  其他指标或无报告时用当前 trial，并返回 `reportRevision: null`，不冒充不可变历史。
  同条件的不同版本按配对任务比较，公共任务的资源覆盖必须一致；显式 parent 优先且不静默替换为其他版本；严格任务子集标 “regression subset”。
  Web 按条件与任务集分开趋势，支持指标选择、固定报告链接及退步任务入口；缺少报告或证据时明确保留缺项。
- 重试归并也要求配置 revision 一致，不能把变更过的配置包或 CLI 的结果归入旧版本。
  用户或 Agent 可根据失败证据修复环境后重试，或调整评测配置并比较可比结果；页面不将这些变化称为方法进化。

**不做**：跨 benchmark 总分或总榜；单一 Ready 徽章合并安装、凭据、能力、校准与有效性；按 hub 声称的套件数宣传接入量；
独立 Method 系统或方法进化声明；Web 内的科研编排。

### 9.17 Benchmark 六维分类 v1（2026-11-09）

状态：**词表、共享契约与 Benchmarks 页面已实现并通过本轮验收**。实施与验收见
[分类任务](tasks/20261109-benchmark-taxonomy.md)。本节是六维词表的唯一完整定义；其他文档引用本节。
分类服务于发现任务、理解评测条件与检查覆盖，不建立新的执行路径，不从标签推导 Agent 的实际能力或成绩可比性。

六组分别回答：**属于什么领域、要完成什么任务、想检验什么、通过什么输入和动作交互、处于什么环境和交互条件、依据什么评分**。
它们是六个独立维度，不是六个互斥类别；每个维度有自己的受控取值。页面以六张维度卡展示取值入口，
复合维度按子字段展开。每个具体任务可在有依据时多选；复合组不压成一个混合标签数组。
运行时词条 ID、英文标签与匹配函数统一在 `contracts/taxonomy.ts`，由 `@zjunlp/orbit/taxonomy` 导出；
`BenchTaxonomy` zod 契约在 `contracts/bench.ts`，拒绝词表外的字段和值。

**领域（12，`domains`）**：任务内容所需的知识或业务背景，不是工具、文件格式或交互界面。

| 词条 | 范围 |
| --- | --- |
| 通用知识与日常事务 | 通用事实、常识与日常生活事务；不是未知领域的默认值 |
| 软件工程 | 软件开发、维护、系统与运维工作 |
| 机器学习 | 模型、数据学习方法及其训练评估 |
| 数学与形式系统 | 数学、逻辑、形式证明与形式化规划 |
| 自然科学 | 物理、化学、生物、地球等自然科学 |
| 医疗健康 | 临床、医疗服务、健康与生物医学应用 |
| 金融经济 | 金融、会计、经济与市场分析 |
| 法律与公共事务 | 法律、政策、公共管理与社会公共事务 |
| 商业与办公 | 企业业务、客户服务、行政与办公工作 |
| 媒体与创作 | 文字、图像、音视频等内容与创意工作 |
| 机器人与物理系统 | 机器人、控制、设备及物理系统 |
| 游戏 | 具有规则与目标的游戏或对局 |

领域可以交叉；医疗研究可同时涉及自然科学与医疗健康。`GUI`、对话、数据分析不是领域；工具名、
文件格式、具体行业或学科细分保留为补充标签，不增加 v1 顶层词条。

**任务类型（14，`taskTypes`）**：被要求完成的可观察工作，不列举完成它可能需要的全部认知能力。

| 词条 | 范围 |
| --- | --- |
| 问答 | 回答问题或选择答案 |
| 检索 | 查找、定位与汇集信息 |
| 内容生成 | 生成文字、图像、音视频等内容 |
| 信息加工 | 提取、转换、整理、标注与格式处理 |
| 分析诊断 | 分析数据或现象、解释原因、识别问题 |
| 实现 | 实现代码、算法、系统功能或可执行方案 |
| 修复 | 修复已有代码、配置、产物或系统中的问题 |
| 训练适配 | 训练、微调或适配模型与策略 |
| 优化 | 改善明确的质量、性能、成本或目标函数 |
| 业务办理 | 按约束完成业务、服务或行政流程 |
| 实验与复现 | 设计或执行实验、验证与复现研究结果 |
| 导航 | 在页面、应用或空间中到达目标位置 |
| 操纵 | 操作物体、设备或环境以达到目标状态 |
| 对局 | 在规则环境中参与游戏或对抗、合作对局 |

只标任务实际要求：修复软件不必附加“内容生成”；写代码作为科学分析手段时，不自动把全部任务标为“实现”。
一个任务确实要求多个交付目标时可以多选。

**评测目标（14，`targets`）**：benchmark 声明要检验的能力或质量，须能指向任务设计、官方说明或评分依据。

| 词条 | 范围 |
| --- | --- |
| 知识运用 | 调用与应用相关知识 |
| 推理 | 推导、归纳、计算与解释 |
| 规划 | 分解目标、选择顺序与制定行动方案 |
| 工具使用 | 选择、组合与正确调用工具 |
| 记忆 | 保留、检索和使用先前信息 |
| 感知与定位 | 理解观测并定位对象或目标 |
| 交互与协同 | 澄清、沟通、协调与共同完成目标 |
| 控制 | 将观测与目标转为有效控制行为 |
| 学习与适应 | 从反馈或新条件中学习与调整 |
| 指令遵循 | 遵守任务要求、约束和输出规范 |
| 可靠性与鲁棒性 | 重复执行及扰动条件下的稳定表现 |
| 泛化 | 对未见任务、对象、环境或分布的迁移表现 |
| 安全 | 满足明确安全目标或抵御指定风险 |
| 效率 | 时间、计算、调用次数或成本等资源效率 |

“需要某能力”不等于“该 benchmark 专门测该能力”：长任务不自动标记记忆或规划，有截图不自动证明测了感知定位。
`requires`、Agent 声明能力和 Policy 语义绑定回答能否运行；本组回答评什么。有效 trial 是执行证据，不是能力已达标的证明。
评测目标未核实时保留未知，不以“推理”等泛化标签补齐。

**接口与模态（11 个值）**：观测输入的模态与被测方允许的动作分开；本轮没有单独的输出模态字段。

| 子字段 | 词表 |
| --- | --- |
| 观测模态（5，`modalities`） | 文本、图像、视频、音频、结构化数据与状态 |
| 动作（6，`interfaces`） | 回复或提交答案、文件编辑、终端或代码执行、语义工具调用、GUI 操作、物理或仿真控制 |

代码可作为文本，表格、数组与状态可作为结构化数据；PDF、CSV、JSON 是格式细节，不扩展模态词表。
动作描述评测协议允许被测方使用的接口，不根据已安装工具或一次轨迹中的动作推断完整协议。
MCP 是传输与接线方式；经 MCP 点击网页仍是 GUI 操作。物理动作单位、坐标系、频率与映射沿用 §9.4a 原生 Policy 语义契约，
不由分类重新定义。

**环境与交互条件（15 个值）**：环境、世界来源、反馈和其他参与者分开。

| 子字段 | 词表 |
| --- | --- |
| 环境（6，`platforms`） | 程序或服务环境、浏览器、桌面、移动应用、物理仿真、真实设备 |
| 世界（2，`world`） | 受控、外部实时 |
| 反馈（3，`feedback`） | 无交互反馈、同步分步、实时连续 |
| 其他参与者（4，`participants`） | 模拟用户、真人用户、协作伙伴、竞争对手 |

世界描述任务依赖的状态来源；调用远端模型不使受控任务成为外部实时。受控不意味着确定性或无网络。
固定多轮历史仍可能没有交互反馈；只有后续输入依赖被测方行为时才算交互。参与者按角色声明，
不把评分器、基础设施服务或方法内部子代理自动算作额外被测主体。复位、跨会话状态、控制频率、
用户是否也能操作环境等继续记录在原协议和条件中，不增加 v1 词条。

**评分方式（9 个值）**：评分证据与判定方法分开，多项组成的评分保留其组合。

| 子字段 | 词表 |
| --- | --- |
| 评分证据（4，`scoringEvidence`） | 答案响应、交付物、最终状态、过程轨迹 |
| 判定方法（5，`scoringMethods`） | 规则参考检查、执行测试、模型裁判、人工评审、模型概率统计 |

原生仿真成功条件通常是对最终状态或过程轨迹作规则参考检查；不另增“具身评分”或“环境 reward”类别。
执行了一个评分脚本不等于执行测试：脚本可能调用模型裁判或读取终态。二元/标量是结果形状，
`pass@k`、均值、Elo 等是指标或聚合规则，成对比较是评分协议；继续沿用 `MetricSpec`、`OfficialRule` 与原 scorer 条件。

**Harbor 与启动格式**：Harbor、manifest、SDK 和 BrowserGym 等保留在适配器、格式或运行框架信息中，
不成为六维词条。Harbor 指定任务包装、环境和启动/验证入口；不能从 `tests/test.sh`、`reward.txt`、
Docker 或 CLI Agent 推导任务领域、允许接口与评分方法。若包装改变被测对象、题目或成功判据，
如 EFE 的 coding-agent 任务，则包装后的问题具有独立 benchmark 身份。

| 示例 | 分类重点 |
| --- | --- |
| HumanEval 一次生成 | 软件工程；实现；回复或提交答案；无交互反馈；交付代码由执行测试判定 |
| Harbor 软件修复任务 | 软件工程；修复；文件编辑与终端或代码执行；具体评分仍看 verifier |
| Harbor 科学任务 | 自然科学等任务领域；分析诊断或实验与复现；不因使用终端改成软件工程 |
| Harbor + EFE | 机器人与物理系统；按任务交付或在线控制协议标动作与反馈；与原生 Policy 边界分开 |
| 原生 LIBERO | 机器人与物理系统；操纵；图像/结构化数据与状态、物理或仿真控制；评分依据原生状态/轨迹 |
| GUI 或模拟用户任务 | 领域按具体业务；GUI 操作与模拟用户可以共存，不被主类别排斥 |

以上是归类示例，不证明某适配器已支持全部接口或某 benchmark 已完成校准。

**元数据与筛选规则**：

- 分类单位是具体 task/variant。benchmark 身份的汇总只表达包含哪些任务，不把所有子集标签并集作为每题默认值。
  统一适用的登记/variant 声明可作为默认；task 按字段替换，不能通过自动并集保留错误的父级标签。
- `BenchCapabilities.taxonomy`、`BenchLabels.taxonomy`、`BenchTask.taxonomy` 均可选。生效顺序为 adapter taxonomy
  → 登记 taxonomy → task 的 `tags.domain`（仅精确对应的词）→ task taxonomy；后项按字段覆盖前项。
  字段缺省继承、`null` 明确未知并阻断继承、`[]` 明确空集合，均不扩展受控词表。
- `CatalogEntry.taxonomy` 仅是展示并集；`taxonomyGroups[{taxonomy, taskCount}]` 合并描述相同的任务，供联合筛选使用。
  尚无 listing 时用登记默认值并令 `taskCount: null`；它只表示已声明条件，不证明任务数量或任务覆盖。
- 同一子字段多选为 OR、不同子字段为 AND，必须由同一个 task/variant 同时满足，然后再按 benchmark 身份归并。
  science + 终端的子集与 software + GUI 的子集不能合成 science + GUI 命中。缺少足够细的描述时，
  不把集合分别覆盖的维度宣称为联合覆盖；未知不算已覆盖。
- 本轮校准、真实 Agent / Policy 运行、parity 等仍是登记级证据，保留原任务与协议范围；命中分类不代表筛选任务都经过验证。
  某子集的证据不提升整个集合或另一子集，任务级分类筛选不改写登记级证据统计。
  领域、任务和目标计数是非互斥覆盖数，不相加为 benchmark 总量，不生成跨 benchmark 总分。
- 未声明、明确未知与明确不存在分开；未标注不补猜。词表外内容保留为补充标签，不参与受控词表的覆盖计数。
  v1 不增加难度或凭任务名推导的能力标签。
- benchmark 来源与版本沿用现有身份。作业保留已有 benchmark/capabilities 快照，当前标签修改不重写历史报告；
  本轮未新增逐 task 的完整历史 taxonomy 快照或独立分类修订。分类元数据不进入配置可比性与重试兼容指纹。
  模型、harness、权重与工具配置属于评测配置（兼容类型 `Method`）；Run 记录执行设施，均不由分类代替。
- 旧领域词只迁移有明确语义对应的值：`software`、`machine-learning`、`science`、`games` 同值和 `embodied` → `robotics`；
  `knowledge`、`gui-web`、`data-analysis` 等不猜新字段，也不从旧类别推断任何六维取值（§9.10）。分类不改变准入、Policy binding、校准或评分行为。
- `orbit bench label --taxonomy '<JSON>'` 或 `--taxonomy-file <file>` 替换登记的 taxonomy 部分，保留已有 identity；
  `--clear` 清除全部 labels。HumanEval 与原生 embodied adapter 已声明可核实的协议事实，未指定的评测目标保持未知；
  其他适配器逐步补充，未标注不等于不具备该条件。

**Benchmarks 页面**：六张维度卡分别提供领域、任务类型、评测目标、接口与模态、环境与交互条件、评分方式的取值筛选；
后三组按子字段组织，计数属于具体取值命中的 benchmark 家族，不表示某个维度已完成校准或已被能力覆盖。
默认以 §9.18 产品目录展示已适配 benchmark 家族；本地登记视图保留证据、覆盖、运行入口与条件详情。未知值明确显示。
Harbor 等是接入方式，不是分类。
本轮首页与维度卡调整见 [任务记录](tasks/20261109-benchmark-category-cards.md)。

### 9.18 已适配 benchmark 产品目录（2026-11-09）

Benchmarks 默认回答“Orbit 已经适配了哪些 benchmark，它们分别评测什么”。目录随源码发布，即使本机没有登记或
评测历史也能浏览。目录不是新的运行注册表、安装器或成绩库；现有 daemon 仍是本地状态的唯一写者。
实施与验收记录见 [目录任务](tasks/20261109-benchmark-library.md)，入口索引见 [catalog](catalog.md)。

- 既有 `BenchCatalog` 增加 `supported[]` 产品目录，保留 `entries[]` 本地登记数据。Web 从同一个 HTTP 接口读取，
  CLI 和旧调用方仍可使用登记数据。受控数据按 benchmark 族拆在 `bench/benchmarks/<family>.ts`，由 `bench/benchmarks/index.ts` 汇总，`contracts/bench.ts` 声明
  `SupportedBenchmark`：id/name/description、具名 taxonomyGroups、integrations、verification、suites 与 registrationNames。
- registrationNames 只关联显式身份或代码已知的内置接入、原生语义 profile，不按登记名、文件路径或运行记录猜测。
  CUA-Lite 必须有显式 `cua-lite` 身份，且列出的精确 suite 有 `supported > 0`，才关联 MiniWoB、WebVoyager 或
  Online-Mind2Web 家族；无 listing、未知 suite 或全部 unsupported 不自动关联。
  本地未关联的自定义登记仍在本地视图可用；没有本地登记时产品条目依然存在。
- 一条产品记录代表一个 benchmark 家族；接入框架、启动格式、suite、recipe 和本地登记不重复占主卡片。
  多条接入路径与可核实的任务 profile 放在详情，Harbor、BrowserGym、CUA-Lite、vla-eval 等只解释如何接入。
  包装改变题目或被测对象时保留独立身份，如 EFE coding-agent 任务与原生 Policy benchmark。
- 每个产品条目附一段验证说明（做过哪些校准或检查、范围与来源链接），只列事实（§9.10）；不等于本机资源已准备、
  全部任务可运行、任意模型都兼容或完整套件成绩已与官方等价。不能把本机某次运行证据推广到整个产品家族。
- 六维词表复用 §9.17。每个字段只填源码协议或文档明确支持的值；多个 profile 的展示可以汇总，
  联合筛选和矩阵必须由同一 profile 满足。同字段 OR、不同字段 AND；计数按产品 ID 去重。
- 本地登记、安装和运行证据继续独立呈现。目录的接入说明说明如何准备环境；启动评测仍需要明确选择现有登记，
  目录页不静默创建登记或启动任务。更新本地标签不会修改随版本发布的产品分类。
- VLA 是被测 Policy；LIBERO、SimplerEnv、RoboCasa365 等是 benchmark。具体权重、归一化、服务与控制配置由
  PolicyDefinition 保存，评测配置通过 `policyRef` 选用并冻结快照；一次执行进入 Evaluation/Run。模型和 benchmark 的
  支持关系按 suite/recipe 展示，不能从模型家族名推断任意组合可运行。

原生具身家族与模型组合的详细范围见 [具身兼容矩阵](guides/embodied-compatibility.md)。其中 RoboCasa365 的
GR00T recipe 是 N1.5，LIBERO 与 SimplerEnv 使用 N1.7；矩阵中的真实抽样验证不表示完整套件统计等价。

## 10. 路线

| 阶段 | 目标 | 验收 |
| --- | --- | --- |
| R0 | 清理旧实现、TS 骨架、规则与设计 | `pnpm verify` 通过；`orbit resources` 在本机读出真实 GPU/CPU/内存 |
| R1 | 单机日常科研闭环 | Codex 估算资源并提交 3-seed GPU sweep，排队、`orbit wait`、失败留证据；Web 看到 diff、曲线、日志、会话；Codex 与 Claude Code 都走通 |
| R2 | 认证模块与通知 | login / API key / relay 三类 profile 可用于容器内 Codex、Claude Code；完成/失败通知 |
| R3 | 刷榜 | ASI 原生包装、TB-Science Harbor 格式在同一 Run/租约上运行；配置对比页面；新 bench 接入指南 |
| R4 | 多节点 | 一个 Agent 调度两台机器 8 张 GPU；已实现，仅同机双 daemon 仿真验证（§8） |
| R5 | 任意 Agent + 跨场景评测规范 | Agent 注册表已实现（§6）；P2–P8 见 §9.13 |

## 11. 来自 v0（Python 版）的教训

v0 的代码、文档与任务记录保留在标签 `v0-python-final`。

- 控制权放在 infra（冻结 Task、容器 Planner、研究方案审批）导致流程重、不被使用。Agent 主导，Orbit 只执行和记录。
- 科研与 benchmark 各有一套控制器、租约、存储和结果格式，互相看不见资源。只保留一套。
- 失败路径先抛异常后收集产物，丢失证据；日志按固定块读取可能截断。终态先采集、读到 EOF。
- 评测链异常仍可能被显示为已评分；原生 timeout 标签与真实终止事件不一致。评测有效性必须独立判定并参与汇总。
- ASI 容器内旧版 Codex CLI 导致模型拒绝；harness 版本必须固定并在 doctor 中检查。
- GPU 映射：Docker `--gpus device=<UUID>` 或 CDI `--device nvidia.com/gpu=<UUID>`，启动后核对实际映射与租约一致。
- 文档与流程记录量接近代码量，拖慢迭代。只保留本文、status 与必要的任务记录。
