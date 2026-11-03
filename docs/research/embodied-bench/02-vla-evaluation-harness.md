# AllenAI VLA Evaluation Harness：具身策略评测运行时与 Orbit 的接入边界

调研日期：2026-11-03。本文以实际克隆仓库的完整提交 `cc260841a0a32be778ec8604504de4bd5e663a5f` 为准；提交时间为 `2026-11-03T15:26:26+09:00`，提交主题是 `feat(robodojo): send observations as raw images (#205)`。所有上游源码链接固定到这一提交，避免跟随主分支漂移。

本文进行源码、配置与测试的静态核查，没有安装上游依赖，没有启动模型、仿真器、Docker 或 GPU 作业，也没有运行上游测试。文中的“已实现”表示对应路径和测试存在，不表示已经在本机完成真实仿真验证。Orbit 对照基于本地提交 `3e92a17821552b1cc76e5af25e94ca2bce7300d0` 的 `docs/design.md` 与 `docs/status.md`，尤其区分设计 §9 的规划与当前产品能力。[O01] [O02]

## 1. 定位与结论

VLA Evaluation Harness 的核心是把**模型服务、仿真环境、episode 循环、结果记录**拆开，让同一模型接多个 benchmark，同一 benchmark 接多个模型。它不只是 benchmark 数据集，也不只是模型调用脚本：仓库已经实现跨环境的 Python 接口、独立 WebSocket 模型服务、本地分片队列、向量环境、模型微批处理、容器入口、SQLite 记录与导出。[S01] [S02] [S03]

它最适合运行需要连续图像与机器人动作的 VLA/policy，尤其是要比较模型推理延迟、动作分块和仿真结果的团队。对以工具调用、长对话、文件操作为主的 CLI Agent，它没有 Harbor 那样的任务安装与 Agent 执行契约；可以在模型服务内实现规划 Agent，但仍需自己把其输出转为环境动作。[S03] [S12] [S17]

对 Orbit 的价值主要在**具身评测内层**：benchmark 适配、policy 服务协议、动作时序和 episode 证据。Orbit 已有的作业队列、资源租约、容器生命周期、Run/Trial 与有效性逻辑仍应由 Orbit 负责。不要把上游共享 SQLite 队列直接提升为 Orbit 的第二套作业状态机，也不要把上游 `mean_success` 无条件当作 Orbit 的有效样本均值。

最需要纠正的四个判断是：

1. 它已经有 `DimSpec` 观测/动作约定检查，但不匹配只告警，不拒绝运行，不能当作强类型兼容性保证。[S08] [S09]
2. 其基础设施错误会写成 `success=False` 并进入成功率分母，同时单独报告 `num_errors`；不是自动排除无效 episode。[S23] [S24]
3. 其 SQLite 允许多个进程分别连接、写入同一个文件，以事务协调；不是 daemon 单写者架构。[S20]
4. 其恢复主要是 episode 重做与结果修复。默认分片脚本不会自动重启 watchdog 的退出码 `124`，也没有通用仿真中途快照恢复。[S25] [S26] [S27]

## 2. 功能矩阵与适用范围

| 能力 | 当前实现 | 使用边界 |
| --- | --- | --- |
| 跨 benchmark | YAML 指定 `module:Class`，统一 `Benchmark` 家族 | 统一生命周期，不统一所有机器人的动作语义。[S03] [S07] |
| 模型/环境解耦 | WebSocket + MessagePack，模型独立进程或服务 | 远程模型地址不等于远程 worker 调度。[S12] [S13] |
| 同步执行 | `SyncEpisodeRunner` 逐步等待动作 | 适合离散仿真；推理耗时不会自动推进环境。[S10] |
| 实时语义 | `LiveEpisodeRunner` 按时钟推进、动作过期时 hold | 适配器必须实现 hold；无通用硬实时保证。[S11] [S09] |
| 环境并发 | 多个 shard；单进程 `VectorStepBenchmark` | 向量环境只支持 sync，取决于具体适配器。[S03] [S09] |
| 推理批量 | `PredictModelServer` 的微批处理、action chunk 缓存 | 模型默认单推理线程；不是多 GPU 推理集群管理。[S15] [S16] |
| 动态调度 | 保存记录的分片共享 SQLite work queue，空闲 shard 取其他分片未领取项 | 没有节点注册、资源租约、心跳到期回收协议。[S21] |
| CPU/GPU 分配 | Docker CPU 集合切分、GPU 轮转绑定 | 不检测其他作业占用，不做显存/内存配额或集群容量预留。[S28] |
| 容器 | Docker；另有 Charliecloud 路径 | 运行时隔离仿真依赖；默认配置不等于可公开暴露的服务平台。[S29] [S30] |
| 持久化 | episode 结果、step 字段、队列、分片与元数据 | step 通常在 episode close 时提交；不是逐步持续耐久日志。[S20] [S22] |
| 失败恢复 | 同 eval/shard 恢复未完成项；指定错误退出重启；export 标记 partial | 不能概括为任意故障自动重试或中途状态恢复。[S25] [S26] [S27] |
| 复现材料 | 配置、模型服务信息、harness 版本、seed、渲染信息 | 镜像 tag 与模型/数据文件仍需调用方额外固定。[S09] [S31] |

