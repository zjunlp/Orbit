# 轨迹格式、导出与分叉调研

调研日期：2026-11-12。快照，不维护。服务于 [evolution-plan.md](../../evolution-plan.md) 的 T、X、F 三组工作包。

**方法与可信度。** 主体由 Codex 做网络调研（只读单个文件，未克隆仓库，未运行被调研项目），Orbit 侧再做抽查。
每条结论标注可信度：

- **已核对**：本次在本机实测，或直接读了上游源码 / 规范原文。
- **调研**：只来自 Codex 的调研报告，未独立核对。报告中的功能描述均未实测。
- **推断**：由事实推出的判断。

说明：调研报告原文与下载的上游文件存放在临时目录，已在当天的一次主机重启中丢失；本文按已读内容整理，不是原文件。

## 1. 结论

1. Agent 侧采用 ATIF 作为交换格式，环境侧保留各自的原始记录并通过引用对齐。（推断）
2. 原生会话文件是续跑与分叉的唯一可靠来源；任何统一格式（含 ATIF、OTLP）都有损。（已核对 Harbor 文档的表述；推断）
3. 导出优先 ATIF 与 Chat JSONL，其次 OTLP、LeRobot；公开发布前必须脱敏并区分"可恢复的私有包"与"可发布的数据"。（推断）
4. "从某一步分叉"需要对话前缀与环境快照同时成立。现有开源实现里，联合保存两者的只有少数，且都限定在 turn 或工具边界；
   没有发现能证明"任意步完整环境分叉"的实现。（调研）

## 2. ATIF

来源：`harbor-framework/harbor`（Apache-2.0）`rfcs/0001-trajectory-format.md`，当前 ATIF-v1.8。（已核对）

- 根：`schema_version`、`session_id`、`trajectory_id`、`agent`、`steps`、`notes`、`final_metrics`、`continued_trajectory_ref`、
  `subagent_trajectories`、`extra`。
- 步骤：`step_id`（从 1 连续）、`timestamp`、`source`（system / user / agent）、`message`（字符串或内容块）、`model_name`、
  `reasoning_effort`、`reasoning_content`、`tool_calls[{tool_call_id, function_name, arguments}]`、
  `observation.results[{source_call_id, content, subagent_trajectory_ref}]`、`metrics`、`is_copied_context`、`llm_call_count`、`extra`。
- 计量：`prompt_tokens`（**含**缓存）、`completion_tokens`、`cached_tokens`、`cost_usd`，另可带 token id 与 logprobs。
- 多模态：v1.6 图片（相对路径引用），v1.8 音频。子 Agent 内嵌自 v1.7。上下文压缩约定放在 `step.extra.context_management`。
- 未知顶层字段被拒绝，扩展放 `extra`。（调研）
- Harbor 的 Claude Code、Codex 适配器当前写 **v1.7**（已核对源码）；OpenHands 适配器写 v1.5，Cua Bench 写 v1.8（调研）。
- 参考实现：Pydantic 模型 `src/harbor/models/trajectories/`，校验器 `python -m harbor.utils.trajectory_validator`。（已核对文件存在）

**装载轨迹**（Harbor `docs-mintlify/jobs/loading-trajectories.mdx`，已核对）：`claude-code` 与 `codex` 可以用一条已有轨迹作为新会话的起点。
`.json` 视为 ATIF，由 Harbor 转成目标 Agent 的原生会话文件（`atif_to_native_trajectory`，已核对源码），因此可以跨 Agent；
文档写明可能丢失 Agent 专有细节、系统消息和非文本内容，且不恢复沙箱文件。其他后缀视为原生文件，无损，但只能给同一种 Agent，
文件名必须保持原样。

## 3. 格式对比

除 ATIF、Claude Code、Codex 三行外均为调研。

