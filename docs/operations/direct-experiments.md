# 直接运行科研代码与比较实验

状态：Python 渐进重构版本的操作说明；使用前安装包含本次变更的版本。
适用 Linux、本机单管理员、已有 Docker。此路径不调用规划 Agent，也不要求先建立研究方案或编译 Task。
它执行的是已有代码；研究问题、代码和结果解释由你与宿主机 Agent 决定。

## 1. 准备和启动

在仓库根目录完成 `make setup`、`pnpm build`。Docker 用户必须能访问本机 Unix socket；
镜像需已存在、包含 `python3`，且不能声明隐式 volume。普通 CPU 命令无需 Codex 认证。
下面使用已有 `python:3.12-slim`；若本机没有，先自行拉取或构建该镜像。

```sh
export INFRA_STATE="$HOME/.local/state/agent-infra-personal"
uv run --locked agent-infra controller serve \
  --state-dir "$INFRA_STATE" --cpu 1 --memory-gib 2 --port 8766
```

保持终端运行。在另一个终端设置同一个 `INFRA_STATE`，启动页面：

```sh
uv run --locked agent-infra web --state-dir "$INFRA_STATE" --port 8765
```

打开 Web 命令打印的带令牌链接，进入“科研项目”。Controller 与 Web 的状态目录必须一致。
`--cpu` 和 `--memory-gib` 是这个 Controller 所有并行实验的合计授权上限，不是每个容器都各有一份。
不同本机 state-dir 还会经过同一用户的节点资源账本，不能靠多开状态目录重复分配整台主机。

## 2. 提交已有代码

以下例子使用仓库内的确定性 CPU 示例，只验证执行和记录链路，不代表科学实验结论：

```sh
uv run --locked agent-infra run command \
  --state-dir "$INFRA_STATE" \
  --project "$PWD/examples/research/direct-command" \
  --name "learning-rate-0.05" --image python:3.12-slim \
  --cpu 1 --memory-gib 0.25 --timeout 60 \
  --operation-id demo-lr-005 --wait \
  -- python train.py --learning-rate 0.05

uv run --locked agent-infra run command \
  --state-dir "$INFRA_STATE" \
  --project "$PWD/examples/research/direct-command" \
  --name "learning-rate-0.2" --image python:3.12-slim \
  --cpu 1 --memory-gib 0.25 --timeout 60 \
  --operation-id demo-lr-020 --wait \
  -- python train.py --learning-rate 0.2
```

换成自己的 `--project /absolute/research/path` 与 argv 即可。平台会登记已有目录，不往源目录写
`project.yaml` 或研究模板。也可以提前执行：

```sh
uv run --locked agent-infra project attach /absolute/research/path --state-dir "$INFRA_STATE"
```

同一操作 ID 和参数重复提交会返回同一 Run。想执行新一次实验就换操作 ID；不能复用原 ID 偷换代码。
去掉 `--wait` 会立即返回 Run ID，CLI 断开后后台实验继续执行。
`--wait` / `run wait` 的退出码：成功 0、脚本失败使用其 1–125 退出码、超时 124、取消 130，其他失败为 1。
普通提交成功只表示请求已接收，最终结果仍以 Run 为准。

## 3. 文件、数据与资源

- 容器工作目录为 `/workspace`，来自受控代码快照；不会原地修改你的源工作区。
- 源码默认上限 128 MiB、10,000 个纳入文件。Git 工作区尊重忽略规则；数据、权重、认证目录、
  `.env`、`outputs/` 等不纳入代码快照。符号链接会拒绝。检查归档的 `code.json` 了解实际清单。
- 默认收集 `outputs/`。程序可用 `INFRA_OUTPUT` 获得绝对输出目录，`INFRA_METRICS` 获得指标路径。
  需要额外目录时传 `--output outputs --output results`；显式列表替代默认值，保留 `outputs`
  才会一起收集程序写入 `INFRA_OUTPUT` 的文件。
- 数据用 `--mount /absolute/dataset:/inputs/train` 显式只读挂载；代码使用 `/inputs/train`。
  记录保存挂载路径，不宣称外部数据集被版本化；长期可复现需要你提供不可变数据版本。
- 默认不联网。确有需要才传 `--network`。默认不注入宿主机环境变量或认证文件。
- GPU 需要 Controller 的 `--gpu-uuid GPU-...` 白名单，提交时再传同一个 `--gpu-uuid`。
  请求临时被占用的设备会等待；请求超过 Controller 授权会报错。GPU 完整科研执行仍需专项验收。
- 镜像必须先安装依赖；本路径不自动 `pip install` 或生成 Dockerfile。
  既有环境准备流程仍在 `environment` 命令中提供。镜像根文件系统只读，实验结果写入工作区。