README 将模型×环境组合分为“复现完成”“已集成待复现”“计划中”。因此某个 benchmark 目录存在，只能证明接入代码存在；不能推导所有模型组合、sync/live 组合或渲染后端都已验证。本文不把该矩阵中的未复现条目升级成验证通过。[S01]

该提交 README 的主要条目举例如下；状态是**上游维护者在矩阵中的标注**，不代表本文重新跑过：[S01]

| 类别 | 上游标为 ✓ reproduced 的例子 | 上游标为 ◇ integrated、awaiting first reproduction 的例子 |
| --- | --- | --- |
| Benchmark | LIBERO、SimplerEnv、CALVIN、LIBERO-Plus、RoboMME、MolmoSpaces-Bench | RoboCasa/RoboCasa365、RoboTwin、BEHAVIOR-1K (2026)、RoboDojo、VLABench |
| 官方模型服务路径 | OpenVLA、π₀、π₀-FAST、GR00T N1.6、OFT、X-VLA | CogACT |
| 第三方实现桥接 | dexbotic 的 DB-CogACT；starVLA 的 QwenGR00T/QwenOFT/QwenFAST；LeRobot 的 π₀.₅/GR00T N1.7/MolmoAct2/VLA-JEPA | starVLA 的 QwenPI；LeRobot 的 π₀/X-VLA/SmolVLA/FastWAM/LingBot-VA |

矩阵另把 FurnitureBench、MemVLA 标为计划中。模型名相同但实现路径不同，状态可能不同，例如官方 π₀ 是 ✓，LeRobot π₀ 是 ◇；选择入口应精确到配置/模型桥，而不只看模型名。[S01]

## 3. 目录与关键对象

下表除另有说明外，路径均相对于仓库的 `src/vla_eval/`。

| 路径 | 关键符号 | 职责 |
| --- | --- | --- |
| `cli/main.py`、`cli/config_loader.py` | `cmd_run`、`cmd_serve`、`load_config` | 参数、继承配置、容器分派、模型入口。[S04] [S05] |
| `config.py` | `EvalConfig`、`DockerConfig` | benchmark、运行模式、记录、容器配置。[S06] |
| `orchestrator.py` | `Orchestrator` | 构建 benchmark、任务展开、选 runner、协调记录/队列。[S07] [S09] |
| `benchmarks/base.py` | `Benchmark`、`StepBenchmark`、`VectorStepBenchmark` | 普通、离散步进、向量环境契约。[S03] |
| `connection.py`、`protocol/` | `Connection`、`Message` | 握手、episode 消息、序号、数组/图像编码。[S12] [S13] [S14] |
| `model_servers/base.py` | `ModelServer`、`Row`、`Rows` | 并发 episode 生命周期、模型线程、请求响应。[S15] |
| `model_servers/predict.py`、`engine.py` | `PredictModelServer`、预测引擎 | 批处理、逐 row 状态、动作块缓存。[S16] |
| `model_servers/daemons.py` | `DaemonModelServer`、`EpisodeContext` | 自定义 episode 策略循环与异步动作发布。[S17] |
| `runners/` | `SyncEpisodeRunner`、`LiveEpisodeRunner`、`VectorEpisodeRunner` | 三类环境推进方式。[S10] [S11] [S18] |
| `recording.py`、`results/` | `RecordingStore`、`EpisodeRecorder`、`ResultCollector`、`export_db` | 记录、聚合、导出。[S20] [S22] [S23] [S24] |
| `docker_resources.py`、`cli/_docker.py` | `shard_docker_flags`、`run_in_container` | 单机容器参数与子进程生命周期。[S28] [S29] |
| `api.py` | `serve_background`、`run`、`evaluate` | 在 Python/训练循环中复用评测。[S32] |

这里最重要的边界是：`Orchestrator` 面向 benchmark/episode；`ModelServer` 面向 policy 与并发 row；容器包装位于 CLI 外层。一个 YAML 含多个 benchmark 时，`Orchestrator.run()` 按列表**依次**执行它们，并非把整份矩阵自动并行展开。[S07]

## 4. 从 CLI 到 episode，再到导出的完整路径

可以把一次标准调用理解为以下链条：

```text
vla-eval run
  → load_config：解析 extends 与 OmegaConf 插值
  → cmd_run：覆盖参数、校验 shard 与渲染配置
  → [可选] run_in_container → 容器内 run --no-docker
  → Orchestrator.run → RecordingStore
  → _run_benchmark_inner → Connection.connect / HELLO
  → 构建 benchmark → 检查 specs → 展开 task × episode
  → _run_one_at_a_time 或 _run_vector
  → runner：reset/start → ready → observe/act/step → end
  → _episode_ended → EpisodeRecorder.close → 队列 finish
  → export：SQLite 一致快照 → episode JSONL + aggregate JSON
```