| 格式 | 粒度 | 环境动作 / 观测 | token / 成本 | 许可 | 对 Orbit 的用途 |
| --- | --- | --- | --- | --- | --- |
| ATIF | 完整步骤 | 工具往返 | 有 / 有 | Apache-2.0 | 交换主格式 |
| OpenTelemetry GenAI | span / event | 工具输入输出 | 有 / 无统一账单 | Apache-2.0 | 导出；语义约定仍为 Development |
| OpenInference | AGENT / LLM / TOOL span | 工具往返 | 有 / 有 | Apache-2.0 | 导出 |
| Inspect EvalLog v2 | sample 与事件 | model / tool / state | 有 / 有 | MIT | 分析导出；`input_tokens` **不含**缓存，与 ATIF 口径不同 |
| SWE-agent `.traj`、mini-swe-agent v2 | thought / action / observation | 有 | 有 / 有 | MIT | 导入 |
| OpenHands SDK | 带 parent 的事件树 | action / observation | 有 / 有 | MIT | 导入 |
| AgentLab / BrowserGym | StepInfo | obs / action / reward | 可选 | Apache-2.0 | 导入 |
| OSWorld | `traj.jsonl` 与截图 | action / reward / info | 未统一 | Apache-2.0 | 导入 |
| LeRobot v3 | 帧 / episode | state / action | 无 | Apache-2.0 | 具身导出 |
| RLDS | episode / step | obs / action / reward | 无 | Apache-2.0 | 具身导出 |
| Claude Code JSONL | 消息与父链（`uuid` / `parentUuid`） | tool_use / tool_result | 有（逐条 `usage`） | 未见公开的磁盘格式承诺 | 导入；真源 |
| Codex rollout | 类型化事件 | 工具往返 | 有（`token_count`） | Apache-2.0，持续变更 | 导入；真源 |
| dsh 会话 v4 | 带序号的事件日志，压缩帧 | 工具往返 | 有 | MIT | 导入 |
| pi 会话 v3 | `id` / `parentId` 树 | 工具往返 | 有 | MIT | 导入 |
| opencode | SQLite 消息与 parts | 工具往返 | 有 | MIT | 导入 |

