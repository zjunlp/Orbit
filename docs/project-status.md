# 项目当前状态

Updated at: 2026-09-30T04:10:15.881378+00:00

Basis: 本文在 `refactor/python-research-core` 上提出合并后的状态，以 `main@920ee1d` 为基线。
实现、验收、Git 集成与常驻部署是不同事实；是否已合并以 Git 为准。
当前阶段：S2 与 S4 持续推进。定位为本机、单管理员的 CPU 科研与原生 benchmark 运行/复盘工具。

## 阶段概览

| 阶段 | 状态 | 当前结论 |
| --- | --- | --- |
| S0：工程基础 | `accepted` | 锁文件、自动检查、依赖边界和协作规则已有验收。 |
| S1：模块契约与任务样例 | `in_progress` | 核心模块、独立适配 SDK、直接命令和复盘契约已实现；ToolBinding 与完整原生等价性仍缺。 |
| S2：完整单节点工作流 | `in_progress` | CPU 科研可试用，直接命令重启续查有真实证据；完整 GPU Run 与各类故障恢复仍未全部验收。 |
| S3：两节点执行与故障处理 | `not_started` | Worker/Ray、远程执行和跨节点恢复未落地。 |
| S4：Web 与批量评测 | `in_progress` | 科研实验比较、原生会话、benchmark 批次与证据复盘已实现；全部原生套件/官方提交仍未验收。 |

## 可用能力及证据范围

- **科研短路径**：已有代码目录可直接通过 CLI/MCP 提交 Docker 命令，无需研究方案或 Task 编译；
  记录代码/镜像、日志、部分产物和指标，支持排队、取消、超时、当前代码重跑和父子 Run 关联。
  真实 CPU Docker 验证覆盖 Controller 强制重启后续查、失败产物及清理释放；不涉及模型或 GPU。
- **共同执行与资源**：直接命令和原生 benchmark 复用持久执行内核；科研、旧 Task 与本机 benchmark
  共用同一用户的节点租约库，包含 scope 配额、GPU UUID 互斥和观测准入。远程原生调度分域。
  每个状态根 FIFO，尚无跨队列公平调度；旧 Task/长期环境仍在重启后中断清理。
- **保留的科研工作流**：初始化、版本化方案/确认、冻结 Task、宿主机 MCP 长期环境、有限环境修复、
  真实产物分析与有界迭代继续可用。A/B/C/D/H/E/I/W 的既有真实模型证据保留各批适用范围。
- **记录与 Web**：原始流、规范事件、产物和文本分页读取；新增归档指标曲线、双实验配置/代码比较、
  当前代码重跑及宿主机会话面板。Codex/Claude 显式绑定与增量采集共用存储，旧 Codex 命令兼容；
  Claude 本轮以匿名录制样例验证。新增复盘响应生成 TypeScript，旧接口尚未全部迁移。
- **Benchmark**：BM00–BM07 已建立独立包 SDK、显式启用、兼容检查、原生 job 对账、批次/预算、
  证据归档及授权候选流程。ASI Codex Docker + 本地公开评分有真实验收；公开 b3 60 项持久数值评分
  均分 **35.43277818088395**。只读复盘发现 19 项评分依赖/judge 异常，13 处原生状态冲突；
  页面分别展示评分与健康证据，不能把这个均值称为官方成绩或纯模型能力结论。
- **其他原生适配**：TB-Science 原生 CPU Oracle trial 有评分证据；Codex 已求解并归档轨迹，受预算限制
  在 verifier 前取消，尚无完整 Codex 评分验收。70 项静态 `gpus=0` 不证明全部真实无需 GPU，
  4 CPU/8 GiB 仅覆盖 51 项声明。PAST 无模型 family 对照、PostTrain 模拟外部 job 有工程验收，
  尚无真实 Agent/judge 或 H100/HTCondor 集群验收。
- **GPU**：本机 Toolkit、CDI 指定卡 CUDA 计算、DockerEnvironment 清理与 UUID 授权已有局部证据；
  本轮新增资源共用不等于完成真实 GPU 训练验收。

## 主要缺口

- 完整 GPU 科研训练、checkpoint 恢复、不可变外部数据版本、科研大权重远端存储/备份。
- ASI 评分依赖修复与独立重评版本；TB-Science 完整模型评分、PAST 与 PostTrain 真实原生运行。
- 跨用户/多节点资源控制、Worker/Ray、多人在线权限和安装即用部署。
- Claude 后台持续采集、原生格式持续兼容、token/logprob 等 RL 数据；宿主机聊天不是完整操作审计。
- 全部旧接口类型生成、benchmark 页面持久重跑；自动科研仍受显式预算与冻结任务/候选范围约束。

## 下一步优先级

1. 审阅并集成本次 Python 重构；备份并排空旧活动租约后升级，用实际科研代码走直接实验与比较流程。
2. 根据 ASI 60 题证据修复评测依赖、保留独立重评版本，再在明确预算下补 TB-Science 求解至评分验收。
3. 准备训练镜像与不可变数据版本，完成单 GPU 科研 Run，并完善状态备份和安装诊断。

## 项目级阻塞与限制

纯代码开发无外部阻塞。真实模型需要认证和明确费用预算；GPU 验收需训练镜像与资源范围，
多节点需第二台机器与网络；PostTrain 原生验收还需 H100/HTCondor/Apptainer 和共享存储。
当前 HTTP 面向本机管理员；托管 CI/分支保护仍需平台核实，License 尚未确定。
本轮未切换生产服务、迁移真实运行数据或启动新模型批次。

## 相关记录与入口

- [本次重构与验收](changes/20260930-python-research-core-8e12c4.md)、[实现导读](implementation/python-research-core.md)、[直接实验操作](operations/direct-experiments.md)
- [ASI 60 题证据复盘](changes/20260928-asi-b3-review-e91c7a.md)、[TB-Science Codex 验收](changes/20260926-tb-science-codex-7ad3e1.md)
- [BM07 集成维护](changes/20260923-benchmark-integration-maintenance-35a9d2.md)、[GPU 操作](operations/gpu-local.md)、[文档导航](README.md)