1. `load_config()` 递归处理 `extends`，再通过 OmegaConf 解析环境变量等插值；相对继承文件以配置位置解析。`cmd_run()` 应用 server、output、benchmark 参数与分片覆盖；`shard_id`/`num_shards` 需要成对给出并满足范围。[S04] [S05]
2. 配置有 `docker.image`、未指定 `--no-docker` 且尚不在容器内时，外层 CLI 选择容器路径。配置被转换为临时文件，输出目录挂到容器内；内部再次调用 CLI，显式禁用重复容器化。[S04] [S29]
3. 进入实际运行进程后，输出目录先转绝对路径，防止 benchmark 自己 `chdir` 改变结果位置。CLI 启动默认 1200 秒无进展 watchdog，再创建 `Orchestrator`。[S04]
4. `run()` 为一次评测打开 `recording-<eval_id>.sqlite`。每个 benchmark 先标记 shard 尚未完成，再建立模型连接，交换 HELLO，随后设置渲染环境并构造仿真器。[S07] [S09]
5. 模型 HELLO 可带 `observation_params`，例如需要 wrist camera 或 proprioception。编排器与显式配置合并，显式配置优先；因此换模型可以改变环境产出的观测，但仍应在复现条件中固定这些选项。[S09]
6. 构造后比较模型与 benchmark 的 `DimSpec`。随后检查 live 能否 hold、向量模式是否兼容；读取任务，按筛选条件截取，展开 `(task_idx, task, episode_id)`。最大步数依次取配置、benchmark 元数据、默认 300。[S09]
7. 有记录的分片使用动态共享队列；无保存模式退回固定分片。普通 runner 一次运行一个 episode；向量 runner 一次管理多个槽位。[S09] [S18]
8. 一次 episode 结束后，`_episode_ended()` 归类结果并关闭 recorder。普通分片在 recorder 持久化成功后才把 work item 标为完成；记录错误会传播，不应误记作完成。[S19] [S22]
9. 非分片 CLI 自动导出；分片 helper 等所有子进程退出后统一 `export`。导出先通过 SQLite backup 获取一致快照，释放源数据库锁，再写 JSONL 与 aggregate JSON。[S04] [S24] [S26]

此调用链已经覆盖评测实际执行，但不包括模型权重管理、集群节点选址、GPU 独占租约、队列优先级或用户认证服务；这些应由外层运行平台补足。

## 5. Benchmark 契约与机器人语义

`Benchmark` 提供异步生命周期：`start_episode()`、`apply_action()`、`get_observation()`、`is_done()`、`get_time()`、`get_result()`；公共层还有任务、元数据、指标、渲染、清理与恢复钩子。`StepBenchmark` 把同步 `reset/step/make_obs/get_step_result` 封装进同一异步接口，使已有 Gym 风格代码容易接入。[S03]

`VectorStepBenchmark` 则接收槽位列表：`reset(slots, tasks, recorders)` 返回列式 Batch，`step(slots, actions)` 返回观测 Batch 与 done 数组，`result(slot)` 提供每个 episode 结果。`partial_reset=False` 默认按一波环境完成后再重置；支持 partial reset 的适配器可在槽位空闲后补入新任务。[S03] [S18]

接口统一没有抹去动作语义。`DimSpec` 描述字段名、维度、格式、可接受格式、范围；仓库定义 delta/absolute position、Euler/axis-angle/quaternion、不同 gripper 正负方向等约定。`check_specs()` 对生产者与消费者做静态兼容性检查，但 orchestrator 只记录 warning，检查本身报错也只是 warning。[S08] [S09]

因此接入时仍要核对坐标系、单位、归一化、末端姿态表示、夹爪方向、相机翻转、动作频率、初始状态和终止条件。不能因为 HELLO 正常或 `DimSpec` 字段存在，就认为动作已被正确转换。

LIBERO 的实际适配器说明了这些细节的重要性：它按任务复用环境，按 episode 索引选择预定义初始状态，执行 settle steps；动作会处理 gripper，观测会处理图像方向与可选 wrist/proprio。它返回的 proprio 是位置、轴角和双 gripper 量组成的 8 维状态，不能简单套用另一个机器人的“8 维”解释。[S33]

模型适配器也有自己的图像预处理与动作约定。例如 OpenVLA 的 spec、图像处理和 `predict()` 实现在服务侧；benchmark 对接仅解决接口，复现仍取决于模型侧 preprocessing 是否与原实现一致。[S34]

## 6. 协议、同步执行与 live 执行

### 6.1 消息与序列化

传输使用 WebSocket + MessagePack。消息信封包含 `type`、`payload`、`seq`、`timestamp`；类型包括 `HELLO`、`OBSERVATION`、`ACTION`、`EPISODE_START/END/READY`、`VECTOR_STEP/RESULT`、`PUBLISH` 和错误消息。HELLO 携带协议版本、harness 版本与能力协商。[S12] [S13]

数组编码保留 dtype、shape、数据；HWC uint8 图像可以走 raw/JPEG/PNG，通用 codec 默认图像格式是 PNG。该 HEAD 对 RoboDojo 的 raw 图像修改不能外推为全系统所有图像一律 raw。对象、void、complex 等不在允许的数组 dtype 集合里。[S14]

payload 本身仍是模型/benchmark 定义的字典，不是覆盖所有机器人的封闭 action/observation schema。协议 envelope、能力协商和 `DimSpec` 分别解决消息可解析、功能可用、约定可检查三件事，不能混为严格动作校验器。[S08] [S12]

连接实现将重连边界放在 episode 起点。中途连接丢失不能无损重建模型内部状态，因此不会透明接着原 episode 继续。支持 `EPISODE_READY` 的服务在初始化完成后确认，旧服务没有该能力时保留兼容路径。序号处理也有不同严格程度：sync `act()` 丢弃此前 episode 的迟到响应；属于当前 episode 但与当前请求序号不一致的响应只告警，仍返回其 payload。READY 与 vector 路径则要求匹配序号，不能笼统声称所有响应都严格绑定当前请求。[S13] [S35]