本机样本核对（只看键名，未读内容）：Codex rollout 的行类型有 `session_meta`、`response_item`、`event_msg`、`turn_context`、`compacted` 等，
`token_count.info` 含 `total_token_usage` 与 `last_token_usage`（`input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、
`output_tokens`、`reasoning_output_tokens`）；Claude Code 的 assistant 消息带 `usage`（`input_tokens`、`cache_creation_input_tokens`、
`cache_read_input_tokens`、`output_tokens`）。

## 4. 现有转换器与查看器

仓库存在、star 数与最近推送日期已于 2026-11-12 经 GitHub API 核对；功能描述为调研。

| 项目 | star | 许可 | 作用 |
| --- | --- | --- | --- |
| [harbor-framework/harbor](https://github.com/harbor-framework/harbor) | 6989 | Apache-2.0 | 约 45 个 Agent 适配器 → ATIF；Web viewer；`harbor-atif2otel`（ATIF → OTLP / OpenInference，图片只留元数据） |
| [letta-ai/trajectory](https://github.com/letta-ai/trajectory) | 291 | Apache-2.0 | Claude / Codex / pi / OpenHands / opencode 等 → 统一 JSONL；内容为字符串，不宜作无损来源 |
| [kenn-io/agentsview](https://github.com/kenn-io/agentsview) | 6431 | MIT | 多种编码 Agent 会话 → 本地检索、统计与 token 用量 |
| [daaain/claude-code-log](https://github.com/daaain/claude-code-log) | 1259 | MIT | Claude Code 会话 → HTML / Markdown |
| ccusage | 约 1.9 万 | MIT | 多家会话 → 费用报表；不是完整转换器 |
| [TransluceAI/docent](https://github.com/TransluceAI/docent) | 148 | 见仓库 | Inspect 等 → AgentRun / Transcript 与分析界面 |
| [neulab/agent-data-protocol](https://github.com/neulab/agent-data-protocol) | 203 | 见仓库 | 多数据集 → ATIF → 训练格式 |
| [Continuum-AI-Corp/OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) | 536 | Apache-2.0 | 记录模型请求、工具与工作区树；replay 与 fork；附一份 trace 规范草案 |
| [agentoptics/rewind](https://github.com/agentoptics/rewind) | 14 | MIT | 代理缓存与工作区打包 → replay / fork；成熟度未验证 |
| Langfuse、Phoenix、LangSmith | — | 各异（Phoenix 为 Elastic-2.0） | 接收 OTLP 的分析平台 |

## 5. 导出目标

均为调研。

| 目标 | 要点 |
| --- | --- |
| 监督微调 Chat JSONL | 每行 `messages`，可带 `tools`；这是 Chat Completions 的训练结构，原始 Responses 条目不能直接用 |
| Anthropic Messages | system 单列；assistant `tool_use`、user `tool_result`；是推理接口格式，不等于公开的训练导入协议 |
| ShareGPT 类 | `conversations[{from, value}]`；方言多，需指明版本 |
| Hugging Face 数据集 | 常见做法是 Parquet，把 messages / steps 存成 JSON 字符串，另列任务、成功与否、模型、成本；有的数据集把观测截断到几千字符，不适合恢复 |
| LeRobot v3 / RLDS | 帧级 Parquet 与分片视频；不是聊天训练格式 |
| OTLP | 适合在线分析；应保留媒体外链与源事件 id，不依赖 span 重建原始会话 |

发布实践（参考一个公开的多 benchmark 轨迹数据集的说明）：凭据、URL 与个人信息脱敏；截图单独检查；图片位置与 SHA-256 清单对齐；
缺失的内容不补造；保留上游许可。加密的思考内容与签名应原样保留在私有包里供续跑，不能当作可读思考用于训练。

## 6. 分叉

### 6.1 对话侧

| Agent | 能力 | 可信度 |
| --- | --- | --- |
| Claude Code 2.1.319 | `--resume`、`--continue`、`--fork-session`（续跑时换新会话 id）、`--session-id` | 已核对（本机帮助） |
| | `--resume-session-at <message id>`：续跑时只保留到该链条目为止，配合 `--resume` 在 print 模式使用；`--rewind-files <user-message-id>`：把文件恢复到该用户消息时的状态。两者未在帮助中列出 | 已核对（本机二进制中的参数定义）；行为未实测 |
| | 文件回退只覆盖被追踪的编辑，Bash 造成的修改、进程与外部副作用不保证恢复 | 调研 |
| codex-cli 0.167.0 | `codex exec resume [SESSION_ID] [PROMPT]`、`codex exec fork <SESSION_ID> [PROMPT]`；帮助中没有截断参数 | 已核对（本机帮助） |
| | app-server `thread/fork` 带 `lastTurnId`（含该 turn，不能是进行中的 turn） | 已核对（本机生成的协议 schema） |
| | `thread/revert` 删除某 turn 起的历史但不还原文件；rollout 可能依赖父记录与索引，直接截单个文件不一定可靠 | 调研 |
| dsh | `SessionStore.fork(source, boundary)`；v4 会话带校验的压缩帧，不是可直接剪的 JSONL | 调研 |
| pi | `branch(id)`、`createBranchedSession(leafId)`；不恢复环境 | 调研 |
| opencode | 分叉边界 `before` / `through` 某条消息 | 调研 |
| OpenHands SDK | `fork(from_event_id=…)`，示例里仍共享工作区 | 调研 |
| LangGraph | 按 checkpoint 重放或改状态后分叉；重放会重新执行节点 | 调研 |
| Inspect | turn 边界保存对话、指定目录与 store，恢复到新容器；默认只保留最近的检查点 | 调研 |

推断：无头评测中一次求解通常只有一个用户 turn，因此"按 turn 分叉"（Codex）切不到中间的工具调用；
要在工具调用边界分叉，需要截断会话文件的副本，或由 ATIF 前缀重建原生会话（Harbor 的做法，有损）。两者都要在本机实测后再定。

### 6.2 环境侧

除第一行外均为调研。

| 方式 | 覆盖 | 限制 |
| --- | --- | --- |
| `docker commit` | 容器可写层与配置 | 无进程内存；**不含挂载卷**；每次提交是完整的可写层差异 |
| CRIU / `docker checkpoint` | 进程与内存 | 实验性；文件系统须另行配套；GPU 仅部分 CUDA 状态可协作保存 |
| btrfs / ZFS 快照 | 目录 / 数据集的写时复制 | 无内存；需要相应的文件系统 |
| E2B、Daytona、Modal、CubeSandbox、Firecracker | 沙箱或微 VM 的文件系统与内存快照 | 各有条件；GPU 沙箱普遍不支持同等的热恢复 |

Orbit 现状（已核对代码）：检查点用 `docker commit` 加 `/orbit` 文件与 Agent home 的拷贝；`/workspace` 与 `/orbit` 是宿主机挂载，不在可写层里。

### 6.3 相关研究

以下论文的存在与标题已经 arXiv API 核对，内容只读过摘要（调研）。

- [2505.00212](https://arxiv.org/abs/2505.00212) Which Agent Causes Task Failures and When?：多 Agent 失败归因基准。
- [2509.13782](https://arxiv.org/abs/2509.13782) Who is Introducing the Failure?：重放加谱分析定位失败。
- [2606.08275](https://arxiv.org/abs/2606.08275) Causal Agent Replay：步骤干预后续跑做反事实归因。
- [2609.33875](https://arxiv.org/abs/2609.33875) Counterfactual Rollout Replay：可分叉环境里采样替代动作，用终局收益差作训练信号。
- [2611.05650](https://arxiv.org/abs/2611.05650) Attributing Agent Failures to Their History Needs an Executed Counterfactual：
  主张报告实测的恢复证据；相同快照与种子仍可能不等价。

## 7. 未核对与待实测

- Claude Code `--resume-session-at` 与 Codex 各种截断方式的实际续跑行为（计划 F0）。
- dsh、pi、opencode 的会话格式细节与分叉接口。
- 步级快照在真实任务上的空间与耗时开销。
- 各云沙箱的快照能力与 GPU 支持（Orbit 目前只用本地 Docker，不依赖这些）。
