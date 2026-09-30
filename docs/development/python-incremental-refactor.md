# Python 版渐进重构执行方案

状态：实施中。基线为 `main@920ee1d`；保护标签 `pre-python-refactor-20260929` 已建立。
实现记录见 [重构任务](../changes/20260930-python-research-core-8e12c4.md)。
以下阶段是目标与验收条件，完成状态以任务记录为准。

## 1. 这次重构解决什么

把现有 Python 版整理为一个更直接的科研执行工具：宿主机 Agent 负责研究规划、编写代码和分析，
Infra 负责资源准入、容器执行、可靠记录和结果复盘。保留现有 ASI 等 benchmark 原生执行能力。

日常实验应能从已有代码目录直接提交，不必先创建研究方案、确认版本、编译 Task 或启动另一个规划 Agent。
已有规划、冻结 Task 和有界迭代仍作为可选流程使用，不能在替代路径通过验收前删除。

与另一个 worktree 的 TypeScript 重写共享产品目标和验收用例，但本路线保留 Python、现有命令名、
独立 benchmark 适配包及历史数据兼容性；不把两个不同实现的目录改动直接合并。

## 2. Claude 审阅提供的启发及核实结果

用户给出的 JSONL 实际是一份 Claude 子 Agent 的只读架构审阅记录，共 81 条外层记录，
不是完整主会话。以下判断已重新对照当前源码，不把审阅中的旧结论直接当作事实。

| 事项 | 当前证据 | 重构决策 |
| --- | --- | --- |
| 科研与 benchmark 准入分开 | `bootstrap/controller.py` 组装 `LocalResourceManager`；`bootstrap/benchmark_execution.py` 组装 `PersistentLeaseStore` | 收敛为同一节点资源账本，保留不同执行后端 |
| 简单命令已有基础 | `runs/research.py`、`environments/job_api.py` 已支持长期环境及后台 Job | 复用这些执行能力，提供更短的实验入口，不再实现另一套 Docker 管理器 |
| Claude 宿主机会话未对齐 | `agents/codex_rollout.py`、`projects/codex_sessions.py`、`bootstrap/codex_capture.py` 专用于 Codex | 抽取通用发现、绑定、增量采集流程，并接入 Claude 格式 |
| 历史数据分布多个根目录 | Controller、benchmark 及登记批次各有 Records 根 | 先统一查询与新写入入口，再显式迁移旧数据，不能直接移动数据库 |
| 科研缺少一等指标序列 | Records 现有表以事件、流和产物为主，研究分析可引用指标，但没有通用时序指标索引 | 在原始指标文件之上建立可重建索引，用于曲线与比较 |
| 日志 EOF 问题并非处处存在 | `runs/research_evidence.py:poll` 已在终态继续读取剩余块 | 保留现有正确实现，针对其他路径和异常终态补证据测试 |
| 运行导航已有修复 | `6d143fd` 已把科研运行详情归到项目导航 | 不重复修复；保留当前导航和视觉改进 |
| Legacy 不是都能直接删 | `records/legacy.py` 仅有兼容导出和测试引用；`records/catalog.py` 仍被 Web 项目绑定使用 | 前者核对兼容边界后退役；后者先迁移读取与绑定，不能直接删除 |

审阅中关于文档、代码和提交数量的统计只代表它当时的快照。本次不据此修改 AGENTS/CLAUDE 或降低检查要求。

## 3. 保留现有模块，收敛职责

```text
宿主机 Codex / Claude Code
             │ CLI / MCP / Web 请求
             ▼
       Controller（本机写入与执行协调）
             │
             ├── projects       工作目录、实验关联、可选研究方案
             ├── runs           提交、排队、恢复、取消、收集、重跑
             ├── resources      节点探测、持久租约、GPU UUID 分配
             ├── environments   Docker 与原生进程的执行后端
             ├── agents         CLI 版本、认证、容器启动、原生会话格式
             ├── records        事件、日志、代码快照、指标、产物
             └── benchmarks     原生协议适配、评测解释、官方汇总
                                      │
                             独立 adapters/* 包
```

`bootstrap` 仍负责组装，`gateways` 仍只做协议转换。不为这些概念再建立一套平行的 manager、
executor、数据库或 DTO；先扩展对应模块的公共接口。

“同一个 Run”指共享执行事实、资源准入和证据语义，不要求所有 benchmark 都必须拆成一求解一评分两个 Run。
ASI、Harbor trial、PAST family、PostTrain 原生 job 保留自身协议要求的执行单元。

## 4. 实施顺序与验收

### R0：保护基线与建立回归参照

1. 为上述精确 main 提交创建 annotated tag：`pre-python-refactor-20260929`。
2. 在独立 worktree 建立 `refactor/python-research-core` 分支；不修改 TS worktree。
3. 建立任务记录，运行现有必要检查，记录原有失败与环境限制。
4. 建立行为参照：科研 Job、冻结 Task、ASI/TB 原生适配、历史批次页面、宿主机 Codex 采集。