### 6.2 sync：推理决定每一步何时发生

`SyncEpisodeRunner` 先 reset 与取首个观测，通知模型 episode start 并等待 ready；随后循环 `act(observation) → apply_action → is_done → get_observation`。到达环境终止或 max_steps 后调用 `get_result()`，最后发送 episode end。[S10]

其语义是环境等待推理：模型慢会增加墙钟耗时，却不会自动在等待期间多推进仿真步。这适合常见离散策略评测，也解释了为何不能仅用 sync 成功率判断低延迟控制效果。

### 6.3 live：环境时钟与推理解耦

live 在环境/模型初始化和 ready 握手结束后启动时钟，以 `hz` 推进环境。动作缓冲区取最新可用动作；没有新动作时调用 benchmark 的 `get_hold_action()`。它不会因为还没有第一条推理结果就无限等待，因此 benchmark 必须定义当前机器人语义下的 hold。[S11] [S09]

hold 不是通用的“重复上一动作”：对速度或增量控制，重复动作可能继续运动；对绝对目标控制，重复目标可能才是 hold。基础类明确要求适配器自己声明，未声明会在 episode 开始前失败。[S03]

live 记录 fresh/stale tick、有效控制频率、环境步进耗时等指标，并在仿真步进明显过慢时告警。`paced=False` 去掉按墙钟等待，适合吞吐测量，但不能再把这种运行称为真实墙钟实时评测；`throughput_mode` 还可能复用初始状态，需与正式准确率评测区分。[S11] [S06] [S19]

## 7. 模型服务的批量、并发与资源含义

`ModelServer` 用 row 管理并发 episode，维护代际标记以区分旧 episode 遗留请求。`max_rows` 可限制同时存在的 episode，超过上限的 start 会失败；默认没有这一容量上限。模型计算通过一个 `ThreadPoolExecutor(1)` 串行提交，服务连接的并发并不意味着每个 episode 都有独立推理线程。[S15]

`PredictModelServer` 适合 `predict(observation, row)` / `predict_batch(batch, rows)` 模型；构造参数包括 `chunk_size`、`max_batch_size`、`max_wait_time`。引擎按最早请求到达时间等待微批，向量 step 本身已经成批时不额外等满窗口。[S16] [S42]

引擎为每个 row 保存动作 chunk；后续观测可直接领取缓存动作，不必每一步重新推理。不同请求形状无法拼成同一 Batch 时，代码有退回分别处理的分支；实现了 `predict_batch()` 才能提供真正的模型批量计算，默认逐 row 推理不会自动获得相同收益。[S16]

`DaemonModelServer` 则让作者编写自定义 episode 循环，通过 `EpisodeContext` 取观测、调用模型并回复或主动发布动作。它适合异步规划、分阶段策略等更复杂控制；sync 按已知 step_dt 使用模拟时间，live 使用墙钟，无 step_dt 的 sync 有未知时钟路径。该类明确不支持 VECTOR_STEP，不能把所有模型服务的能力视为完全一致。[S17] [S43]

服务另有 `/health` 与配置控制端点；后台 backpressure monitor 的作用是告警，不是自动扩容或负载均衡。本次检查的 HTTP/WS 服务入口没有发现内建身份认证检查，默认监听地址可覆盖外部接口；应把它视为受外层运行环境管理的模型服务，而非独立多租户控制平台。[S36]

Python API 可通过 `serve_background()` 在已有进程中服务一个模型对象，再调用 `run()` 或 `evaluate()` 做评测，避免必须另起模型权重副本。它提供训练循环间隙的评测入口，但不包含训练调度器；API 默认不启用会杀死整个进程的 watchdog，调用方可选择启用。[S32]

## 8. 分片调度与资源分配

### 8.1 两类分片路径

有保存记录且指定 shard 参数时，每个 shard 展开相同任务列表，然后往同一个 SQLite `work_queue` 做幂等 seed。没有保存时使用固定划分辅助函数，不能再获得共享队列的领取、恢复和工作转移语义。[S09] [S21]

`RecordingStore.claim()` 在 `BEGIN IMMEDIATE` 事务内选择工作项，大致次序如下：[S21]

1. 优先取同 shard 已领取但未完成的项，用于相同 shard 重启后的恢复。
2. 尽量继续当前已加载任务，减少环境/资产切换。
3. 取自身 home block 内未领取项。
4. 自身没有工作时，从剩余未领取项最多的其他 block 尾部领取。

这里的“工作窃取”针对**未领取**项；普通 claim 不会抢走其他仍持有的工作。`task_exclusive` 使已被其他 shard 领取过的任务不能再被当前 shard 获取，可用于不允许跨 shard 同时处理的任务资源，但不是跨独立 eval 的全局互斥锁。[S21]

队列没有时间租约、worker 心跳或自动判死字段。已领取任务的恢复依赖同 shard 重启，或显式 release；因此不能把共享 SQLite 文件描述成完整分布式调度系统，也不能据此承诺任意共享文件系统上的多机稳定性。

### 8.2 本地启动器与设备绑定

`scripts/run_sharded.sh` 启动 N 个本地后台进程，给它们相同 eval ID、输出目录、不同 shard ID；默认 N 为 50。每个进程再按配置决定是否进入容器。脚本等待全部进程结束后做一次 export，任一 shard 最终失败则整体返回失败。[S26]

