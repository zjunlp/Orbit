# GUI Agent 评测基础设施调研

调研日期：2026-11-03。范围为前次按 GitHub star 排序的前六项，截至 CUA-Lite；BrowserGym + AgentLab 包含两个仓库，因此共七个源码仓库、六份专题报告。

本组报告关注实际实现：任务定义与初始化、agent 接口、评分、环境隔离、并行调度、失败恢复、产物与 Web 界面。证据来自固定 commit 的源码和仓库文档；**没有启动这些项目的容器/VM/模拟器、运行模型评测或进行多节点压测**。文中“已核查”表示存在对应实现，不表示已经实测通过。建议部分明确作为设计判断。

## 1. 报告导航与覆盖数

Star 为 2026-11-03 本次重新查询 GitHub API 的快照，后续会变化。Cua 使用整个 monorepo 的 star；BrowserGym 与 AgentLab 不相加。

| 排序 | 详细报告 | Star 快照 | Benchmark 覆盖口径 | 最值得研究 |
| --- | --- | ---: | --- | --- |
| 1 | [Cua Bench](01-cua-bench.md) | 31,653 | 11：3 个 registry taskset + 8 个外部适配；含 2 个 grounding | 任务打包、固定版本 registry、Harbor/ATIF 结果 |
| 2 | [BrowserGym + AgentLab](02-browsergym-agentlab.md) | 1,426 / 661 | BrowserGym 默认配置 9 + OpenApps 外部入口；加 OSWorld/GAIA 为 12，其中 10 个为在线 GUI/Web 套件 | 实验矩阵、任务依赖、续跑、轨迹复盘 |
| 3 | [OSWorld-V2](03-osworld-v2.md) | 406 | 1：OSWorld-V2；v2.1 manifest 记录 108 个任务 | VM 生命周期、真实状态评分、发布版本绑定 |
| 4 | [Gym-Anything](04-gym-anything.md) | 301 | 1：CUAWorld；macOS 变体不重复计数 | 软件环境封装、初始化缓存、能力感知调度 |
| 5 | [MobileWorld](05-mobileworld.md) | 299 | 1：MobileWorld；官方 201 任务 / 20 应用 | Android 评测闭环、可提交作业的 Web 页面 |
| 6 | [CUA-Lite](06-cua-lite.md) | 120 | 主评测路径 18 个命名套件；含 2 个 grounding，另有训练/生成环境 | 环境服务、容量准入、多节点路由、资源对账 |