验收：标签指向正确 SHA；任务分支隔离；基线检查结果可复查。
已有 `v0-python-final` 指向更早提交，不能代替此次 main 快照。

### R1：共同执行契约与直接实验入口

主要位置：`runs/control_api.py`、`runs/controller.py`、`runs/control_store.py`、
`runs/research.py`、`environments/job_api.py`、`gateways/cli`、`gateways/mcp`、`bootstrap/controller.py`。

- 在现有提交服务上增加简单命令请求：项目目录、镜像、argv、CPU/内存/GPU、数据挂载、输出、时限。
- 使用 argv 数组，不隐式套 shell；工作目录采用受控代码副本，数据用显式只读挂载。
- 同一个操作 ID 重复提交返回同一 Run；显式重跑产生新 Run 并记录父 Run。
- 对简单实验自动完成准备、执行、归档和释放；长期交互环境仍支持多个顺序 Job。
- 保留现有状态的兼容映射，区分执行结局、证据完整性、清理状态和评测状态。
- 规划与 Task 编译作为上层调用者，不能继续成为简单实验的前置条件。

验收：不创建研究方案也能提交一个已有 Python 脚本；重复请求不重复启动；客户端断开后仍能查询；
错误、取消及超时保留已生成证据；旧科研入口仍可用。

命令形态示意，尚未实现：

```sh
agent-infra run command --project /path/to/research --image python:3.12-slim \
  --cpu 1 --memory-gib 2 --timeout 300 -- python code/train.py --seed 1
```

### R2：同一节点共用持久队列与租约

主要位置：`resources/api.py`、`resources/local.py`、`resources/persistent.py`、
`runs/controller.py`、`runs/benchmark_execution.py`、对应 bootstrap 组装。

- 从现有持久租约扩展设备身份和观测，不另写第二个持久资源系统。
- 科研、冻结 Task、benchmark 使用同一节点资源域；不同批次 state-dir 不能各自把整台主机算成可用。
- CPU/内存容量、GPU UUID、外部占用和观测新鲜度由同一准入规则处理。
- 暂时资源不足排队；超出授权总容量或指定不存在设备直接报可解释错误。
- 本机资源与远程原生调度资源分域，HTCondor 等远端任务不能误占本机 GPU 账本。
- 原生 job/container ID 与 owner epoch 持久化；重启先对账，不因进程 PID 存在就推断归属。
- 清理未确认保留租约；确认清理且证据状态已落库后完成终结。
- GPU 显存观测仅用于准入，不宣称是显存硬隔离；不重复扣除已被本平台租约覆盖的占用。

验收：科研和 benchmark 同时提交不超配；GPU UUID 不重复租出；等待任务可取消；
调度器重启不重复执行；旧 owner 不能释放新 owner 租约；清理失败不误释放资源。

### R3：统一证据查询、快照和指标

主要位置：`records/api.py`、`records/local.py`、`runs/query.py`、`runs/research_evidence.py`、
`bootstrap/benchmark_workspace.py` 及已有文件/产物接口。

- 新提交使用同一 Records 服务；历史 Controller/benchmark/批次根目录通过显式登记的只读来源访问。
- 查询身份包含来源与 Run ID，不能假设不同数据库里的 ID 永远不冲突。
- 保存代码 HEAD、暂存和未暂存差异、纳入快照的未跟踪文件清单、内容摘要；没有 Git 时标明来源未知。
- 快照排除数据、权重、认证文件和生成产物；拒绝越界链接；不能因忽略规则变化偷偷遗漏输入。
- 指标文件作为原始证据保存，索引只作派生视图，支持重复导入幂等与损坏行提示。
- 失败和取消也归档已生成结果；先终止写入/冻结输出、持久化证据，再删除会丢失数据的容器状态。
  现有宿主机持久工作区可继续在停容器后收集，不机械套用“cleanup 前后”的函数名称。
- 大文件保留流式读取/存储引用；文本继续返回可读内容，不能退回默认 Base64。

验收：历史 ASI 批次及 first-study 仍能读取；代码快照可解释输入；长日志末尾不丢；
失败实验的部分产物可见；指标重复导入不翻倍；记录迁移不覆盖历史结论。

### R4：统一宿主机 Session，补 Claude Code

主要位置：`agents/codex_rollout.py`、`bootstrap/codex_capture.py`、
`projects/codex_sessions.py`、项目数据库迁移、Records 事件映射。