`shard_docker_flags()` 将 GPU 按 shard ID 轮转映射；多个 shard 可以落到同一 GPU。CPU 在数量足够时按整除分成连续集合，余数可能不使用；当 shard 数大于 CPU 数时，不再生成每 shard 的 cpuset 限制。它还限制部分数值库线程数，避免仿真进程过度开线程。[S28]

这些是容器启动参数生成，不是资源仲裁。没有发现按空闲显存筛选 GPU、检查其他用户作业、全局租约、节点容量注册或优先级队列的实现。Orbit 若包装该 harness，应由 Orbit 先分配资源，再把已分配设备和 shard 数传给内部运行，避免内部默认“全部 GPU/CPU”越过外层预算。

## 9. SQLite、轨迹与结果协议

### 9.1 数据模型

| 表 | 主键/定位方式 | 内容与作用 |
| --- | --- | --- |
| `run_metadata` | 单行 `singleton=1` | 总 eval ID、reporting 设置；刻意不保存整个已解析顶层配置以免复制 docker env 凭据。 |
| `eval_metadata` | benchmark 级 `eval_id` | safe name、benchmark 配置、harness/server/渲染信息、指标声明。 |
| `eval_shards` | `(eval_id, shard_id)` | 期望分片数与完成标记。 |
| `episode_results` | `(sid, eid)` | task/episode、状态、metrics、steps、耗时、context、失败原因、JSONL 目标路径。 |
| `work_queue` | `(eval_id, item)` | task_idx、领取 shard、done。 |
| `step_rows` | `(sid, eid, step_id)` | JSON 字段文档，支持多个记录方按字段合并。 |

上述 schema 与写入逻辑集中在 `recording.py`。总 eval ID 与“总 ID + benchmark safe name”的 benchmark 级 ID 并存；`sid/eid` 区分不同进程和 episode 尝试，不能只用 episode 序号当全局唯一标识。[S20] [S09]

每进程独立 SQLite 连接，60 秒 busy timeout；初始化要求 UPSERT 与 JSON 函数，使用 `journal_mode=DELETE`、`synchronous=EXTRA`，事务通过 `BEGIN IMMEDIATE` 串行化写入。schema 初始化有锁竞争重试，并尝试设置数据库文件权限以支持不同 UID 的容器写者。[S20]

### 9.2 写入耐久性与字段合并

benchmark 可以逐步调用 `record_step()`，但 `EpisodeRecorder` 先把字段收集在内存 `_steps`，到 `close()` 才把 step rows 与 episode result 在一个事务中提交。成功提交之前被强制杀死，不能保证保留该 episode 每一步轨迹。[S22]

模型侧也能用录制句柄写同一 `sid/eid/step`，SQLite 用 JSON patch 合并不同字段；同名字段的后写值会覆盖，而不是保留冲突历史。`EPISODE_START` 携带录制上下文，跨进程/容器使用时必须保持数据库路径可达。[S45] [S35]

视频作为单独文件处理。视频保存异常被记录但不必使 episode 数据库提交失败；因此有成功/失败结果不代表视频一定完整。Orbit 若需要轨迹完整度，应另外检查媒体是否存在、step 是否齐全，不能只读 `status`。[S22]

### 9.3 导出与聚合语义

`export_db()` 用一致快照生成每 episode JSONL 与每 benchmark aggregate JSON。相同工作项有多个记录时，按 `task_name/episode_id/task_idx` 选择**最后提交**尝试；最后尝试为 skipped 时将其排除，而不是选择历史最高分。旧格式缺 task_idx 的行保留独立处理。[S24]

aggregate 包括 task 明细、config、harness/server 信息、seed、render、`num_episodes_total`、`num_errors`。有 work queue 时，以所有项 done 判断完整性；否则退回 shard 标记。未完成队列项会使结果带 `partial` 与 `queue_unfinished`，避免把缺失工作悄悄当成全量评测。[S24]

`get_metric_keys()` 可声明 mean/sum/max/min。数值聚合只使用实际包含该指标的 episode，不把所有缺失指标统一补零；benchmark 总指标直接对全体 episode 聚合，而不是先对 task 求均值再对 task 等权平均。[S23]

最关键的评分区别是：普通任务失败写 `fail`，基础设施或模型执行异常写 `error`，但后者 metrics 仍为 `success=False`。两者都进入 `mean_success`；`skipped` 才不计入。本次读到的测试明确断言“两次成功、两次基础设施错误 → 成功率 0.5，num_errors=2”。[S19] [S23] [S37]

与 Orbit 对接时，应同时保留上游原始指标和 Orbit 的有效性映射。若把上游 error 排除后重算，必须改名或明确标注统计口径差异；不能用重算值冒充官方 harness 原始成功率。

## 10. 失败分类与恢复边界

| 故障/状态 | 源码处理 | 恢复或统计含义 |
| --- | --- | --- |
| reset/start 失败 | `EnvStartError`，reason `env_start` | 作为 error 记录，通常不是立即杀掉整个评测。 |
| 环境 step 失败 | `EnvStepError`，reason `env_step` | 作为 error；需要适配器正确包装异常。 |
| 模型 start/act 失败 | `ModelStartError` / `ModelActError` | 区分初始化和行动阶段。 |
| 服务不可达/连接断开/超时 | `server_unreachable` / `connection_closed` / `timeout` | 不可达可结束当前 benchmark 为 partial；部分断连/超时路径尝试重连后进入下一 episode。 |
| 环境不可再用 | `EnvUnusableError` | 释放动态队列未完成项，退出码 3，适合重新起进程。 |
| 主动跳过 | `EpisodeSkipped` | 不计分；默认 retry，可重复领取，非 retry 则结束该项。 |
| 记录失败 | `RecordingError` | 传播异常，不把该项静默标为完成。 |