## 4. 指标与复盘

程序在 `outputs/metrics.jsonl` 逐行写入有限数值，例如：

```json
{"step": 1, "loss": 0.42, "accuracy": 0.71}
{"step": 2, "loss": 0.31, "accuracy": 0.76}
{"step": 2, "name": "speed", "value": 120, "unit": "items/s"}
```

在项目页选择本次实验和对照实验，可以查看同名、同单位指标曲线、镜像、命令、资源、挂载及代码摘要。
曲线来自完成归档的指标文件，不是实时训练流；实时进展通过已有执行记录和日志查看。
损坏行会提示并跳过；索引不会替代原始文件，也不会改变 ASI 等 benchmark 的官方评分规则。

“用当前代码重跑”会明确提示、创建新 Run、重新快照当前代码、重新解析镜像名，并保留父 Run 引用。
它不是原封不动重放旧快照，也不保证可变数据挂载或镜像 tag 仍指向旧内容。需要精确复现时自行固定版本。
失败、取消、超时仍尝试收集部分结果；清理未确认时保留租约，不能把“进程返回”当成“资源已释放”。

```sh
uv run --locked agent-infra run status RUN_ID --state-dir "$INFRA_STATE"
uv run --locked agent-infra run wait RUN_ID --state-dir "$INFRA_STATE"
uv run --locked agent-infra run cancel RUN_ID --state-dir "$INFRA_STATE"
uv run --locked agent-infra run rerun RUN_ID --state-dir "$INFRA_STATE" --operation-id explicit-rerun-1
```

## 5. 绑定宿主机 Agent 原生会话

在自己的科研目录与 Codex 或 Claude Code 交互后，发现候选并明确绑定：

```sh
uv run --locked agent-infra project session discover /absolute/research/path \
  --provider codex --state-dir "$INFRA_STATE"
uv run --locked agent-infra project session bind /absolute/research/path SESSION_ID \
  --provider codex --state-dir "$INFRA_STATE"
uv run --locked agent-infra project session sync /absolute/research/path SESSION_ID \
  --provider codex --state-dir "$INFRA_STATE"
```

Claude 使用 `--provider claude-code`；从 `CLAUDE_CONFIG_DIR/projects` 或 `~/.claude/projects` 发现。
子 Agent 使用发现结果中的 `父 session UUID:agentId` 身份，必须单独绑定，页面会显示其父会话关系。
Codex 从 `CODEX_HOME` 或 `~/.codex` 发现；原有 `project codex ...` 和 notify 回调仍兼容。

目录只用于候选发现，不自动导入其他项目聊天。`sync` 按游标增量读取，未写完整的最后一行留待下次；
`has_more=true` 时可继续调用。页面只显示已采集部分；Claude 当前需要显式 sync，没有后台文件监听。
它记录可观察到的原生消息、工具与使用量，不是所有宿主机行为的完整审计。
提交命令时可附 `--session-id SESSION_ID --provider codex` 保留运行关联，关联字段本身不会自动授权采集。

宿主机 Agent 也可通过现有项目 MCP 使用 `experiment_run/status/cancel/rerun`；
`artifact_read` 沿用可读文本/分段读取方式，不要求 Agent 自行解 Base64。
可选的结构化研究方案、长期环境、冻结 Task 和 benchmark 命令继续保留。

## 6. 升级和恢复边界

首次升级前停止旧调度进程，完成或取消旧活动租约，再启动新版，避免旧版本继续在独立账本中分配资源。
项目库首次写入升级到 v6；租约库升级到 v2。备份状态后升级，不要直接让旧二进制写新版数据库。
节点账本默认位于 `${XDG_STATE_HOME:-$HOME/.local/state}/agent-infra-node/leases`；
`AGENT_INFRA_NODE_STATE` 可覆盖其父目录。存在未完成命令时不能更换该路径来绕开租约。
该默认域覆盖同一 OS 用户；跨用户/多节点不是此版的调度承诺。

直接命令的独立 supervisor 可以跨 Controller 重启继续运行，新 Controller 先核对持久身份。
原来的冻结 Task / 长期科研环境沿用“重启后中断并清理”策略，不宣称恢复训练进程。
每个 state-dir 的队列按 FIFO，节点共享资源准入；尚不提供跨队列的全局公平性。
索引失败不抹掉产物，也不保留已清理的计算资源。索引可由 `records.metrics.MetricIndex.index`
从授权 ArtifactRef 重建；目前没有额外的命令行重建入口。

验证范围、代码位置与回退说明见 [实现导读](../implementation/python-research-core.md) 和
[任务记录](../changes/20260930-python-research-core-8e12c4.md)。