- 抽取 provider-neutral 会话元数据、绑定和增量读取接口，Codex 原有命令保留为兼容入口。
- 身份使用 provider + session_id；cwd 只用于发现候选，显式绑定确定项目归属。
- Claude 解析用户/助手消息、tool_use/tool_result、使用量与可得终止信息，原始流单独保留。
- 子 Agent 作为关联子会话，不能混作主会话，也不能仅凭目录名推断完整执行上下文。
- 复用游标、稳定事件 ID 和断点采集；处理半行、重复回放、截断和轮换。
- 不把宿主机聊天日志误称为所有宿主机命令的完整审计；缺失的覆盖范围明确标注。

验收：两种 Agent 的录制样本均可发现、绑定和增量导入；旧 Codex 绑定升级后不重复；
Claude 子会话能追溯父会话；未授权项目材料不被目录扫描自动导入。
用户提供的真实 JSONL 只用于本地结构核对，测试仓库使用最小匿名样例，不提交真实聊天。

### R5：科研复盘页面与接口收敛

主要位置：`gateways/http`、`runs/console.py`、`projects/console.py`、`src/web/src/api`、
`src/web/src/features/project-detail.tsx`、运行详情及公共图表组件。

- 项目页给出运行表、指标比较、代码差异和关联会话；日志、产物和失败原因保持近距离可达。
- 科研和 benchmark 共用日志、轨迹、资源和产物组件；benchmark 的评分、有效性和官方聚合独立展示。
- 新接口以已有 Pydantic 能力定义明确响应结构，生成 JSON Schema/TypeScript 类型并检查漂移。
  不只增加空 codegen 目录，也不为了生成类型重写整个 HTTP 框架。
- 逐个替换所涉及的手写 Any/TS 类型；未迁移的旧端点明确保留，不伪称全站契约已自动生成。
- 保留现有视觉 token、导航修复、深链接和 ASI 审阅能力。
- 实现显式重跑与原实验比较，展示代码、数据、镜像和资源差异；不能一键偷偷重复付费模型批次。

验收：同一项目能并排比较至少两个实验；可从结果找到代码和 Agent 会话；
旧运行 URL 有正确导航；benchmark 官方分数与健康诊断不被混算；前后端契约检查与页面回归通过。

### R6：清理冗余与完成迁移

- 无生产调用、无承诺中的外部接口、无历史读取责任的旧实现才可删除。
- `LocalRunJournal` 的兼容导出按当前公开使用边界处理，必要时先弃用，而非因只剩一个测试就直接删除。
- `LocalProjectCatalog` 保留旧数据只读桥接，项目可变状态归到 Projects；完成映射后停止新写入。
- 可选 Planner/研究流程从核心启动链解耦；仍在使用的路径不以“精简”为由静默失效。
- 为历史设计标明状态与现行入口；保留已集成任务记录，不批量删除历史，也不修改治理规范。
- 更新一份实现导读和一页项目状态，以代码和验收结果为依据。

验收：无重复生产执行器或资源账本；所有仍保留的入口有清楚用途；历史读取通过；
必要检查全部通过；最终变更与回退说明完整。

## 5. Benchmark 不能被通用化过程改变的事项

1. ASI 继续通过官方 runner 启动官方 Docker 与 Codex；保留原生 instance、prompt level、评分产物和轨迹。
2. TB-Science 继续优先复用现有 Harbor 原生执行。仅能读 Harbor 目录格式，不能证明执行协议等价。
3. 不强制 PAST family、PostTrain 训练/评测任务拆成统一的两个容器步骤。
4. 官方汇总、全部尝试、有效评测子集的诊断均值分别展示；不自行删除失败题来改变官方分母。
5. Oracle/空答案是可选协议探针，预期结果由各 bench 声明，不能硬编码任意 bench 都必须满分/零分。
6. 沿用独立适配包 SDK；新 bench 仍应尽量只修改适配包，而不是修改通用调度内核。

## 6. Git、验证和回退

- 先标签，后独立 worktree 和任务分支；每个可运行阶段形成小提交，提交前检查完整暂存差异。
- 不重写 TS 分支，不覆盖其他 worktree；本次不删除原始结果、认证、运行状态或历史批次。
- 数据变更采用版本化、幂等升级，先验证副本；不在正在运行的真实 state 上试迁移。
- 开发检查沿用 `make verify`：Ruff、import-linter、mypy、前端检查、单元测试和构建。
- 对新增契约、共享租约竞争、崩溃恢复、证据完整性及历史兼容增加有意义的回归测试。
- Docker/模型/GPU 实验另行记录实际节点、任务归属、资源和时间预算；不把假后端测试说成真实验收。
  历史模型预算属于原任务，不能直接作为此次整套重构的执行预算。
- 新旧服务不能同时在互不知情的账本上调度同一 GPU；TS 与 Python 的测试端口、state 和资源安排独立。
- 所需检查通过后再按用户授权范围集成；标签只保护代码，运行数据库须单独备份或保留旧根目录。
- 单个阶段有问题优先 revert 对应提交；数据已经升级时按迁移说明恢复，不能只切标签就假设数据库兼容。