错误阶段与映射来自 runner 基类；上层 `_failure()` 写失败原因、连接关闭信息、timeout 或 traceback。它是诊断分类，不等于 Orbit 现有的执行/有效性/清理三态。[S35] [S44]

`_resume()` 会重新 seed 队列，读取非 error 的已结束结果，将“结果已提交、队列 finish 前进程死亡”的工作项补记完成，再把历史结果交给 `benchmark.resume()`。这是已提交结果与队列的对账机制，不是加载完整仿真器、模型 KV/cache 或控制器的中途快照。[S44]

分片起始连续 3 个 episode 都 error、且没有任何正常完成 episode 时，会触发 unhealthy 检查；正常完成但任务失败也算“进程能正常跑”。只有显式启用 `requeue_unhealthy` 才会把这些失败项重新放回队列，默认 helper 没有传该选项。因此“检测到坏 shard 并重启”不保证先前已记 error 的 episode 自动重做。[S25] [S26]

默认 helper 自动重启退出码 3 或大于 128 的退出，最多 `VLA_EVAL_SHARD_RESTARTS` 次，默认 10。watchdog 用独立线程发现 native sim 无进展，并 `os._exit(124)`；124 不满足 helper 的自动重启条件。这一提交能够终止此类卡死，但默认组合没有实现该退出路径的自动恢复。[S26] [S27]

容器外层收到终止信号时会尝试 `docker stop -t 10`，普通退出依靠 `--rm` 清理。源码中的清理异常有吞掉的分支，没有独立、持久的“清理确认完成”状态；外部平台应继续检查容器是否实际消失，再释放其资源。[S29]

## 11. 容器、依赖与部署方式

仓库根目录 `LICENSE` 是 Apache License 2.0，`pyproject.toml` 的许可证声明与之相符。这里指 harness 源码；模型权重、仿真器、资产和数据集是分别引入的对象，不能仅凭 harness 的 LICENSE 判断它们的许可条件。实际复用时应保留并分别核对这些来源声明。[S49] [S02]

核心包要求 Python ≥3.11，依赖 AnyIO、WebSockets、MessagePack、NumPy、OmegaConf、图像/视频工具等。模型脚本与仿真环境的重依赖分别放在对应脚本或镜像中；因此安装核心包不代表已经装好每个 simulator 与模型。[S02] [S04]

Docker 入口生成 `docker run --rm`，使用 host network，挂载配置与结果目录，再附加显式 volumes/env、CPU/GPU 参数。`docker.user` 是可选项，未设时沿用镜像用户；不能一概写成自动以当前宿主用户运行。[S06] [S29]

Charliecloud 由 CLI、环境变量或 YAML 选择，复用镜像配置，适合没有 Docker daemon 的 Linux 环境。它依赖相应工具、用户命名空间等宿主能力；GPU 注入和 CPU 限制行为与 Docker 不完全一致，文档明确不是“所有运行时完全等价”。[S30]

模型一般另起一个服务，再把地址交给 benchmark。Python API 也可以复用已有模型对象。集群系统可以把二者分别包装成服务和评测作业，但该仓库自身没有实现模型服务 placement、自动扩缩容或多租户资源计费。[S32] [S36]

固定源码 SHA 还不足以固定评测：例如已核查的 LIBERO smoke 配置使用镜像 `:latest`。正式复现需要额外固定镜像 digest、环境/资产版本、模型权重标识、seed、初始状态、观察/动作变换和 sync/live 条件。[S31] [S33] [S34]

下面三条命令是**源码已核查的入口示意，未执行**；路径相对于上游仓库根目录，假定依赖、权重和环境已准备。第一条在独立终端运行，模型服务 `/health` 就绪后再执行第二条；第三条展示从同一个 eval ID 对应数据库重新导出。DB-CogACT 配置与 LIBERO smoke 配置均实际存在，后者限制一个 task、一个 episode。[S01] [S31] [S50] [S51]

```bash
vla-eval serve --config configs/model_servers/db_cogact/libero.yaml
vla-eval run --config configs/benchmarks/libero/smoke_test.yaml --eval-id example-libero --output-dir ./results
vla-eval export ./results/recording-example-libero.sqlite
```

单分片正常结束本来就会自动 export，第三条用于理解数据库与导出关系；它不启动新的 episode。示例仅帮助定位调用入口，不表示该模型组合已在本文环境验证。

## 12. 扩展新环境或新模型的实际步骤

新增一个仿真 benchmark，建议按以下顺序实现并验证；这里只给开发路线，不表示已经完成任何接入。