Star 来源：[Cua API](https://api.github.com/repos/trycua/cua)、[BrowserGym API](https://api.github.com/repos/ServiceNow/BrowserGym)、[AgentLab API](https://api.github.com/repos/ServiceNow/AgentLab)、[OSWorld-V2 API](https://api.github.com/repos/xlang-ai/OSWorld-V2)、[Gym-Anything API](https://api.github.com/repos/cmu-l3/gym-anything)、[MobileWorld API](https://api.github.com/repos/Tongyi-MAI/MobileWorld)、[CUA-Lite API](https://api.github.com/repos/cua-lite/cua-lite)。每份报告提供对应固定版本的源码链接。

计数并非完全同质：registry、外部 adapter、静态 grounding 和多工具任务各自含义不同。因此每份报告列出了名字与排除规则，而没有把“任务数”“软件数”“平台变体”和“benchmark 数”混为一个指标。

## 2. Web 能力对照

| 项目 | 网页能力 | 能否在该页面提交/取消评测作业 | 需要特别区分 |
| --- | --- | --- | --- |
| Cua Bench | 本地 trace viewer；外部 trajectory viewer 入口 | 核查的主要入口为 CLI，未确认统一 Web 作业管理 | 本地 viewer 与外部托管页面不同 |
| BrowserGym + AgentLab | Gradio Agent X-Ray：轨迹、截图、DOM、日志、提示词调试 | 未发现 X-Ray 提供完整批次作业管理 | Prompt Tests 会调用模型；不是只读静态图集 |
| OSWorld-V2 | Flask Monitor：进度、结果、截图、录制 | 未发现 Monitor 提供提交/取消 runner 的接口 | Monitor 与 VM 的 VNC/noVNC 不同 |
| Gym-Anything | 集群/环境 dashboard；独立 trajectory viewer | 有环境和节点管理能力，未确认统一 benchmark 作业门户 | 独立 dashboard 含空闲环境自动清理线程 |
| MobileWorld | eval-server + 日志 viewer + 静态 HTML 导出 | **有**：提交、排队、取消、重跑、查看结果 | 重跑默认补齐缺结果任务，不是全部重新测 |
| CUA-Lite | HTTP 环境/admin/metrics 接口；部分环境可看远程桌面 | **未发现统一评测 Web 页面** | FastAPI 和 metrics 不等于现成 dashboard |

这里的“未发现”限定于本次固定版本和已核查入口，不代表未来版本或独立商业服务一定没有该能力。实现依据见各报告的 Web 章节。

## 3. 调度与恢复的区别

| 项目 | 主要调度对象 | 已实现机制 | 不能直接推导出的能力 |
| --- | --- | --- | --- |
| Cua Bench | task variant / attempt | 单机异步并发、新环境、错误退避、后台运行 | 多节点环境池和全局资源配额 |
| AgentLab | Study / experiment | Ray 依赖图、进程并行、多网站配置、目录续跑 | 网站数据库天然隔离、完整分布式作业持久化 |
| OSWorld-V2 | task / VM worker | 多进程共享队列、VM 恢复、结果扫描 | 任务出队后崩溃必然重投递 |
| Gym-Anything | 环境实例 + 批任务进程 | 能力筛选、pending 槽位、心跳、初始化缓存 | master 状态持久化、跨进程任务精确一次领取 |
| MobileWorld | 评测 job + Android task | SQLite 作业表、容器额度、tmux、环境队列、结果续跑 | 通用资源装箱、清理完成的事务确认 |
| CUA-Lite | 有状态环境实例 + rollout sample | 多层准入、sticky fleet、typed errors、idle/reconcile | 环境跨节点迁移、默认统一 Web 作业系统 |

## 4. 对 Orbit 的研究优先级

以下是基于本组源码的建议，不是已经完成的产品集成：

1. **任务与结果规范**先读 Cua Bench，尤其是 setup/agent/evaluate 的分工、attempt 与 retry 的区别、镜像 digest 和 ATIF。
2. **环境调度与回收**先读 CUA-Lite，再对照 Gym-Anything 的 runner 能力发现和创建槽位预留。
3. **评测证据与复盘**先读 AgentLab X-Ray 和逐步记录，再研究 MobileWorld 的轨迹查看/静态导出。
4. **真实环境复现**读 OSWorld-V2 的 release manifest 和 reset，再读 MobileWorld 对设备、后端、任务对象三层状态的重置。

对接时应继续使用 Orbit 现有 daemon 的唯一状态写入路径，避免把外部 runner 的队列、数据库或文件状态直接复制成第二套运行状态机。执行结果、评测有效性、环境清理状态应分别报告。

## 5. 固定源码版本

| 仓库 | 本地目录名 | 本次调研 commit |
| --- | --- | --- |
| [trycua/cua](https://github.com/trycua/cua) | `cua` | `2829e00b180dfb08ca5ff4cbd7c95e0a14ad3409` |
| [ServiceNow/BrowserGym](https://github.com/ServiceNow/BrowserGym) | `BrowserGym` | `27a90ce815098f43414e93491e06907af468e45b` |
| [ServiceNow/AgentLab](https://github.com/ServiceNow/AgentLab) | `AgentLab` | `8488c564eea0525aaff5dea189bb03a9b529546e` |
| [xlang-ai/OSWorld-V2](https://github.com/xlang-ai/OSWorld-V2) | `OSWorld-V2` | `d9953673daf55381237e058fd9388cc2d74c5538` |
| [cmu-l3/gym-anything](https://github.com/cmu-l3/gym-anything) | `gym-anything` | `d444c61372f7858fe7d83e63a781cc86c4f4dfc0` |
| [Tongyi-MAI/MobileWorld](https://github.com/Tongyi-MAI/MobileWorld) | `MobileWorld` | `a026188705f4a494a12d14ddab3786a23fd2c537` |
| [cua-lite/cua-lite](https://github.com/cua-lite/cua-lite) | `cua-lite` | `2af69268c0573f4c12aac391cc03125e6d5c7974` |

这些仓库分别固定各自默认分支的本次快照，并不是一套已验证相互兼容的依赖组合。Git clone 也不等于运行环境安装：子模块、Git LFS 大文件、VM/容器镜像、受限素材、模型权重和 Python 依赖仍需按各项目说明准备。

## 6. 已知范围限制

- 本次核查功能实现与调用路径，没有测量吞吐、启动时延、稳定性或评分准确率。
- 一些 README 与源码已经不同步，例如 Cua 当前本地运行方式、CUA-Lite 的 MobileWorld 默认任务子集；报告优先解释固定源码与任务清单的行为。
- 外部网站、模型 judge、镜像标签和应用后端均可能影响重现；固定仓库 commit 是必要证据，但不是完整的运行复现保证。
- 后续若做实测，应分别验证任务初始化、环境清理、原始 evaluator、UI 操作和故障恢复；不能用默认 fake 测试代替真实 GUI 环境检查。
