<p align="center">
  <img src="assets/orbit-logo.png" alt="Orbit" width="480">
</p>

<h1 align="center">Orbit: Learn and Evolve in Any Environment.</h1>

<p align="center">让 Agent 在实验中行动，在轨迹中学习。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zjunlp/orbit"><img src="https://img.shields.io/npm/v/%40zjunlp%2Forbit" alt="npm version"></a>
  <a href="LICENSE"><img src="docs/assets/license-mit.svg" alt="License: MIT"></a>
  <a href="docs/status.md"><img src="docs/assets/status-development.svg" alt="Status: Early development"></a>
</p>

<p align="center"><a href="#quickstart">快速开始</a> · <a href="#agent-integration">Agent 接入</a> · <a href="#benchmarks">基准评测</a> · <a href="#documentation">文档</a> · <a href="#roadmap">愿景与进展</a> · <a href="https://github.com/zjunlp/Orbit/actions/workflows/ci.yml">CI</a></p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

---

**Orbit 是面向 Agent 的实验基础设施。** 我们的愿景是连接数字与具身实验，让 Agent 在任何环境中运行任务、
收集轨迹，并通过分析行动、结果与失败，持续改进自己的方法与能力。**让每一次实验，成为下一次进化的起点。**

今天，Orbit 为 Codex、Claude Code 等 Agent 提供 Docker 实验执行、资源调度，以及代码、日志、指标、产物和会话的记录与复盘。
Agent 负责规划、分析和迭代，Orbit 提供执行与证据。具身设备与自动化轨迹学习是[后续方向](#roadmap)。

<p align="center"><strong>运行实验 → 收集轨迹 → 分析经验 → 改进方法 → 再次运行</strong></p>

<a id="功能"></a>
<a id="features"></a>

## ✨ 为什么选择 Orbit

| 能力 | 带来的价值 |
| --- | --- |
| 🧪 **可复现的执行** | Docker 隔离、代码快照与资源限制，让实验有据可查。[运行与 Sweep](#usage) |
| ⚙️ **统一资源调度** | 按需分配 GPU、CPU 和内存，考虑外部占用，排队时说明原因。[多机运行](#several-machines) |
| 🧭 **轨迹与复盘** | 关联 Agent 会话、代码 diff、日志、指标、产物和笔记，支持分析与下一轮迭代。[Web 界面](#web-ui) |
| 🤖 **接入已有 Agent** | Codex、Claude Code、dsh、pi 共享实验 skills；Codex / Claude Code 也可在容器内运行。[Agent 接入](#agent-integration) |
| 📊 **可验证的评测** | 任务 × 方法 × 种子，执行状态与评分有效性分开；支持 Harbor 格式、ASI 与外部适配器。[基准评测](#benchmarks) |
| 📱 **随时了解进度** | 本地 Web、飞书结果卡片与只读查询，以及钉钉、企业微信、Slack 和 webhook 通知。[通知设置](#notifications) |

<a id="quickstart"></a>

## 🚀 快速开始

<a id="环境要求"></a>

**准备环境：** Linux、Node.js 24.18+（24.x）、Git，以及当前用户无需 `sudo` 即可使用的 Docker。
GPU 实验还需要 NVIDIA 驱动和 NVIDIA Container Toolkit 或 CDI；CPU 实验不需要 GPU。

<a id="安装"></a>

### 1. 安装 Orbit

通过 [npm](https://www.npmjs.com/package/@zjunlp/orbit) 安装：

```bash
npm install -g @zjunlp/orbit
orbit doctor
```

包内已包含 CLI、daemon、Web 和共享 skills，无需克隆源码或自行构建。
不想全局安装时，也可以用 `npx -y @zjunlp/orbit@latest doctor` 试用。

<details>
<summary><strong>更新 Orbit</strong></summary>

```bash
npm install -g @zjunlp/orbit@latest
orbit daemon --stop
orbit doctor
```

停止旧 daemon 后，下一条命令会启动新版 daemon；运行中的容器会被重新接管。

</details>

<details>
<summary><strong>从源码构建并安装</strong></summary>

需要 pnpm 10，适合安装尚未发布到 npm 的改动：

```bash
git clone https://github.com/zjunlp/Orbit.git
cd Orbit
corepack enable
pnpm install --frozen-lockfile
pnpm pack:release
orbit_version=$(node -p 'require("./packages/orbit/package.json").version')
npm install -g "./dist/zjunlp-orbit-${orbit_version}.tgz"
orbit doctor
```

`pack:release` 会构建 CLI、daemon、Web 和共享 skills。仅从源码使用或参与开发，见[开发与贡献](#development)。

</details>

<a id="初次使用"></a>

### 2. 运行第一个实验

```bash
cd ~/my-project                 # 你的 Git 仓库
orbit resources                 # 查看可用资源与队列
orbit run --image python:3.12-slim --cpus 1 --mem 1 -n hello -w -- python -c 'print("hello from orbit")'
orbit ps -a                     # 查看运行记录
orbit web --open                # 在浏览器中复盘
```

`--` 前是 Orbit 选项，后面是实验命令。默认在 `/workspace` 中执行，使用当前 Git 仓库的快照，包含未提交、未忽略的文件。
第一条需要 daemon 的命令会自动启动它；默认只监听 `127.0.0.1:7717`，端口被占用时自动换空闲端口。
状态保存在 `~/.orbit`，大型实验产物可以[放到独立数据目录](#configuration)。

### 3. 让 Agent 使用 Orbit

接入下方的 skills 后，可以这样交代任务：

> 用 Orbit 跑这组实验：先检查资源，再运行多个 seed，对比指标和失败原因，把结论记录到对应 Run 的笔记中。

<a id="agent-接入"></a>
<a id="agent-integration"></a>

## 🤖 Agent 接入

安装对应 Agent CLI 后，选择宿主插件：

```bash
# 选择你的 Agent
orbit plugin install claude
orbit plugin install codex
orbit plugin install dsh --profile headless
orbit plugin install pi
```

重启 Agent 后加载 `orbit` 和 `orbit-bench`。前者用于实验执行与复盘，后者用于 benchmark 适配、资源配置与验证。

| Agent | 宿主 skills | 容器内运行与会话采集 |
| --- | --- | --- |
| Codex / Claude Code | ✅ | ✅ |
| dsh / pi | ✅ | 尚未实现 |

插件的本地安装、npm 安装、更新和卸载见[插件指南](plugin/README.md)。dsh 需要 pnpm 和带 skills 服务的显式 profile。
Agent 需要允许访问本地 daemon；MCP 接口尚未实现。

<details>
<summary><strong>容器内 Agent 与凭据配置</strong></summary>

Run 可以在容器内执行 Codex 或 Claude Code（用于 Agent 实验和刷榜）。Orbit 挂载宿主机上安装的 CLI，
并按 profile 注入凭据：

```bash
orbit auth add codex --harness codex --kind login     # 在私有目录中执行 `codex login --device-auth`
orbit auth add gpt --harness codex --kind api-key --key-env OPENAI_API_KEY
orbit auth add claude --harness claude-code --kind login --key-stdin    # 粘贴 `claude setup-token` 生成的 token
orbit auth add relay --harness claude-code --kind relay --base-url https://relay.example --key-env RELAY_KEY
orbit auth add claude --harness claude-code --kind relay --from-env    # 从环境变量 / Claude 设置读取 key、URL、模型
orbit auth list
orbit auth test claude          # 提交一个真实的小 Run：Agent 必须正确回答
orbit run --auth claude --image python:3.12-slim -- claude -p --dangerously-skip-permissions "…"
```

密钥只从 stdin、环境变量或文件读取，不经过命令行参数。profile 保存在 `~/.orbit/auth.json`（权限 0600），
Run 日志中的密钥会被脱敏。Agent 需要访问 `127.0.0.1` 上的代理时，给 profile 加 `--host-network`。

</details>

<a id="使用说明"></a>
<a id="usage"></a>

## 🧪 运行与复盘

```bash
orbit run --image pytorch/pytorch:latest --gpus 1 --mem 32 -n baseline -- python train.py
orbit sweep --image python:3.12-slim --gpus 1 -g lr -p lr=1e-4,3e-4 -p seed=1,2,3 \
  -- python train.py --lr {lr} --seed {seed}
orbit wait -g lr
orbit show <id>
orbit logs <id> -f
orbit note <id> "与基线对比后，再决定下一轮配置。"
```

命令中的 `{key}` 会替换为各个参数值；上面的 Sweep 提交 6 个 Run，按可用资源排队执行。大多数命令支持 `--json`，便于 Agent 和脚本读取。

<details>
<summary><strong>展开完整运行参考：路径、资源、Sweep 与记录管理</strong></summary>

### 容器内约定

| 路径 / 变量 | 含义 |
| --- | --- |
| `/workspace` | 代码的可写副本（原仓库不受影响） |
| `$ORBIT_OUTPUT`（`/orbit/output`） | 结果写到这里，会被保留并在 Web 中展示 |
| `$ORBIT_METRICS`（`/orbit/metrics.jsonl`） | 每行一个 JSON，如 `{"step": 10, "loss": 0.3}`，Web 中画曲线 |
| `$ORBIT_RUN_ID` | 当前 Run ID |

容器内只能看到租到的 GPU。默认以宿主用户的 `uid:gid` 运行，产物文件归你所有（`--root` 以 root 运行）。

### 运行

```bash
orbit run --image pytorch/pytorch:latest --gpus 1 --mem 32 -n baseline -- python train.py
orbit run --dockerfile docker/Dockerfile --gpus 2 --gpu-mem 40 -- python train.py   # 构建镜像
orbit run --gpus 1 --timeout 120 -w --image ... -- python eval.py   # 等待结束；退出码即结果
```

常用选项：

| 选项 | 含义 |
| --- | --- |
| `--image` / `--dockerfile` | 使用的镜像，或要构建的 Dockerfile（构建上下文为其所在目录） |
| `--gpus`、`--gpu-mem <GB>`、`--gpu-ids` | GPU 数量、每卡最小显存、指定 GPU |
| `--cpus`（默认 4）、`--mem <GB>`（默认 16） | CPU 与内存上限 |
| `-n`、`-g`、`-t KEY=VALUE` | 名称、分组、标签 |
| `-m src:dst[:rw]`、`-d name[:dst[:rw]]` | 挂载宿主路径或已登记的数据集（默认只读） |
| `-e KEY=VALUE` | 环境变量（随 Run 保存，不要放密钥） |
| `--pass-env VAR` | 从 daemon 环境传入变量（用于密钥，值不保存） |
| `--project <dir>`、`--no-project`、`--no-snapshot` | 指定仓库、不使用仓库、只读挂载而不复制 |
| `--no-network`、`--host-network` | 禁用网络，或使用宿主网络 |
| `--timeout <min>` | 超时后停止 |
| `--node <name>` | 指定节点（多机） |
| `-w`、`--json` | 等待结果；输出 JSON |

### Sweep

```bash
orbit sweep --image python:3.12-slim --gpus 1 -g lr -p lr=1e-4,3e-4 -p seed=1,2,3 \
  -- python train.py --lr {lr} --seed {seed}
orbit wait -g lr                # 等整组结束；有失败则退出码为 1
```

命令中的 `{key}` 被替换为每个取值；上例提交 2 × 3 = 6 个 Run，按资源情况排队执行。

### 跟踪与复盘

```bash
orbit ps                        # 活动的 Run；排队的 Run 会显示原因
orbit ps -a -g lr               # 某个分组的全部 Run
orbit show <id>                 # 详情与最新指标
orbit logs <id> -f              # 跟随日志（--tail BYTES 从末尾附近开始）
orbit wait <id>...              # 等待指定 Run
orbit cancel <id>...
orbit rm <id>... | -g <group>   # 永久删除已结束的 Run（需输入 id 或组名确认）
orbit note <id> "lr 3e-4 在 2k 步后发散"   # 记录结论（- 表示从 stdin 读取）
orbit web <id> --open           # 在 Web 中打开该 Run
```

大多数命令支持 `--json`，便于脚本和 Agent 使用。

</details>

<a id="web-界面"></a>
<a id="web-ui"></a>

### 在 Web 中查看轨迹

`orbit web` 打印一个带 daemon token 的 URL，浏览器打开后以 cookie 登录。页面包括：Run 列表（筛选、
分组、多选）、Run 详情（概览、可搜索的日志、指标曲线、产物预览、代码 diff、Agent 会话）、对比
（多个 Run 的指标）、资源（GPU、租约、队列、worker 节点）、刷榜 job 与对比、设置（doctor、凭据与
通知配置）。按 `?` 查看快捷键。

daemon 只监听 `127.0.0.1`。从其他机器查看时用 SSH 隧道：
`ssh -L 7717:127.0.0.1:7717 gpu-server`，然后在本地打开打印出的 URL（daemon 不在 7717 时，用 `orbit web`
打印的 URL 里的端口）。

个人实验笔记、成绩和运行产物保留在用户侧。源码仓库中的 `docs/` 用于通用功能与开发文档。

<a id="刷榜"></a>
<a id="benchmarks"></a>

## 📊 基准评测

在相同资源规则下比较方法，分别保留执行结果、评分有效性与清理状态。只有有效分数计入统计。

| 接入方式 | 适用场景 | 文档 |
| --- | --- | --- |
| **Harbor 格式** | [TB-Science](https://github.com/harbor-framework/terminal-bench-science)、Terminal-Bench 及其他 Harbor 数据集；具体支持范围由 `bench tasks` 列出 | [适配指南](docs/guides/bench-adapter.md) |
| **ASI 原生包装** | 通过 ASI 自身 runner 执行，启动前检查已知兼容性问题 | [版本兼容](docs/guides/bench-adapter.md#asi-bench-版本兼容) |
| **外部适配器** | 用 JSON 协议接入其他 benchmark，无需重建 Orbit | [ResearchClawBench 示例](examples/bench-adapters/researchclawbench/README.md) |

```bash
orbit bench add tbs ../terminal-bench-science --adapter harbor
orbit bench tasks tbs
orbit bench run tbs -t symbolic-regression -m oracle -m empty -n smoke
orbit bench show <job>
orbit bench compare <job>...
```

<details>
<summary><strong>展开评测参考：Agent 方法、任务资源与兼容性</strong></summary>

```bash
orbit bench add tbs ../terminal-bench-science --adapter harbor
# 发布在 Harbor Hub 上的数据集：用 Harbor 自己的 CLI 下载，再登记目录
harbor download terminal-bench/terminal-bench@latest -o ~/datasets
orbit bench add tb ~/datasets/terminal-bench --adapter harbor
orbit bench add asi ../ASI-Bench --adapter asi -c python=/path/to/venv/bin/python --pass-env JUDGE_KEY
orbit bench add rcb ../ResearchClawBench --adapter ./examples/bench-adapters/researchclawbench/adapter.py \
  --pass-env OPENAI_API_KEY --pass-env OPENAI_BASE_URL
orbit bench tasks tbs           # 任务列表，以及不支持的任务的原因
orbit bench run tbs -t symbolic-regression -m oracle -m empty \
  -m gpt=codex,auth=gpt,model=gpt-5,effort=high --seeds 3 -n first-try
orbit bench jobs
orbit bench show <job>
orbit bench compare <job>...    # 按任务对比；paired 均值只用所有方法都有效的任务
orbit bench usage <job>...      # 每个任务实测的内存 / CPU / 显存峰值与建议资源
orbit bench cancel <job>
orbit bench rm-job <job>        # 删除已结束的 job 及其 trial 和 Run（需输入 job id 确认）
```

方法格式为 `name=agent[,auth=P,model=M,effort=E,bundle=DIR]`，agent 可为 `codex`、`claude-code`、
`oracle`（参考解）或 `empty`（不提交任何内容，用于检查 verifier 给 0 分）。每个 trial 分别记录执行结果
（solve Run 如何结束）、评测有效性（`valid` / `invalid` / `unknown`）与清理状态；只有有效分数计入统计。
Web 的 **Bench** 页面展示 job、任务 × 方法矩阵和跨 job 对比。`--pass-env` 传入的评审密钥只给 verify
Run。每个任务的 solve 资源（GPU、内存、CPU、超时）可由 `orbit bench add --resources` 指定的 JSON 文件给出；
每个 Run 都记录实测峰值，solve 因内存不足被杀时该 trial 记为 invalid，而不是 0 分。其他 benchmark 只需一个说小型 JSON 协议的适配器可执行文件，不用重新构建 Orbit，见
[docs/guides/bench-adapter.md](docs/guides/bench-adapter.md)。

ASI 的 Agent 运行需要完整源码 checkout，支持 `--fail-on-agent-error` 且已修复沙箱超时判定。
Orbit 在启动 Agent 前检查所选 Codex/Claude adapter；发现把后台超时警告当成执行失败的已知旧版逻辑时，
明确提示升级。需要更新的是**注册的 ASI 源码目录**（包括冻结快照），仅升级 Orbit 不能修复该目录里的代码。
原生 attempt 状态与评分 valid 分开显示，见 [ASI 版本兼容](docs/guides/bench-adapter.md#asi-bench-版本兼容)。

</details>

<a id="多机"></a>
<a id="several-machines"></a>

## 🌐 多机运行

每台机器都运行 Orbit。Agent 所在的机器（主节点）把 Run 放到已加入的 worker 上，优先使用本机资源。

```bash
# 在 worker 上（例如 Tailscale 地址 100.64.0.12）；防火墙需允许主节点访问 7718
orbit node expose --listen 100.64.0.12:7718
orbit node token                                # 复制打印出的 token
# 在主节点上：会提示输入 token（粘贴，不回显，回车结束）
orbit node add http://100.64.0.12:7718
orbit node ls
orbit data add imagenet /data/imagenet          # 在每台有这份数据的机器上执行
orbit run -d imagenet --gpus 1 --image pytorch/pytorch -- python train.py
```

代码快照按内容哈希只传一次；数据集从不复制；日志与指标同步到主节点；产物留在 worker，经主节点读取。
集群协议是带 token 的明文 HTTP：请使用 Tailscale、内网或 SSH 隧道，不要暴露到公网。
详见 [docs/guides/multi-node.md](docs/guides/multi-node.md)。

<a id="通知"></a>
<a id="notifications"></a>

## 📱 通知与手机查看

用 `orbit feishu init` 扫码创建飞书机器人，接收带指标曲线的结果卡片，并用 `/gpu`、`/runs`、`/show <id>` 查询状态。
也支持飞书 webhook、钉钉、企业微信、Slack 和通用 webhook。

<details>
<summary><strong>设置通知与飞书机器人</strong></summary>

```bash
orbit notify add team --kind feishu --url-env FEISHU_HOOK --on failed,group
orbit notify test team
orbit notify list
```

类型：`feishu`、`dingtalk`、`wecom`、`slack`、`webhook`。事件：`succeeded`、`failed`、`group`（分组
全部结束时发一条汇总）。失败消息附带原因和日志最后几行。

### 飞书机器人


```bash
orbit feishu init phone       # 终端打印二维码：用手机飞书扫码并确认
```

扫码会新建一个飞书应用（机器人能力、消息权限、接收消息事件已预填），并自动与扫码人配对，之后：

- Run 或分组结束时，机器人发来结果卡片：状态、资源与实测峰值、指标曲线（如 loss），失败时附日志尾。
- 随时私聊机器人（群里需 @ 它）：`/gpu` 看每张卡的显存、利用率和占用者，以及 CPU、内存、队列；`/runs` 看最近的
  Run；`/show <run id>` 看某个 Run 的卡片。命令都是只读的。

daemon 主动向飞书建立长连接，不需要公网地址，daemon 仍只监听本机。若 `init` 提示长连接或测试卡片失败，按它
给出的后台页面修改（订阅方式选「长连接」、开通权限、发布版本），再运行 `orbit feishu check phone` 重连并测试。

- 可以绑定多个机器人（名字不同即可），但同一个应用只能绑一次，也不要绑到两台机器的 daemon 上（飞书每个事件
  只投递给其中一条连接）。同时配对多个机器人会收到重复的通知。
- 已有的应用：`orbit notify add phone --kind feishu-app --app-id cli_… --secret-stdin`。其他人私聊机器人会收到
  配对码，在本机运行它回复的 `orbit notify pair phone <code>` 后才能使用；未配对的人看不到任何数据。
- `orbit notify list` 查看配对人数和连接状态，`orbit notify rm phone` 删除。

</details>

<a id="配置与文件"></a>
<a id="configuration"></a>

## ⚙️ 配置与数据

<details>
<summary><strong>目录、端口、节点与数据管理</strong></summary>

| 项 | 默认值 | 覆盖方式 |
| --- | --- | --- |
| 状态目录（数据库、profile、配置） | `~/.orbit` | `ORBIT_HOME` |
| 数据目录（Run 目录、bench staging、代码 bundle） | 同状态目录 | `orbit config data <dir>` 或 `ORBIT_DATA` |
| daemon 端口（`127.0.0.1`） | 7717，被占用时换空闲端口 | `ORBIT_PORT` 或 `orbit daemon --port`（此时端口被占用直接报错） |
| 节点名 | 主机名 | `ORBIT_NODE` |
| Orbit 可用的 GPU | 全部 | `ORBIT_GPUS=0,1` |
| daemon 地址与 token | `~/.orbit/daemon.json`（0600） | |

Run 数据可能达到数百 GB。系统盘小的机器，在第一次运行前把它放到大盘：`orbit config data /data/$USER/orbit && orbit daemon --stop`。
`orbit doctor` 会在数据目录或 Docker 数据目录位于系统盘或空间不足时提示。文件夹用于整理 Run 与 bench job，不移动文件：
`orbit run --folder rcb/noskills`、`orbit mv <id...> rcb/archive`、`orbit folders`；需要实体副本时 `orbit export rcb /path/to/copy`。

daemon 是 Orbit 状态的唯一写者；CLI、Web 和 Agent 都通过它的本地 HTTP API 访问。`orbit daemon --stop`
停止 daemon，运行中的容器继续执行，daemon 重启后重新接管。`orbit daemon` 在前台运行。

</details>

<a id="roadmap"></a>

## 🧭 愿景与进展

| 方向 | 当前进展 |
| --- | --- |
| **数字实验** | 已实现 Docker 执行、资源调度、Sweep、轨迹记录与本地 Web 复盘；单机流程已验证。 |
| **基准评测与多机** | 已实现；benchmark 验证以 oracle / empty 为主，多机目前完成同机双 daemon 验证。 |
| **具身实验环境** | 愿景方向：把执行与资源抽象扩展到仿真、机器人和实验设备；设备后端尚未实现。 |
| **从轨迹中学习与进化** | 已支持记录与复盘，由 Agent 分析并调整下一轮实验；自动化学习、策略更新与评测反馈闭环属于后续研究方向。 |

Orbit 目前处于早期开发阶段（0.1.1）。已验证范围、限制和近期工作以[项目状态](docs/status.md)为准，架构见[设计文档](docs/design.md)。

<a id="documentation"></a>

## 📚 文档导航

| 你想做什么 | 从这里开始 |
| --- | --- |
| 接入 Agent 与更新插件 | [插件指南](plugin/README.md) |
| 适配 benchmark、配置任务资源 | [Benchmark 适配指南](docs/guides/bench-adapter.md) |
| 运行与复盘具身评测 | [快速开始](docs/guides/embodied-quickstart.md) · [Benchmark 覆盖与模型实测](docs/guides/embodied-compatibility.md) |
| 接入具身 Policy 或原生 benchmark | [接入模板](docs/guides/embodied-onboarding.md) |
| 连接多台机器 | [多节点指南](docs/guides/multi-node.md) |
| 理解架构与当前支持范围 | [设计](docs/design.md) · [项目状态](docs/status.md) · [文档地图](docs/README.md) |
| 构建与发布安装包 | [发布指南](docs/guides/releasing.md) |
| 演示 Orbit | [离线演示稿](docs/ppt/README.md) |

<a id="常见问题"></a>
<a id="troubleshooting"></a>

## 🔧 常见问题

| 现象 | 检查 |
| --- | --- |
| `orbit doctor` 报 docker 错误 | Docker 在运行，且当前用户不加 sudo 能执行 `docker ps` |
| GPU Run 无法启动 | `nvidia-smi` 正常；已安装 NVIDIA Container Toolkit 或 CDI spec |
| Run 一直 `queued` | `orbit ps` 会显示原因（GPU 被占用、CPU 被其他进程占满、内存不足、指定节点离线等） |
| Agent 连不上 Orbit | `orbit` 在其 `PATH` 上；Codex 沙箱已允许网络 |
| 快照过大 | 把数据和权重加入 `.gitignore`，用 `-m` 或 `orbit data` 挂载 |
| Run 写 `$ORBIT_OUTPUT` / `$ORBIT_METRICS` 报权限错误 | Docker 启用了 `userns-remap`，见[规避方法](docs/guides/docker-userns-remap.md) |

<a id="开发"></a>
<a id="development"></a>

## 🛠️ 开发与贡献

需要 pnpm 10（`corepack enable`）。包验证与发布见[发布指南](docs/guides/releasing.md)。

```bash
git clone https://github.com/zjunlp/Orbit.git
cd Orbit
pnpm install
pnpm build
pnpm orbit doctor
pnpm --filter @zjunlp/orbit-web dev   # Vite 开发服务器；/api 代理到 daemon
pnpm orbit <args>                     # 从源码运行 CLI
pnpm verify                           # lint + 类型检查 + 模块边界 + 测试 + 构建
```

```
packages/orbit/   `@zjunlp/orbit` 包（CLI `orbit`、daemon、各模块）
packages/web/     Web 界面（React + Vite，由 daemon 提供）
assets/           项目共享的 Logo 与图标
plugin/           给 Codex / Claude Code 的 Orbit skill
scripts/          仓库检查（模块边界）
docs/             design.md、status.md、tasks/、guides/、ppt/
```

贡献者与编程 Agent 请先阅读 [AGENTS.md](AGENTS.md)。

欢迎通过 [Issue](https://github.com/zjunlp/Orbit/issues) 提交可复现的问题、适配需求与改进建议。

<a id="致谢"></a>
<a id="acknowledgements"></a>

## 🤝 致谢

Orbit 的 `harbor` 适配器读取由 Terminal-Bench 团队的 [Harbor](https://github.com/harbor-framework/harbor)（Apache-2.0）
定义的任务格式；它是独立实现，不是 Harbor 官方运行器，也未获其作者背书。只有经过对照的部分，Orbit 的分数才与
Harbor 的可比；对照情况见 `docs/tasks/`。

<a id="许可"></a>
<a id="license"></a>

## 📄 许可

Orbit 原创源码采用 [MIT](LICENSE) 许可，© 2026 ZJUNLP。
随包分发的第三方依赖保留各自许可，详见[第三方许可说明](THIRD_PARTY_NOTICES.md)。
[演示稿](docs/ppt/README.md#来源与许可)沿用 AGPL-3.0，其中的第三方素材分别遵循其原有许可。