1. 先确认原 benchmark 的任务、初始状态、步数、终止条件与官方 scorer；选择 `StepBenchmark` 或 `VectorStepBenchmark`，保留原环境内部语义。
2. 实现任务枚举、reset、step、观测、结果、metadata、cleanup；有独占任务资源时声明 `task_exclusive`；需要 live 时实现安全 hold 与时间语义。[S03]
3. 写动作/观测 `DimSpec`，列明坐标、单位、图像方向和 state 排列；额外做严格接入检查，因为框架 warning 本身不会拒绝错误组合。[S08] [S09]
4. 在适配器内部区分初始化、step、不可恢复环境错误及跳过；用 recorder 写动作、reward、状态与媒体，避免全部异常混成“失败分数”。[S35] [S22]
5. 增加 benchmark YAML 与隔离镜像，固定 simulator 和资产版本；先一个 task、一个 episode，再增加 episode、shard、向量槽位。[S06] [S29]
6. 对照原 runner 做观测、动作、success 与 seed parity；随后才评估并发是否改变初始状态、任务顺序或指标口径。

新增模型通常继承 `PredictModelServer`，实现初始化、episode reset/finish 与 `predict()`，需要批量再实现 `predict_batch()`；动作块长度与跨 episode 缓存清理必须对应实际模型语义。异步长循环再选择 `DaemonModelServer`，不要为普通逐步模型引入额外调度复杂度。[S15] [S16] [S42] [S43]

`get_observation_params()` 可向 benchmark 申请需要的相机/proprio 字段；`get_action_spec()`/`get_observation_spec()` 声明预期约定。然后单独验证 HELLO、READY、单步动作、episode 切换、并发 row 与异常传播，最后接入真实环境。[S09] [S13] [S46]

## 13. 与 Orbit 当前能力及规划的关系

Orbit 当前已具备 daemon 单写者、作业资源租约、Docker 执行、外部 adapter、Run/Trial 与 valid-only 汇总；多节点已实现，但当前状态文档只确认同一机器上两个 daemon 的验证。已有 BrowserGym/MiniWoB 第一阶段适配与 GUI 轨迹，不等于通用 `env` 或具身能力已经落地。参见 [Orbit 当前状态](../../status.md)。

