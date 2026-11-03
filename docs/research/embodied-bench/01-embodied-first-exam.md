# Embodied First Exam：Harbor 上的具身任务、仿真服务与可信评测实现

调研日期：2026-11-03。性质：固定版本源码审计与接入设计依据；未进行运行验证。

- 上游：[mll-lab-nu/embodied-first-exam](https://github.com/mll-lab-nu/embodied-first-exam)。
- 完整提交：`9dfae8611326c4f159ebe2211cb9b71a92139406`。
- 提交时间：`2026-11-03T04:10:20-07:00`，按 Git 原始时区保留。
- 提交主题：`Agent-ended episodes (optional, protocol v2.2); RoboDojo standard uses them with RoboDojo's step limit (#520)`。
- RoboTwin 子模块锁定：`6dde57155eafa3e4ebf6ad1f93a7cf7d5d41a755`；本次以 EFE 适配层为主要研究对象。
- 本文中的源码链接全部固定到上述 EFE 提交；不会随着 `main` 漂移。
- Orbit 对照提交：`3e92a17821552b1cc76e5af25e94ca2bce7300d0`；依据 [design.md](../../design.md)、[status.md](../../status.md) 与相关实现，§9 仍是规划。

## 1. 定位：评测对象、已有能力与边界

EFE 的直接评测对象是**会写代码、运行程序并根据机器人反馈迭代的 coding agent**。
它把仿真机器人任务包装为 Harbor task；agent 可以写控制代码、调用客户端、读取图像并改进策略。
因此它不是只接受一个预训练 VLA checkpoint 的统一榜单，也不是独立的 GPU 集群调度器。[项目定位与入口][r01]

固定版本 README 声明 35 个 benchmark、1,154 个基础任务、2,260 个模式目录；core 选择 455 个任务的默认模式。
这是该提交的任务清单口径，不应解释成 2,260 个独立场景，也不代表每个目录都做过本次实测。
`core`、`validated`、`oracle` 和交互模式分别描述选择集、验证状态、正例证据与接口条件。[任务集合][r02]
本次只读遍历 `tasks/*/*/task.toml` 与 `docs/core_set.toml`，确认上述数量；模式目录为 privileged 1,034、standard 1,142、standard-realtime 84。

其高价值部分包括：

- Harbor 格式的物化任务目录与统一运行入口。
- 按仿真器封装的镜像、冻结实例、任务说明和评分器。
- 隔离的 robot-as-a-service 接口、多模态观察与动作块。
- 在线可信判定、轨迹日志、视频、故障恢复和资源监控规则。
- 固定配置、任务 digest、基础设施失败分类与结果发布脚本。

边界同样明确：没有证据表明本仓库提供完整的多租户集群控制平面、跨节点 GPU 容量账本或真实机器人预约系统。
真实设备的安全停机、物理复位、人类确认、校准资产管理也不属于本次所核验的实现。
项目把仿真服务生命周期交给 Harbor/容器运行时，把机器人动作语义和可信判定留在 benchmark 适配层。

按 README 与任务目录，可将覆盖范围概括为下列主要类型；这是任务内容分类，不是本次运行验证结论。[原创套件][r47] [改编 benchmark][r48]

| 主要类型 | 代表 benchmark | 典型评测内容 |
| --- | --- | --- |
| 桌面与双臂操作 | RoboTwin 2.0、MetaWorld+、RoboDojo | 抓取、摆放、装配、关节物体操作 |
| 家庭与长程任务 | BEHAVIOR-1K、RoboCasa、BiGym 2.0、VLABench | 多物体、多步骤的家庭场景执行 |
| 精细操作与复杂物体 | RoboARC、DexHandExam、DexToolBench、RoboPaint | 绳布/装配、灵巧手、工具、绘画 |
| 全身运动与动态交互 | HumanoidBench、RoboDynamicExam、Embodied Olympics | 运动控制、移动目标、竞技与对手 |
| 科学实验自动化 | LabUtopia、AutoBio | 实验室操作与实验任务流程 |
| 安全、空间及工程适应 | Embodied Safety Exam、iSpatialGym、roboEngineer | 风险识别、视觉空间目标、隐藏动力学下的控制改进 |

同一 benchmark 可能横跨几类；表中名称来自上游套件，不意味着直接运行其原始官方 runner。
目录存在也不等于 oracle/真实 Agent 已验证；是否纳入 core、是否 validated、提供哪些模式必须逐任务读取。

## 2. 需要纠正的 Harbor 理解

**“Harbor 在具身上根本不适用”这个绝对判断与本仓库实际代码不符。**
EFE 已把 coding agent 放进 Harbor 主容器，把仿真器放进 sidecar，通过 HTTP 客户端提供观察和动作，再通过 verifier 归一化结果。
它证明了“容器 + CLI agent + collect hook + verifier”足以承载相当复杂的具身评测。[任务实例][r03] [Compose 实例][r04]

更准确的判断是：Harbor 的任务抽象能够作为外层封装，但具身领域语义需要 EFE 自己补齐。
动作时钟、相机标定、动作块、隐藏成功信号、轨迹账本、恢复和视频可信度都不是从一个 `test.sh` 自然得到的。
Harbor 的容器上限与并发参数也不等于基于空闲容量的 GPU placement；官方运行文档明确要求 runner 自己决定 packing。[资源边界][r05]

对 Orbit 的启示是复用任务、环境协议与评分规则；保留自己的 Run、租约、有效性和清理状态。
这与 Orbit §9.10 不复用 Harbor trial runtime 的规划可以相容。
把完整 Harbor 放进 Orbit 再开任意子容器，不能自动满足当前资源隔离和唯一执行路径约束。

## 3. 代码地图：从哪里开始读

| 路径 / 入口 | 实际职责 | 不能据此推断的能力 |
| --- | --- | --- |
| `pyproject.toml` | 安装 `efe`、固定 Harbor 0.23.0、装载 CLI hook | 不包含完整任务集 |
| `scripts/efe.py::run` | 选集、筛模式、生成 Harbor 配置、处理镜像和 Podman | 不自建 trial 执行引擎 |
| `scripts/efe_harbor_hook.py::_Finder` | 在导入 Harbor CLI 时包装 `app` | 不是 Harbor 原生内置 benchmark |
| `tasks/<benchmark>/<task>/` | 物化的可运行 Harbor task | 不是通用动态 loader 接口 |
| `embodied_first_exam/benchmarks/` | benchmark 共享仿真适配器 | 不统一各模拟器所有内部语义 |
| `embodied_first_exam/standard/` | 客户端、二进制封包、受限服务、恢复基础层 | 不直接实现每个任务的成功条件 |
| `standard/v2_1/`、`v2_4/` | 特定协议实现与兼容文件 | 目录版本不等于全库任务都升级 |
| `standard/realtime/` | 连续时钟、动作计划、watch、迟到与 stall 记录 | 不是硬实时控制系统 |
| `standard/agent_end/` | 可选主动结束、隐藏成功信号、步数预算 | 未启用的任务不具有这一语义 |
| `images/monitor/rcb_monitor/` | 监控、监控注入、资源证据验证与输入清理 | 不提供全局任务排队和资源租约 |
| `scripts/task_conventions.py` | 规范化、资源声明、配置指纹、任务 digest | 调用 `normalize` 会修改任务，非只读 lint |
| `scripts/run_agent_batch.sh` | 批量调用 Harbor、claim、结果整理 | 不是可恢复的数据库队列 |
| `scripts/retry_policy.py` | 重试判定与序列审计的纯函数 | 规则存在不代表自动重试驱动接通 |

目录和函数位置由源码核对；后文逐项追踪实际调用。[CLI 实现][r06] [规范化实现][r07]

## 4. Harbor 依赖、wheel 与入口包装

`pyproject.toml` 固定 `harbor==0.23.0`，Python 范围为 `>=3.12,<3.15`。
`[project.scripts]` 注册 `efe = "efe:main"`。
wheel 只装 `scripts/efe.py`、`scripts/efe_harbor_hook.py` 和 `efe-harbor.pth`，任务在运行时定位或克隆。[安装契约][r08]

`.pth` 导入 `efe_harbor_hook`；`_Finder.find_spec()` 只拦截 `harbor.cli.main`。
模块原本执行完后，hook 保存原始 `module.app`，将它替换为 `harbor_app()`。
无显式调用参数且命令行为 `harbor run` 时，转到 `efe.run(sys.argv[2:], app=app)`；其他调用仍走原 app。
因此它既有 `efe run` 独立入口，也扩展同一环境内的 `harbor run`，并且依赖 Harbor CLI 的内部结构。[hook 全文][r09]

`efe.find_root()` 依次考虑 `EFE_ROOT`、当前目录祖先、editable 安装所在位置和缓存 checkout。
`cached_clone()` 尝试安装版本对应的 Git tag，tag 不存在时退回 `main`。
所以单独记录 PyPI 版本不足以复现任务：必须同时记录实际 checkout SHA、任务 DIGEST 和容器镜像 digest。[任务定位][r10]

`efe.run()` 的核心流程：

1. 把 `-d embodied-first-exam[@core|@all]` 转换为 EFE 集合选择。
2. 根据 core/all、mode、benchmark、include/exclude/path/limit 选任务。
3. 用 `stamp()` 设置内容相关 mtime，避免相同尺寸及时间戳导致构建缓存误用。
4. 预拉 Harbor 网络探测/egress 镜像，降低首次拉取使短探测超时的风险。
5. Podman 模式按需拷贝任务并改写 NVIDIA 为 CDI、替换可用的预构建层。
6. `config_file()` 按 benchmark 目录组织 Harbor datasets，因为此处不能假定 Harbor 递归找目录。
7. 调用原始 Harbor app：`harbor(["run", "-c", cfg, *rest], app)`，最后清理临时副本。

这些都是包装与兼容逻辑；真正的 agent 安装、trial 生命周期、容器构建和 verifier 执行仍交给 Harbor。[运行路径][r11]

以下三条使用上游 README 命令形式和已核验的 `--list` 分支；**仅作操作示例，本次均未执行**。
示例假定已安装对应环境、位于固定 checkout；单任务 oracle 会实际构建/启动仿真，不能当作只读检查。[官方运行示例][r49] [选择列表实现][r50]

```bash
# 查看 core 默认选择集
harbor run -d embodied-first-exam --list
# 查看 RoboTwin 的 standard 任务选择集
harbor run -d embodied-first-exam@all -p tasks/robotwin-2 --standard --list
# 用 oracle 运行一个具体任务
harbor run -d embodied-first-exam@all -p tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard -a oracle
```

## 5. 三种模式与两个“版本”轴

必须区分**任务协议 v2.2**和**wire service protocol `eai-standard/2.x`**。
本次 HEAD 新增的 agent-ended episode 属于任务协议的可选行为；不能据此认定所有任务都使用网络协议 2.2。
样例 RoboTwin standard 仍明确写 `eai-standard/2.1`。[模式规范][r12] [样例元数据][r03]

| 模式 | Agent 可访问什么 | 时间如何前进 | 分数从哪里来 |
| --- | --- | --- | --- |
| `privileged` | 任务允许的模拟器/实例/工具，可调试控制程序 | 由其本地仿真代码推进 | 隔离 verifier 复现交付物并评分 |
| `standard` | 客户端、RGB/RGB-D、proprioception、声明的标定/动作接口 | `submit` 或正时长 `observe` 推进；思考时通常暂停 | 可信 sidecar 已执行的在线 episode |
| `standard-realtime` | 同样受限的视觉/机器人接口 | 首次驱动后持续按控制时钟推进，agent 思考时也继续 | 同一在线 episode；记录动作迟到与时钟偏差 |

privileged 是**评测访问权限模式**，不能误解为 Docker 的 `--privileged` 标志。
standard 的 reset 由每个任务声明预算；本报告的 RoboTwin 样例明确无 reset，不能统一假定所有 standard 都允许。
standard 是否早停、是否隐藏成功信号、是否让 agent 主动结束，也必须从 spec、metadata 和具体适配层读取。

`eai-standard/2.4` 增加 operation id、请求 deadline、状态查询及 watchdog。
此前 depth、kinematics 和 realtime 的能力仍是可选：2.2 服务加入 operations 可以声明 2.4。
所以不能把版本数字简单理解成“2.4 必然连续实时”。[2.4 版本定义][r13]
清单还有少数 `eai-standard-realtime/1.0`、`eai-standard-turn/1.0` 和 `eai-policy/1.x` 声明。
后文重点是共享 2.x 与 RoboTwin 路径，不能据此宣布所有 2,260 个目录拥有相同接口。

## 6. 一个完整任务：RoboTwin stack_blocks_two-standard

样例路径：`tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/`。
冻结 seed 为 `60417`，机器人为 `aloha-agilex`，task type 为 trajectory，oracle 标记 full。
目录中的 `task.toml`、instruction、环境 Dockerfile/Compose、sim 代码、tests 与 solution 共同构成可复现单元。[任务定义][r03]

`task.toml` 声明三类产物：

- agent 的 `/app/output/`。
- sim 的 `final.json`、`episode.jsonl`、`trajectory.npz`、`trajectory_live.f64`、calls、startups。
- 用于审阅的视频/图片/时间线，以及 monitor 的独立资源证据。

verifier 设置为 `environment_mode = "separate"`、`network_mode = "no-network"`。
agent 则是模型 API 和软件包站点 allowlist；把这改成公共网络属于条件改变，不是等价兼容。
verifier 环境还接收 `RCB_LIMITS_ENFORCE` 模板变量，Orbit 当前解析器对这类替换也有边界。[任务配置与 hooks][r03]

Compose 中 `main` 依赖 `sim`；主容器只带 Python 客户端。
`sim` 在 `/opt/RoboTwin` 执行 `python /srv/server.py`，持有冻结实例和真实成功判定。
它有 CPU/memory/pids 上限、8 GB shm、NVIDIA 单卡 reservation、`x-gpu-memory-gb: 13` 和 `restart: on-failure:6`。
`rcb_monitor` 使用 host PID/cgroup、`SYS_PTRACE`、共享 named volumes、无网络和独立资源上限。[Compose][r04]

注意共享命名空间：该 Compose 注释明确说 Harbor egress 控制下 sim 与 main 共用网络 namespace，因此也可走 `localhost:8000`。
不能只把 `sim` 改为另一个普通桥接网络 service，便声称网络与隔离语义完全一致。
客户端同时尝试 `SIM_URL`、`sim:8000` 和 `localhost:8000`，只解决寻址兼容，不替代隔离审计。[客户端连接][r14]

agent Dockerfile 从 files-only 镜像复制 `rcb1.py` 和特定版本客户端；sim Dockerfile复制 benchmark 共享代码。
共享代码镜像使用 digest 固定，RoboTwin 基础环境示例仍引用 `efe:robotwin-0.1.2` tag。
因此本地部署应记录所有最终解析的 image digest，不能把部分 digest pin 夸大成整个供应链不可变。[agent 镜像][r15] [sim 镜像][r43]
本次对 robotwin-2-files 的 2 项、standard-files 的 15 项 manifest 内容 hash 做只读核对，均与当前源码一致。
这证明源码与仓库 manifest 对齐；没有拉镜像，不能据此声称已核验 registry 中真实镜像层。[RoboTwin 清单][r44] [standard 清单][r45]

## 7. 从观察到动作：接口与数据面

通用 `rcb_client.Robot` 在构造时等 `/spec`，默认等待上限 3,600 秒；源码明确等待也消耗 agent wall-clock。
它读取 action space、control frequency、camera、能力标记与 service 的单次调用预算。
`submit()` 把动作转为 float32 的二维数组，`dt` 默认来自 `control_hz`；`get_obs()` 请求当前帧或一段 hold 观察。[客户端 API][r14]
以上是共享 2.2 客户端；RoboTwin 样例实际复制 `v2_1/variants/af20f7b98f/rcb_client.py`。
该 variant 的连接等待默认 600 秒、`submit` 默认 `dt=0.02`；迁移应跟随 Dockerfile 固定的版本，不能悄悄换成最新客户端。[样例客户端][r46]

接口边界不是随意执行 Python：标准服务主要暴露 `/spec`、`/status`、`/observe`、`/submit`。
可选 `/kinematics` 为无状态 FK/IK；reset 受任务声明约束；agent-ended 扩展才有 `/finish`。
RoboTwin 自有 `H` handler 对未声明路径返回错误，`do_submit()` 校验动作类型、维度、有限值、时间步倍数、chunk 和帧预算。[RoboTwin handler][r16]

观察内容包括 RGB 视频/帧、可选深度、相机参数及机器人自身状态。
服务协议禁止把物体真值位姿、分割标签、任务隐藏状态等作为捷径泄漏给 standard agent。
这里的“受限观测”依赖 spec 检查、适配器实现和镜像清理共同维持，不能只靠一个客户端类保证。[受限接口规范][r17]

RCB1 是数据封包格式：magic `RCB1`、小端 header 长度、JSON header，再接原始二进制 blobs。
图片、MP4、typed array 等分别携带类型与元数据，避免把所有图像/数组都 base64 塞进 JSON。
`Result` 可把内容保存成图片、视频、JSON、NumPy 数组；不是每次 HTTP 返回都要求进程外共享目录。[RCB1][r18]

对 Orbit 的协议设计，直接把大数据改为统一 JSON 或只保留一张 screenshot 都会丢失语义。
合理边界是控制面归一化，原始 RCB1/视频/数组作为外部产物保留，另写索引与时间对齐信息。
动作应记录 type、shape、单位、坐标系、dt、实际执行行数；“发出了动作”不能等同“全部动作已执行”。

## 8. standard 的可信评分与结束顺序

RoboTwin `do_submit()` 逐步驱动物理、记录动作及事件、调用任务 `check_success()`，完成调用后 checkpoint。
`do_observe(seconds > 0)` 则持有当前命令并推进物理；零时长观察不推进 episode。
sidecar 的 `finish()` 调用正在运行的环境成功条件；不是等 verifier 开新仿真后重新判断。[在线执行][r16]

结束不是单一 `timeout_sec`：

1. agent 停止产生有效动作；样例专门对 main 执行 `kill -9 -1`，避免后台脚本在采集窗口继续控制。
2. collect hook 给 sim 发 `SIGUSR1`，必要时等待 sidecar 从 journal 恢复。
3. `finalize()` 先 flush 轨迹、保存状态 hash 和 `finalized: true`、`graded_by: live` 的 verdict。
4. verdict 落盘后才开始视频渲染；video 失败只记附加错误，不能改写成功判定。
5. Harbor 收集 sim 证据到独立 verifier；grader 读取可信 `final.json` 写 reward。

monitor 的 seal、主容器停止、sim finalize 在同一生命周期中各有责任；迁移时必须核对实际执行顺序。
尤其不能在 agent 还能发命令时读取一个“最终”状态，也不能先销毁 sim 再尝试在线评分。[collect hooks][r03] [finalize][r19]

样例 `tests/grade.py::main()` 要求 `graded_by == "live"` 且 `finalized`。
缺失、不可读、未完成 verdict，instance mismatch、resume failure 等归为 infra；真实任务失败保留为 0。
该 grader 的 `replays` 字段固定为 0；复制视频失败不影响分数。[standard grader][r20]

**在线评分不能用事后重放替代。**
重放可用于视频和证据审计；物理不完全确定时，重放成功与原 episode 成功可能不同。
Orbit 未来 `env` 的 rescore 应采用 evidence 语义，这一点与其 §9.6 规划一致。

## 9. privileged 的评分链路与隔离

同一 RoboTwin 基础任务的 privileged 版本让 agent 使用 `rcb_traj.Session` 调试并输出 `trajectory.npz`。
verifier 使用自己镜像中的冻结 instance 与可信代码，清理旧 reward、清理非可信产物，再执行 `grade.py --repeat 2`。
该具体 task 明确做两次 replay；不能把“两次”泛化到所有 benchmark，因为协议允许任务声明特定例外。[privileged 入口][r21]

`load_deliverable()` 使用 `np.load(..., allow_pickle=False)`，校验 family、shape、长度和有限值。
`main()` 重放动作，要求每次成功且最终 `state_sha` 完全相同，再原子写 `reward.txt` 与 numeric-only `reward.json`。
若没有交轨迹，先 `probe_instance()` 判断当前环境能否重建冻结场景，避免把平台无法启动误记为 agent 失败。[privileged grader][r22]

agent 侧调试日志只用于成本统计，源码明确标记 `agent_cost_self_reported = 1`。
重建出的 agent rollout 视频也明确标注 `self_reported`；不能把它升级成可信评分证据。
视频在 verdict 之后生成，具有独立 deadline，避免渲染耗尽 verifier 总时限导致已判定结果丢失。[后置视频与成本][r22]

`rcb_limits.py::sanitize()` 删除逃出产物根目录的 symlink、FIFO/socket 等非普通文件，并限制 session log。
它降低恶意或意外产物阻塞/越界读取的风险；不代表 agent 文件成为可信数据。
协议要求 policy 交付物在无网络、无 simulator/evaluator 访问权限的独立低权限进程中执行。[产物清理][r23] [隔离不变量][r24]

## 10. realtime 与 agent-ended 的实际含义

`RealtimeService` 内部有独立计划队列、held target、watch 请求与 clock 状态。
首次推进后，`due_in()` 决定下一控制 tick；`tick()` 消费计划行，无动作时执行 hold。
控制循环优先处理到期 tick，再处理请求；agent 的“思考时间”因此影响机器人继续运行的状态。[实时执行][r25]

如果调度落后超过阈值，代码重新设置时钟锚点，记录 `stall` 与滞后时间，不用突然快进补齐全部欠下的物理步。
`submit` 主要安排未来动作、替换计划尾部；`observe` watch 不应暗中改写动作计划。
这是尽力而为的墙钟对齐仿真，并非硬实时保证；CPU/GPU争用和慢渲染都可能改变实验条件。[实时协议][r26]

HEAD 的 agent-ended 扩展由 `RCB_AGENT_END=1` 开启，可配正整数 `RCB_STEP_LIMIT`。
`hidden_success()` 记录当前状态是否成功，不把“曾经成功”自动锁存为最终分数；返回值隐藏成功相关字段。
`POST /finish` 结束 episode，之后动作调用返回 409；未显式结束则在 session/cutoff/step limit 结束时判定最终状态。
启用扩展但适配器没有 `finish()` callback 时直接拒绝启动，避免只声称支持而没有正确终止实现。[agent-ended 实现][r27]

因此评测记录必须保留 `success_signal`、`ended_by`、step limit、结束时刻与隐藏成功首次出现信息。
同一个场景改成 hidden-success + agent-ended 后，agent 的停止决策成为被评测能力，分数不应与自动成功早停版本混合。

## 11. 恢复、重试与操作幂等：三层不同机制

**第一层：同一 episode 的进程崩溃恢复。**
RoboTwin sidecar 有有界 resume 次数；读 `trajectory_live.f64` 与 checkpoint，恢复最后完成的调用。
截断未完成调用产生的 journal 尾部，重新执行历史动作，并对最终 state hash 做严格一致性检查。
若无法恢复，记录 `resume_failed`；它不是换 seed 后给 agent 一次新机会。[RoboTwin 恢复][r28]

共享 `Episode.begin()` 支持 exact/approx 恢复类别，记录 state hash、TCP/joint deviation、恢复次数和 downtime。
exact 模式不允许 hash 不同；approx 模式也有声明的误差边界。
恢复保留首次请求时间，不能重置 agent 时间预算。某一适配器是否支持近似恢复必须看其配置，不能把共享能力泛化到全部任务。[共享恢复][r29]

**第二层：HTTP 超时后的操作可判定性。**
2.4 的 handler 先验证 operation id/deadline，再持久化 admitted 状态；重复 id 返回 409，过期未开始请求返回 408。
结束写 completed/error；恢复后在途操作可变为 interrupted，并显式标记 execution_uncertain。
客户端应查询 `/operations/<id>`，而不是拿新的 id 盲目重发同一动作。[operations 实现][r30]

hard watchdog 依据服务自己的 `max_call_wall_s + grace`，不会因为 agent 给了短 deadline 就杀死 simulator。
只有 watchdog 独立 trace 的触发证据才归类为 `call_watchdog`，普通 crash 留下 marker 不足以推断超时。
这是防止 agent 借请求超时制造“免费基础设施重试”的具体防护。[watchdog 实现][r31]

**第三层：整个 trial 作废后的基础设施重试。**
`retry_policy.decide()` 允许首次 infra failure 清空环境后重跑一次，普通失败/成功不重跑。
`SAME` 包含 digest、seed、mode、cutoff、reset budget、slowdown、network 和 protocol version。[重试规则][r32]

但本次查到的实现不能支持“批处理已经自动完成全部重试流程”的结论：

- `run_agent_batch.sh` 的执行循环直接调用 Harbor，没有调用 `retry_policy.decide()` 的可见分支。
- `write_task_results.py` 调 `check_attempts()` 做结果审计，但传入的列表只有 outcome，没有 config。
- 因而该发布路径能审计次数与失败类型，不能靠这次调用验证各 attempt 的 seed/config 完全一致。
- batch 的 `result.json` 从 job 开始就存在；重启脚本据此跳过，源码要求人工移走中断 job 与 claim 才重跑。

文档/函数注释说 runner scheduler 应调用规则，但已审计的 batch 驱动存在接线证据缺口。
Harbor 依赖内部可能另有重试行为，本报告未审计其源码，不能拿它补足 EFE 特定规则的实现证明。[batch 驱动][r33] [结果审计][r34]

## 12. 资源管理、排队及时间预算

EFE 资源声明是每个容器的上限：main、sim、monitor、verifier 分别处理。
`normalize_resources()` 与 monitor 注入把规则写入 task/Compose；GPU 的可见设备通过 Compose reservation，显存预算通过扩展字段表达。
`x-gpu-memory-gb` 本身不是 NVIDIA 硬件隔离，也不构成全局 GPU 容量预留。[规范化资源][r07] [资源说明][r05]

monitor 每 5 秒采样资源、每分钟统计磁盘，seal 后由 verifier 使用可信 caps 重新计算超限。
默认 `RCB_LIMITS_ENFORCE=0` 记录监控，由容器 runtime 执行其能执行的限制；设为 1 才启用 monitor backstop。
缺失、未 seal、覆盖不足的监控在强制模式下成为 infra；当前 `resource_limit_exceeded` 固定为 0，超限不自动等同任务失败。[资源验证][r35]

host OOM、service OOM、agent 正常失败、pool 操作中止需要分别分类。
不能为了接入方便统一映射成 `score=0`，也不能把所有 simulator crash 都宽松视为 infra 并无限重跑。
这些条件是评测协议的一部分，而不仅是 Web 展示字段。

batch 的轻量“队列”是多个 shell lane 对 job 名执行 `mkdir` claim，另一模式则直接设 Harbor `-n` 并发。
没有查到根据全节点空闲 GPU/CPU/memory 做 admission 的容量账本，也没有超时 claim 自动回收的持久状态机。
它可以帮助单批次避免重复领取，不能直接替代 Orbit 已有的租约队列。[batch claim][r33]

`scripts/mem_guard.py` 扫描主机可用内存，并按名字/镜像正则挑选最大容器执行 `docker kill`。
它不是 Orbit label 范围内的操作；不应未经改造纳入共享主机 Orbit 执行路径。
这项结论来自具体候选匹配与 kill 实现，本次未启动该脚本。[mem_guard][r36]

样例时间预算分别为：

| 阶段 | 配置 | 解释 |
| --- | --- | --- |
| 环境 build | 1,800 s | 镜像构建预算 |
| agent | 1,800 s | 解题/操作时间，不含所有后处理 |
| monitor collect | 120 s | seal 资源证据 |
| main collect | 30 s | 阻止后台动作继续 |
| sim collect | 2,260 s | 等在线 verdict 与后置视频，内部 verdict 等待上限 840 s |
| verifier | 1,200 s | 独立验证/写 reward |

调度和租约不能在 agent cutoff 时立即释放，因为 simulator finalize、视频和 verifier 仍可能占用 GPU/内存。
服务自己的 first-request clock、monitor 从环境启动算的保守 clock、Harbor agent timeout 也不是同一个起点。[样例预算][r03] [客户端时钟][r14] [monitor 时钟][r05]

## 13. 证据、视频、结果与可比性

standard 的可信事实链是：sidecar 输入校验 → 实际执行动作 → journal/checkpoint → 在线成功判定 → finalized verdict → verifier reward。
agent 自报的脚本日志位于另一信任层；网络请求的发送记录也不自动证明 simulator 完成执行。
产物索引应标注 producer、trust、episode/call/step、wall/sim time 和是否完整。

“live.mp4”文件名不能当作实时拍摄证据。
当前运行文档明确：很多 standard 视频默认在 verdict 后根据轨迹渲染，`final.json.video_source` 标明 live 或 render。
RoboTwin 的 `live.mp4` 默认也是后置 call-stamped replay；只有指定模式才在 episode 内捕获。[录像规则][r37]

`task_conventions.effective_config()` 保存 protocol、mode、cutoff、reset、slowdown、seed、network、validated、set、oracle、service protocol 与 digest。
`config_key()` 的排名分组键是其中一个子集，不包含 seed，也不等同 task digest 校验。
因此 Orbit 不能只复制 config_key 就声称内容版本一致；应独立保留源 commit、任务 digest、镜像 digest 和运行修改。[配置键][r38]

`digest()` 按相对路径与内容 hash 计算，覆盖 task.toml、instruction、README、trajectory 以及 environment/tests/solution/steps 文件。
这意味着修说明、改资源、换 verifier 或 oracle 都可能改变 digest。
batch 修改 CPU cap/egress 的副本时另记 source/copy digest；迁移也应记录变更，不能隐藏“兼容修补”。[digest][r39] [副本记录][r33]

结果发布把 success、fail、not_a_result 分开；缺 reward、grader/infra 错误、非 agent cutoff 的 Harbor 异常、模型账号/网关失败另行归因。
`write_task_results.py` 会保留 attempts，但它不是 Orbit execution/validity/cleanup 三态的直接替代结构。
导入时应明确映射且保留原始 reward，不把数值 `infra_error=1` 一起塞进均值评分。[分类实现][r34]

## 14. 新 benchmark / 新任务的扩展路径

上游推荐从最接近的 privileged/standard 对开始，创建物化任务目录。
任务生成器、instance freezer、oracle 搜索程序不进入本仓库；交付物是冻结任务与运行所需文件。
公共 simulator/adapter 代码可进入 `embodied_first_exam/benchmarks/<benchmark>`，最终通过镜像固定复制进入任务。[贡献规范][r40]

建议按下面顺序建立本地扩展：

1. 明确评测 coding agent 还是固定 policy，选模式及可观测状态，声明成功/结束语义。
2. 固定场景与 seed，定义动作单位、控制频率、camera/depth/proprio 和 reset 条件。
3. 完成 task.toml、instruction、environment、tests、solution 及正例证据；删除 agent 可访问的上游答案。
4. standard 把 scene/success 放在 sidecar；privileged 把可信 replay/scorer 放进独立 verifier。
5. 在资源规则中给每个容器上限，声明 GPU 类型/显存/图形能力，不能只估主容器。
6. 定义在线日志、轨迹、视频来源、最终 verdict 的落盘顺序和崩溃恢复类别。
7. 使用规范化工具生成资源监控与说明并更新 DIGEST；这属于有修改的 authoring 阶段。
8. 执行 task 字段、隔离、协议、digest 等检查，然后分别跑 oracle、empty 和崩溃/截止场景。
9. 仅在实际通过后更新 validated/oracle 状态；缺正例不能用 README 宣称代替证据。

本次没有执行这些 authoring 或仿真验证；此处是从上游契约整理的接入步骤。

## 15. 部署依赖与许可

EFE 自有代码采用 MIT；Python 包固定 Harbor 0.23.0，Linux x86_64、git、Docker Compose/BuildKit 为主要运行路径。
GPU 任务需要 NVIDIA 驱动与 Container Toolkit；另有 rootless Podman 路径，但会对任务副本做 CDI/镜像兼容转换。[许可][r41] [宿主依赖][r42]

不是所有 benchmark 的 GPU 条件相同：部分依赖 RTX/RT cores，部分可用一般 NVIDIA 卡，部分只需 CPU。
镜像和资产体积可很大，首次构建也可能隐含接受上游模拟器/数据条款。
EFE 的 MIT 不覆盖所有 simulator、assets、BEHAVIOR 数据或 Isaac Sim 组件；非商业条款和手工下载步骤需逐 benchmark 核对。[外部依赖表][r42]

本次没有拉取镜像、下载数据、安装包或接受任何新增运行时条款。
上游子模块的锁定只证明源代码版本关系，不证明其运行资产已齐全。

## 16. 与 Orbit 当前实现、§9 规划的具体差距

以下“现有”依据当前 Orbit `docs/status.md` 与对应 TypeScript；“规划”依据 design §9，不把后者算作能力。

| 能力 | EFE 固定提交 | Orbit 当前 | 接入结论 |
| --- | --- | --- | --- |
| Harbor task | 原生外层格式 | 已有内置 Harbor adapter | 可复用解析思路，但非所有字段可接 |
| sidecar | GPU sim + monitor | service CPU/memory/网络/产物/hook 已有 | GPU/device 给 service 仍缺 |
| GPU placement | 容器设备声明、runner packing | 主 Run GPU 租约与排队已有 | 保留 Orbit admission，扩展 service 请求 |
| Compose | named volumes、deploy、restart、host PID/cgroup | 明确拒绝这些未支持设置 | 不能原样导入该样例 |
| 网络 | agent allowlist、verifier 无网络 | 无 allowlist 支持；有限 Compose 子集 | 需支持或拒绝并声明偏差 |
| 在线环境 | RCB 服务与场景适配器已有 | 通用 `env` kind 未实现 | 这是 §9 P3/P5 的实质工作 |
| 轨迹 | agent 原生日志 + sim journal/video | GUI 样例轨迹及产物审阅已有 | 统一轨迹/RCB 导入仍规划 |
| 恢复 | sidecar 有界 journal replay | Run 有有限文件/session checkpoint | 两者语义不同，不能互相宣称覆盖 |
| 重评 | standard 复核在线 verdict，不能重做物理判分 | 文件型 bench rescore 已有 | env 应新增 evidence 语义 |
| 环境复用 | trial 容器为主 | env 暖池、quarantine 未实现 | 不要把 EFE restart 当成池化 reset |
| 真机设备 | 本报告未见通用设备 provider | reserve/reset/stop/release 为规划 | 不能借仿真任务宣称真机支持 |

Orbit 本地实现依据：[compose.ts](../../../packages/orbit/src/bench/compose.ts) 的允许键/拒绝分支（28–59、199–240 行）、[harbor.ts](../../../packages/orbit/src/bench/harbor.ts) 的 unsupportedSettings（183–212 行）；
[contracts/runs.ts](../../../packages/orbit/src/contracts/runs.ts) 的 ServiceSpec 与 leaseRequest（56–95、352–359 行）；[runs/services.ts](../../../packages/orbit/src/runs/services.ts) 的 serviceContainer（137–168 行）。
其中 `serviceContainer()` 明确写 `gpuIds: []`，`leaseRequest()` 只累加 service 的 CPU/memory，故 GPU sidecar 缺口有直接代码证据。

最值得直接吸收的是**可信 sidecar 在线判定、停止顺序、原始轨迹证据、细粒度失败分类和配置指纹**。
最需要 Orbit 自己补的是**service GPU 资源契约、受支持的隔离/卷语义、完整租约时段、通用 env 桥接与轨迹索引**。
对 EFE 的每一项接入都应沿用现有 Run/Trial/lease，不能新增独立 Python scheduler 作为第二套事实来源。

## 17. 最小接入验证建议与本次验证状态

最小验证不应从 `--all` 或全量 Docker build 开始。
先挑一个依赖已明确、能保留原协议的 CPU standard task做控制面契约对照，再用上述 RoboTwin 样例验证 GPU sidecar。
如果第一步只能 privileged 跑通，应明确它验证的是 workspace/replay 路径，不能称 standard 已接通。

建议拆成四个可审阅的门槛：

1. **静态导入门槛**：列出不支持字段、所有容器资源/网络/挂载、各阶段时间预算与产物，发现不支持就拒绝。
2. **可信执行门槛**：empty 应合法失败，oracle 应成功；agent 无法直接写 sim/verifier 证据；截止后不能继续发动作。
3. **故障门槛**：分别注入 service crash、未完成动作、丢 final.json、视频失败、reset failure、cancel；检查 valid/invalid/cleanup。
4. **保真度门槛**：固定源 SHA、镜像 digest、seed、模式、时钟、资源和网络，与官方 Harbor 作配对对照后才提高级别。

官方 Harbor 运行可作为独立 parity 参考；若要让它成为 Orbit 内嵌生产路径，必须先重新讨论 §9.10 的设计边界。
目前不建议以“process backend 可以跑一个 shell”为依据声称嵌套 Compose 资源已被 Orbit 正确管理。
验证通过之前，前端应把 EFE 标为 research/unsupported 或明确部分能力，而不是显示一个可点击却改变语义的完整支持项。

| 检查 | 结果 | 证据 / 原因 |
| --- | --- | --- |
| 上游完整 HEAD、提交时间和关键路径核验 | passed | 本地 Git 与源码只读检查 |
| Harbor wrapper、样例 Compose、grader 与恢复调用链 | passed | 对照实际函数及固定源码链接 |
| 引用路径/行号与共享代码 manifest | passed | 所有固定链接本地可定位；17 项共享源码 hash 对齐 |
| Orbit 当前实现与 §9 规划分离 | passed | 已读 design/status 与相关 TypeScript |
| 全量 task/CI 测试 | not_run | 本任务为源码研究，未安装依赖或执行上游检查程序 |
| 镜像构建、GPU仿真、oracle/empty、真实 Agent | not_run | 未拉镜像/数据/模型，未运行仿真 |
| Harbor 官方结果与 Orbit parity | not_run | 尚无 EFE Orbit 接入实现 |
| 安全隔离与故障恢复动态验证 | not_run | 本文描述源码意图和路径，不声称完成实际攻击/故障注入 |

## 18. 固定版本证据索引

[r01]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L35-L39
[r02]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L131-L145
[r03]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/task.toml#L1-L74
[r04]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/environment/docker-compose.yaml#L1-L66
[r05]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/running.md#L138-L192
[r06]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/efe.py#L365-L479
[r07]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/task_conventions.py#L1842-L1861
[r08]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/pyproject.toml#L22-L49
[r09]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/efe_harbor_hook.py#L1-L33
[r10]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/efe.py#L53-L99
[r11]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/efe.py#L381-L467
[r12]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/README.md#L75-L130
[r13]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/standard_mode.md#L577-L631
[r14]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/rcb_client.py#L129-L240
[r15]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/environment/Dockerfile#L1-L7
[r16]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/benchmarks/robotwin-2/sim/server.py#L536-L667
[r17]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/standard_mode.md#L345-L395
[r18]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/rcb1.py#L1-L105
[r19]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/benchmarks/robotwin-2/sim/server.py#L105-L163
[r20]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/tests/grade.py#L1-L51
[r21]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-privileged/tests/test.sh#L1-L9
[r22]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-privileged/tests/grade.py#L75-L205
[r23]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/images/monitor/rcb_monitor/rcb_limits.py#L447-L515
[r24]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/README.md#L260-L333
[r25]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/realtime/rcb_realtime.py#L399-L465
[r26]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/standard_mode.md#L502-L576
[r27]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/agent_end/rcb_agent_end.py#L25-L148
[r28]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/benchmarks/robotwin-2/sim/server.py#L679-L726
[r29]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/rcb_limited.py#L725-L815
[r30]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/v2_4/rcb_limited.py#L997-L1141
[r31]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/v2_4/rcb_limited.py#L690-L719
[r32]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/retry_policy.py#L18-L82
[r33]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/run_agent_batch.sh#L410-L495
[r34]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/write_task_results.py#L45-L199
[r35]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/images/monitor/rcb_monitor/rcb_limits.py#L320-L418
[r36]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/mem_guard.py#L1-L78
[r37]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/docs/protocol/running.md#L199-L220
[r38]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/task_conventions.py#L1791-L1838
[r39]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/task_conventions.py#L1864-L1888
[r40]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/CONTRIBUTING.md#L20-L100
[r41]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/LICENSE#L1-L21
[r42]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L88-L128
[r43]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/tasks/robotwin-2/robotwin_2_0_stack_blocks_two-standard/environment/sim/Dockerfile#L1-L10
[r44]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/images/robotwin-2-files/FILES.json#L1-L8
[r45]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/images/standard-files/FILES.json#L1-L21
[r46]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/embodied_first_exam/standard/v2_1/variants/af20f7b98f/rcb_client.py#L68-L118
[r47]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L41-L83
[r48]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L178-L205
[r49]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/README.md#L131-L155
[r50]: https://github.com/mll-lab-nu/embodied-first-exam/blob/9dfae8611326c4f159ebe2211cb9b71a92139406/scripts/efe.py#L381-L449