[Orbit 设计 §9](../../design.md#9-跨场景评测规范规划) 中，`env` 协议、`policy` 桥、统一轨迹、GPU service、环境暖池、设备租约、具身仿真/真机仍属于规划；本次文档不能把这些未来能力当作已经可以直接运行 harness 的基础。

| 层面 | Harness 可提供 | Orbit 接入判断 |
| --- | --- | --- |
| benchmark 语义 | 已写好的机器人环境适配与复现配置 | 优先复用，避免 Orbit 重新解释同一 simulator。 |
| episode 推进 | sync/live/vector runner | 可在外部适配器内保留原 runner，先做原生运行与结果导入。 |
| 模型侧 | WebSocket 服务、batch/chunk、生命周期 | 可作为未来 policy 桥的参考；现有 CLI Agent 注册表不能直接替代。 |
| 资源/调度 | 本地 shard 参数、SQLite work queue | 外层资源与 Run 仍由 Orbit 管；明确只选择一个 episode 分派责任方。 |
| 结果 | 原始成功率、错误原因、partial、重试记录 | 保存原始值，再显式映射有效性；不直接覆盖 Orbit 分母。 |
| 轨迹 | step JSONL、视频、模型/环境联合字段 | 可转换为未来 observation/action/reward/error 事件，保留缺失与完整度。 |
| 恢复 | episode 重做、已提交结果对账 | 与 Orbit 容器 checkpoint 是不同层次，不能相互冒充。 |

近期最稳妥的实现方向是：使用**现有外部 adapter 协议**包装固定版 harness，让 Orbit 管执行资源与产物；一次 Orbit trial 对应明确的任务/episode 集合，保留 harness 的配置、SQLite、导出结果和视频。若允许内部 shard，必须由外层明确预算其总 GPU/CPU 与并发，避免形成两个独立资源仲裁器。

后续若实现 Orbit `env × policy`，可参考本项目的 READY 握手、hold 语义、向量槽位生命周期和批处理隔离。Orbit 规划使用 HTTP+JSON、文件/共享内存图像引用；本项目是 WebSocket+MessagePack，因此应写协议桥或继续原生运行，不能宣称二者天然兼容。

Orbit 的规划还要求高频媒体不进 SQLite、环境复位确认后才释放租约、复位失败隔离、真机停止确认。本项目的 SQLite step 字段与清理逻辑不提供这些全部语义，尤其不应直接作为未来真机资源管理器。[Orbit 设计 §9.5–9.8](../../design.md#95-统一轨迹)

## 14. 最小验收路线（建议，未执行）

| 阶段 | 建议动作 | 通过条件与保留证据 |
| --- | --- | --- |
| A：纯协议 | 固定提交，隔离安装最小核心；使用项目测试中的假 benchmark/echo server 路径 | HELLO、READY、序号、错误类别与 export 的测试通过；明确标记为模拟协议检查。 |
| B：单 episode | 固定镜像 digest 与资产，选择一个已支持环境、一个 task、一个 episode、原版基线策略 | 初始观测/动作变换/步数/官方 success 对齐，保存配置、日志、SQLite 与视频。 |
| C：并发 | 相同有限任务集先串行，再两个 shard，再适用时测试向量槽位 | 工作项无重复计入、无丢项；结果与固定条件串行一致，观测资源峰值。 |
| D：故障 | 主动触发模型 timeout、断连、环境不可用、记录写失败和进程中断 | 分类正确；partial 可见；仅已提交结果保留；确认哪些退出会自动重启。 |
| E：时序 | 仅对实现 hold 的环境分别测 sync/live，注入固定推理延迟 | ready 前不计运行时钟；stale/fresh、hold 和实际频率符合预期，区分语义变化。 |
| F：Orbit 包装 | 用现有外部 adapter 跑同一有限样例 | 资源不越租约；原始分数与 Orbit 有效性分开；清理确认、产物与取消路径可审计。 |

源码已有值得优先阅读的验证（均位于 `tests/`）：`test_recording_sqlite.py` 覆盖多进程、提交/回滚、导出去重和队列；`test_orchestrator.py` 覆盖 unhealthy、requeue、skipped、记录后修复；`test_vector.py` 覆盖槽位、错误和部分重置；`test_episode_ready.py` 覆盖慢初始化与旧服务兼容。[S38] [S39] [S40] [S41] [S47] [S48]

这些测试大多使用测试环境、echo server 或 mock。它们能验证框架机制，不能代替真实 simulator/GPU、模型预处理或论文成功率复现。本文也没有执行这些测试，仅检查其断言和实现。

## 15. 证据与验证边界

本次完成的只读核查包括：实际 Git HEAD/提交时间/工作区状态、核心调用链、协议、三个 runner、模型队列、SQLite schema/提交顺序/导出、容器参数、分片脚本、LIBERO/OpenVLA 适配样例以及对应测试。未建立“所有环境与所有模型”的完整审计清单。Orbit 相对链接指向仓库现行文档，结论基线固定为开头列出的完整 Orbit SHA；`#95-统一轨迹` 对应该版本标题 `### 9.5 统一轨迹` 的 GitHub Markdown 锚点。

| 检查 | 状态 | 边界 |
| --- | --- | --- |
| 实际 clone 的 HEAD、提交日期与文件存在性 | passed | 作为本文源码快照依据。 |
| 关键实现与测试静态交叉核查 | passed | 证明代码与预期断言存在，不证明运行通过。 |
| 上游单元/集成测试 | not_run | 本次任务限定静态研究，不安装依赖。 |
| 真实模型、仿真、GPU、Docker | not_run | 未下载权重/资产，未启动运行。 |
| Orbit adapter 实现与运行验证 | not_run | 本文是实现调研，未修改执行代码。 |

“未发现”的能力限定于本提交已检查的核心执行、资源、服务和记录路径，不是对项目未来路线或所有外部部署方式的断言。下列上游引用全部固定提交；Orbit 相对链接供仓库内阅读，对照内容以开头记录的本地 SHA 为准。README 只用于项目声明与支持矩阵，机制结论以源码和测试为准。

[S01]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/README.md#L1-L95
[S02]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/pyproject.toml#L1-L63
[S03]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/benchmarks/base.py#L54-L338
[S04]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/cli/main.py#L97-L334
[S05]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/cli/config_loader.py#L11-L40
[S06]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/config.py#L133-L274
[S07]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/orchestrator.py#L166-L244
[S08]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/specs.py#L30-L137
[S09]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/orchestrator.py#L288-L427
[S10]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/runners/sync_runner.py#L25-L79
[S11]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/runners/live_runner.py#L41-L160
[S12]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/protocol/messages.py#L15-L93
[S13]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/connection.py#L19-L224
[S14]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/protocol/numpy_codec.py#L22-L76
[S15]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/base.py#L163-L220
[S16]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/engine.py#L49-L265
[S17]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/daemons.py#L169-L286
[S18]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/runners/vector_runner.py#L70-L265
[S19]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/orchestrator.py#L429-L545
[S20]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/recording.py#L36-L208
[S21]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/recording.py#L220-L314
[S22]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/recording.py#L520-L592
[S23]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/results/collector.py#L50-L184
[S24]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/results/export.py#L39-L223
[S25]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/orchestrator.py#L246-L274
[S26]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/scripts/run_sharded.sh#L1-L153
[S27]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/watchdog.py#L18-L75
[S28]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/docker_resources.py#L46-L219
[S29]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/cli/_docker.py#L125-L394
[S30]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/docs/runtimes.md#L1-L51
[S31]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/configs/benchmarks/libero/smoke_test.yaml#L1-L18
[S32]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/api.py#L74-L224
[S33]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/benchmarks/libero/benchmark.py#L179-L324
[S34]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/openvla.py#L77-L143
[S35]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/runners/base.py#L21-L129
[S36]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/serve.py#L357-L478
[S37]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_collector_errors.py#L1-L27
[S38]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_recording_sqlite.py#L559-L701
[S39]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_orchestrator.py#L874-L1030
[S40]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_vector.py#L172-L306
[S41]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_episode_ready.py#L89-L210
[S42]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/predict.py#L13-L107
[S43]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/daemons.py#L491-L599
[S44]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/orchestrator.py#L667-L713
[S45]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/recording.py#L397-L411
[S46]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/model_servers/serve.py#L159-L246
[S47]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_recording_sqlite.py#L767-L842
[S48]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/tests/test_recording_sqlite.py#L430-L558
[S49]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/LICENSE#L1-L10
[S50]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/configs/model_servers/db_cogact/libero.yaml#L1-L10
[S51]: https://github.com/allenai/vla-evaluation-harness/blob/cc260841a0a32be778ec8604504de4bd5e663a5f/src/vla_eval/cli/main.py#L336-L347
[O01]: ../../design.md#9-跨场景评测规范规划
[O02]: ../../status.md
