# Orbit 具身 / 机器人 benchmark 分类与直接集成规格

> 历史调研说明（2026-11-09）：本文的类别、编号与界面建议保留调研时点语义，不再定义当前产品分类。
> 公开分类采用 [design §9.17 六维 v1](../../design.md#917-benchmark-六维分类-v12026-11-09)，每个维度有独立受控取值；
> C1–C7 仅保留为历史接入原型或兼容信息。来源、原始观察及验证限制保持不变；当前状态见 [status](../../status.md)。

审计日期：2026-11-04 至 2026-11-05。范围是本地源码静态审计；未启动模拟器、未运行 policy、未执行 calibration，也未联网核验论文、排行榜或镜像可用性。本文中的“已核实”限于本地文件、配置和代码路径；运行正确性、性能、最小显存、官方结果复现均为 **未核实**。建议部分是拟议规格，**未实现 / 未核实**，不能当成 Orbit 现有能力。

证据采用文末本地绝对路径索引，正文中的每个 S 编号均可点击；链接带行号时指该结论的入口，复杂分支需顺着该文件继续阅读。README、代码注释、旧调研笔记只证明仓库有该声明；不能据此把未检查的上游实现或历史测量变成已核实事实。suite 表中的来源指本地构建配方指向的仓库、包或代码，不推断论文作者、首发机构、版权归属或正式发表情况，这些均 **未核实**。

本轮工作树快照：Orbit `b52345c980d7d6b647308613c5f94dc539a04705`；EFE `9dfae8611326c4f159ebe2211cb9b71a92139406`；vla-eval `cc260841a0a32be778ec8604504de4bd5e663a5f`；Arena `cdd5f44eda011efeab4c4dfa624fe6b6d213bce3`；OSMO `c0f208dd8fc7dfa44785a5d8fde211ae329275e3`。这些是本轮 `git rev-parse HEAD` 的读取结果，复核入口分别为仓库 [S001][S001]、[S002][S002]、[S003][S003]、[S004][S004]、[S005][S005]。开始时 Orbit 已有 `.gitignore` 未提交改动，本轮不修改这些仓库，仅生成本报告。

子模块也属于评测身份：本轮RoboTwin checkout为 `6dde57155eafa3e4ebf6ad1f93a7cf7d5d41a755`；Arena的IsaacLab为 `e3f7d9ff1f5d7f8280de3ece9000b7117f66bcf4`、Isaac-GR00T为 `e29d8fc50b0e4745120ae3fb72447986fe638aa6`，来自只读git检查；复核入口 [S006][S006] [S007][S007] [S008][S008]。不据这些commit推断所有镜像与资产已安装。

## 1. 结论：按被测对象与交互契约分三类

建议 Orbit 定义三个具身大类：**控制制品生成（EC）**、**在线具身编程（EI）**、**原生策略 rollout（EP）**。同一环境可以进入不同大类：EFE 的 LIBERO-MAX privileged 是 coding agent 产出轨迹，standard 是 coding agent 经工具调用在线操纵；原生 LIBERO 是已经给定的 policy 接收观测并输出动作。分类不由“机器人”“MuJoCo”“VLA”这些域名或模型名决定，而由 trial 正在评估什么，以及环境向它暴露什么接口决定。依据是 EFE 的模式与可信评分契约，以及 LIBERO 的 reset/step 实现。[S009][S009] [S010][S010]

step / realtime / turn、RGB / privileged state、单步 / action chunk / goal、单 episode / 多子目标 / 多案例 campaign 应作为必填 profile；不各建一套资源管理、日志或有效性系统。尤其 EFE 的 `standard` 不是一个统一的 obs→action 协议：roboEngineer 提交数值 controller，Olympics Match 有回合制和在线 skill server，EmbodiedSWE privileged 提交可执行 `solve(env)`。[S011][S011] [S012][S012] [S013][S013]

“直接集成”应使 `libero-native`、`robocasa-native`、`robotwin-native` 等各自拥有 dataset/task/seed、镜像与 grader 的身份；可复用 vla-eval 的传输/runner 或 Arena 的仿真组件，但不能自动继承它们对 observation、horizon、success 或汇总规则的改变。EFE 本身改变了被测对象和条件，因此 `efe/<suite>/<mode>` 是独立 benchmark 身份，保留 EFE 包装是合理的。现有 Orbit adapter 使用统一 tasks/solve/verify/score 控制面；下文给出的 category 是它之上的语义规格，不新增 daemon。[S014][S014] [S015][S015]

## 2. EFE 全量 suite 清点与模式语义

### 2.1 计数与读表方法

以 `tasks/*/*/task.toml` 为清点单位，不以旧笔记、README 总数或某次运行的成功任务数代替。当前 **35 suites，2,260 task 目录**。P/S/RT 分别是目录后缀 `-privileged` / `-standard` / `-standard-realtime`；它们是 task 变体数，不是独立上游 benchmark 数，也不是应当相加形成一个官方平均分的样本。每行给出该 suite 的目录及说明证据。[S016][S016] 官方 headline 还受 `core_set.toml` 与 default_mode 约束；all 目录统计不等于官方 core 分母。[S017][S017] [S018][S018]

Oracle 列 `F / P / N` = `metadata.oracle` 的 `full / partial / none` 目录数。它表示仓库声明的 reference 覆盖程度，**oracle 成功率与本机可运行性未核实**；`partial` 不能充当全覆盖正例，`none` 不等于任务不可解。共享 API 缩写：P 通常接收本地 simulator Python API、实例和 privileged state，交付 `trajectory.npz`；S 通常接收 `/spec`、图像、proprio、kinematics 等公开接口，调用 `/submit`，可信 sidecar 留存轨迹；RT 在其上按时钟运行、持有最近的控制目标。每套件的特殊交付物在表中覆盖这个默认。[S009][S009] [S019][S019]

GPU 列区分 CPU physics、GPU physics / planner、GPU renderer。`GPU/RTX/EGL` 是源码或运行配方要求，不是本轮实测最低规格。没有给出的最小 VRAM、允许的 CPU 型号、驱动兼容和实时倍率均 **未核实**；部署须从具体 task.toml、compose 和实际 `/spec` 读取，不能把 suite 级简写变成所有 task 的硬编码。EFE 资源声明把 main 与 services 分开。[S020][S020]

### 2.2 全部 35 suites

下表“P 回放”指 trusted verifier 从冻结实例运行提交物，默认两次但以任务实现为准；“S/RT live”指以 sidecar 实际 episode 评分，不用事后视频回放改判。下表没有声称每套上游源库已在本机完整展开。

| Suite / 目录数 P/S/RT | 上游与来源 | Simulator / GPU / renderer | agent 接收的接口、观测、动作 | 交付与判分 | Oracle F/P/N | 证据 |
|---|---|---|---|---|---|---|
| `abc-sim` · 60 (29/29/2) | ABC Sim；构建抓取 amazon-far/abc @ d0832d1 | MuJoCo 3.6；CPU physics，EGL GPU 渲染 | P: rcb_abc；S/RT: 多相机 RGB/depth、proprio；14D 双臂绝对关节/夹爪，控制 dt=.034 s | P: NPZ，两次新进程回放；S/RT live。上游 task evaluator 外加连续 30 步保持；ball-tray 有主动拿起/倒计时条件，不是原始瞬时 success | 60/0/0 | [S118][S118] [S119][S119] [S021][S021][S022][S022][S023][S023] |
| `ambench` · 17 (8/9/0) | AM-Bench；ambench/ambench @ 60bf5b7 | Isaac Sim 5.1 + IsaacLab；GPU PhysX/RTX；具体资源按 task | 8D ee xyz + quaternion + gripper；120 Hz（套件说明，频率实现未逐环境核实）；S 两机位 RGB/depth、proprio | P NPZ，重放均成功；不把浮点终态 hash 相同作为统一要求。S live `_get_success`；PullLever 只有 S；RotateValve 有角度展开修正 | 17/0/0 | [S120][S120] [S121][S121] [S024][S024][S025][S025] |
| `autobio` · 18 (9/9/0) | AutoBio；autobio-bench/AutoBio @ 0850421 | MuJoCo 3.3；CPU + OSMesa | P rcb_autobio；S RGB/depth/proprio；单/双臂关节动作；EFE control dt=.002 s | P NPZ 回放，S live；一般在 check 达标时终止，thermal mixer 按结束时连续分值判 score≥1；不能把 500 Hz EFE replay 当上游 policy 的统一频率 | 18/0/0 | [S122][S122] [S123][S123] [S026][S026][S027][S027] |
| `behavior-1k` · 200 (100/100/0) | BEHAVIOR / OmniGibson；stanfordvl/behavior:3.9.2 镜像 | Isaac Sim / OmniGibson；GPU、RTX；数据需另供 | P scene/state API；S 三机位 RGB/depth + proprio；R1Pro 25D joint/base，30 Hz，可选 ee pose | P NPZ 回放；S live。BDDL goal 连续 30 步、目标释放且静止；初始 settle；不同于 native 的裸 goal 成功与 23D interface | 0/4/196 | [S124][S124] [S125][S125] [S028][S028][S029][S029] |
| `bigym2` · 39 (13/13/13) | BiGym2；swirl-uk/BiGym2 | MuJoCo + GR00T whole-body controller；EGL GPU；policy/renderer 显存未测 | P rcb_bigym2；S/RT 三相机 RGB、proprio；上身/双臂与步行命令，action layout 动态从环境读取 | P NPZ 回放；S/RT live；调用 `bigym.loco.eval.is_success`，含任务完成与未跌倒条件；不臆造统一 action 维数 | 0/0/39 | [S126][S126] [S127][S127] [S030][S030][S031][S031][S032][S032] |
| `dexhand` · 60 (30/30/0) | EFE 自有 dexterous task 实现；原创归属未核实 | MuJoCo；CPU + OSMesa | Sharpa/Marvin 等手型的指关节和腕部控制；S RGB/depth/proprio；HZ 从具体 Session.control_dt 计算 | P NPZ/生成程序，two replay；S live task predicate。手型、任务阶段与触觉/接触规则依 task；不能把 Sharpa oracle 覆盖推给其他手型 | 60/0/0 | [S128][S128] [S129][S129] [S033][S033][S034][S034][S035][S035] |
| `dexjoco` · 22 (11/11/0) | brave-eai/dexjoco（锁定 commit 见镜像） | MuJoCo 3.4；CPU + OSMesa | P rcb_dexjoco；S RGB/depth/proprio；单臂 23D / 双臂 46D，包含 TCP 与手指目标 | P NPZ，两次回放；S live first success/failure；plant watering 等有 EFE 规则修正，不能直接等于上游完整评测 | 22/0/0 | [S130][S130] [S131][S131] [S036][S036][S037][S037][S038][S038] |
| `dextoolbench` · 42 (21/21/0) | DexToolBench / SimToolReal；来源关系由 suite README 声明，上游 checkout 未核实 | MuJoCo；EGL GPU 渲染（配方/说明，实际最低 GPU 未核实） | Kuka + Sharpa 29D joint targets，60 Hz；S RGB/depth、proprio、当前目标 | P NPZ：按序完成 tool keypoints，容差 .015 m，默认每目标 30 s；S live，不沿用 P 的每目标 deadline（说明声明，所有分支未核实） | 12/30/0 | [S132][S132] [S133][S133] [S039][S039][S040][S040] |
| `embodied-olympics-fun` · 179 (79/79/21) | EFE 自有比赛/运动 task，rcb_rfo；原创归属未核实 | MuJoCo；OSMesa 可用，部分渲染可选 EGL | P simulator/referee API；S/RT 视觉/本体状态和运动/关节工具；逐物理步 referee | P NPZ；S/RT live referee 的 sport-specific success，重置预算独立记录；不是通用抓取成功率 | 46/0/133 | [S134][S134] [S135][S135] [S041][S041][S042][S042][S043][S043] |
| `embodied-olympics-match` · 13 (1/1/11) | CHIGUI0/roboolympics 导出；完整私有上游不可读，来源/发行等价性未核实 | 比赛自有 runtime / simulator；README 声明发布镜像 CPU-only，镜像内部所有引擎未核实 | game CLI / HTTP；11 RT、1 turn-based fencing；可运行 agent 侧 skill server；P soccer skill policy | S/RT trusted final match record；计时输、弃赛等 valid 0；P 可执行 skill 在隔离进程评估。grader 对 agent 已施加动作后的 world_step error 有特殊 valid 0 判法 | 1/12/0 | [S136][S136] [S137][S137] [S044][S044][S045][S045] |
| `embodied-safety-exam` · 76 (0/71/5) | EFE 自有 Safety Exam；source 在 images/ese；原创归属未核实 | MuJoCo；CPU / OSMesa；RT 时钟由服务驱动 | 只有 S/RT；相机/robot state、控制动作、ask_operator/report/exit 等语义工具 | live physical record + safety judgment；最终有 pass/outcome/judgment_class。不是只看运动目标；自然语言告知/拒绝与物理事件共同属于任务 | 76/0/0 | [S138][S138] [S139][S139] [S046][S046][S047][S047] |
| `embodiedswe` · 48 (24/24/0) | EmbodiedSWE/EmbodiedSWE @ 67f44e8；自身就是 coding benchmark | Isaac Sim 5.1 + IsaacLab；GPU / RTX | P 写 solve(env)，通过隔离 proxy 使用 sim；S 观测→动作服务；Franka/G1 频率各异 | P 可执行 policy；trusted task final predicate / grader rubric；S live。代码路径保留 final 与 peak 等指标，不能把 peak 一概当最终成功 | 0/0/48 | [S140][S140] [S141][S141] [S048][S048][S049][S049] |
| `humanoidbench` · 30 (10/10/10) | carlosferrazza/humanoid-bench；构建另锁定运行依赖 | MuJoCo 3.3.7；CPU physics，OSMesa 或 GPU renderer | H1 / H1 hand actions；S/RT image/proprio；具体 19/61D 与 50 Hz 见说明，逐任务未核实 | P NPZ；S/RT live；按累计 dense return 达到任务 bar 转 binary；task horizon 与 reset 预算要保留，不能改成最终姿态判断 | 3/0/27 | [S142][S142] [S143][S143] [S050][S050][S051][S051][S052][S052] |
| `ispatialgym` · 24 (12/12/0) | kmy17518/iSpatialGym + BEHAVIOR fork | OmniGibson / Isaac Sim；CPU PhysX 配置 + RTX GPU | 目标是图像；P 有 scene API 但不开放隐藏 goal checker；S goal image、RGB/depth、proprio、kinematics | P NPZ 回放；S live image-arrangement 的几何/关系 checker；放宽容差与 settle 改写见说明，未逐 predicate 对照上游 | 0/0/24 | [S144][S144] [S145][S145] [S053][S053][S054][S054][S055][S055] |
| `kinder` · 10 (5/5/0) | Princeton Robot Planning and Learning / kindergarden | 按任务 MuJoCo / PyBullet；CPU 渲染路径 | P state/planning API；S 视觉/本体；TidyBot++ 控制 dt=.1 s，其余 kinematic 模型该 dt 仅名义值 | P NPZ 回放；S live；包装器把环境 terminated 视为成功；不能假设所有 Gym terminated 都有这一语义 | 2/0/8 | [S146][S146] [S147][S147] [S056][S056][S057][S057][S058][S058] |
| `labutopia` · 18 (9/9/0) | Rui-li023/LabUtopia @ 8df7278 | Isaac Sim 6.1 配方；CPU physics / RTX renderer（版本运行未核实） | P rcb_labutopia；S RGB/depth/proprio；9 joints 或 pos+vel 18D，60 Hz | P NPZ；S live；pick/press/open 等显式 scripted predicates，由目标物位置/运动计算；不等于任意上游 LLM judge | 18/0/0 | [S148][S148] [S149][S149] [S059][S059][S060][S060][S061][S061] |
| `libero-max` · 128 (64/64/0) | liberomax/LIBERO-MAX @ a1e3cef + Zxy-MLlab/LIBERO-PRO @ 2b910b5 | MuJoCo / robosuite；CPU + OSMesa | P lmx_tool；S cameras/proprio、7D arm delta + gripper；固定 dynamic instances | P NPZ 回放；S live；64 个任务变体，不是原版 LIBERO-40/90，也未构成 MAX 原生 Base/Dynamic 配对指标 | 128/0/0 | [S150][S150] [S151][S151] [S062][S062][S063][S063][S064][S064] |
| `maniguard` · 60 (30/30/0) | NU-IDEAS-Lab/ManiGuard + BEHAVIOR 3.7.2 | OmniGibson / Isaac Sim 4.5，GPU RTX + Spot LTLf monitor | P full-state 与 safety API；S RGB/depth/proprio；8D joint 或 ee，20 Hz | P NPZ 两次回放；S live strict goal hold 10 步，所有 goal 条件且 ANY step 无安全违规；保留 upstream 宽松/接触门控指标作对照 | 28/0/32 | [S152][S152] [S153][S153] [S065][S065][S066][S066][S067][S067] |
| `metaworldplus` · 100 (50/50/0) | Farama-Foundation/Metaworld @ 59fc34d；EFE 名称 MetaWorld+ | MuJoCo 3.3；CPU + OSMesa | P mw_tool；S RGB/proprio；4D xyz delta + gripper；80 Hz | P NPZ ≤500 actions，两次回放；S live 最终 evaluate_state.success，不能改为 ever-success；50 个 v3 task 的冻结实例 | 100/0/0 | [S154][S154] [S155][S155] [S068][S068][S069][S069][S070][S070] |
| `molmospaces` · 16 (8/8/0) | Ai2 MolmoSpaces 包；构建锁文件为来源，论文归属未核实 | MuJoCo；EGL GPU，存在 OSMesa 路径 | P rcb_molmospaces；S cameras/proprio；FR3/RBY1 对应关节动作，维度依 robot | P NPZ；S live；结束状态调用 task.judge_success；完成后破坏目标可失败，不能累计曾经成功 | 0/0/16 | [S156][S156] [S157][S157] [S071][S071][S072][S072][S073][S073] |
| `mujoco-playground` · 27 (13/13/1) | Google MuJoCo Playground 衍生；具体上游版本由 suite 声明，完整 checkout 未核实 | EFE 用 plain MuJoCo CPU；不等于原生 MJX GPU RL | P rcb_panda/aloha/quadruped；S/RT pixels/proprio；四足 12D，频率按 robot | P NPZ；S/RT live；手写机械臂任务及从 dense reward/误差导出的成功门槛；不是原生训练 return 的无损镜像 | 27/0/0 | [S158][S158] [S159][S159] [S074][S074][S075][S075] |
| `myosuite` · 45 (22/22/1) | MyoSuite==2.12.2 包 | MuJoCo 3.6；CPU + OSMesa，可选 GPU renderer | 肌肉 excitation / actuator control，action_dim 随模型；S/RT 相机与 proprio | P NPZ；S/RT live；有持续保持、事件完成、轨迹跟踪多种 checker；EFE horizon/hold 不能替代 MyoChallenge 原生协议 | 6/0/39 | [S160][S160] [S161][S161] [S076][S076][S077][S077][S078][S078] |
| `pandadyn` · 69 (25/25/19) | EFE Panda Dynamics 自有 task 包；原创归属未核实 | ManiSkill / SAPIEN；CPU physics 1000 Hz，GPU render | P rcb_pandadyn；S/RT RGB/depth/proprio；单臂 8D / 双臂 16D joint+gripper，控制 100 Hz（说明与工具） | P NPZ 回放；S/RT live；阶段事件、动态条件与违规检查；不能用低频终态截图重构瞬时成功 | 69/0/0 | [S162][S162] [S163][S163] [S079][S079][S080][S080][S081][S081] |
| `roboarc` · 212 (106/106/0) | EFE 自有 RoboARC / TopoGym + IKEA 分支；原创归属未核实 | MuJoCo CPU；布料/视觉分支另用 CUDA / Nyx RTX；不能按一个引擎配资源 | P rcb_topogym / rcb_ikea；S 视觉/proprio、joint/ee 操作；2.4 operation IDs 与 deadline | P NPZ 与 strict checker；S live，按任务成功/接触/settle 规则。protocol 2.4 不表示该 task 是 realtime | 208/0/4 | [S164][S164] [S165][S165] [S082][S082][S083][S083][S084][S084][S085][S085] |
| `robocasa` · 58 (29/29/0) | robocasa/robocasa @ 756598a（v0.2 系列） | MuJoCo 3.2.6 / robosuite 1.5.1；CPU + OSMesa | P casa_tool；S RGB/proprio；12D arm OSC + gripper + mobile base/torso/mode，20 Hz | P NPZ 回放；S live 最终 _check_success；29 个冻结任务/演示实例；native vla-eval 7D arm-only 是另一 action contract | 58/0/0 | [S166][S166] [S167][S167] [S086][S086][S087][S087] |
| `robocasa-gr1` · 48 (24/24/0) | robocasa/robocasa-gr1-tabletop-tasks @ 4840e67 | MuJoCo / robosuite + mink IK；CPU + OSMesa | GR1 固定底座；双 ee pose12 + 双手12 = 24D absolute（mink IK）；20 Hz 为 suite 说明，频率运行值未核实；S RGB/proprio | P NPZ；S复用RoboCasa live最终 _check_success路径；不是Panda RoboCasa的同一embodiment；逐任务判据与上游等价性未核实 | 48/0/0 | [S168][S168] [S169][S169] [S088][S088][S089][S089][S090][S090] |
| `robocasa365` · 101 (50/50/1) | robocasa/robocasa @ 4f8a298 + robosuite 对应 commit | MuJoCo 3.3.1；CPU + OSMesa | EFE 13D joint7+grip+base+torso/mode，20 Hz；S RGB/proprio；1 个 RT | P NPZ；S/RT live 最终 _check_success；不是 native 12D OSC；50 个冻结任务，RT toaster 无 full oracle | 100/0/1 | [S170][S170] [S171][S171] [S091][S091][S092][S092] |
| `robodojo` · 102 (48/54/0) | RoboDojo-Benchmark/RoboDojo @ cb2a37d | Isaac Sim 5.1 / IsaacLab fork + cuRobo；GPU PhysX/RTX | P rcb_robodojo；S 三 RGB/depth、proprio；14D joint / 16D ee，25 Hz（说明） | P NPZ 单次 fresh replay；S live，agent-ended /finish、隐藏 success 与限定步数；阶段 success 可锁存。6 个 nondeterministic task 只有 S | 0/0/102 | [S172][S172] [S173][S173] [S093][S093][S094][S094][S095][S095] |
| `roboengineer` · 30 (0/30/0) | EFE 自有 controller engineering；组合 Neural Lander/Fly、AnyCar、Go2/G1 等资产；各来源见 family 文档，完整历史未核实 | MuJoCo CPU evaluator/OSMesa；G1 的 main 另需 GPU mjlab/MuJoCo Warp 训练 | public nominal model + bounded policy ABI；3 轮 deploy，私有反馈；只有 S 标签，但 eai-policy/1.x | 提交 JSON 系数或固定形状 NPZ 权重；trusted sidecar 在 hidden bank 双进程评估选中 policy；success=所有案例成功，同时保存 mean engineering score / success_rate | 16/5/9 | [S174][S174] [S175][S175] [S096][S096][S097][S097][S098][S098] |
| `robolab` · 106 (53/53/0) | NVlabs/RoboLab @ 9db0aaf | Isaac Sim 5.1 / IsaacLab；CPU PhysX + RTX | P rcb_robolab；S 三相机与 proprio；DROID 8D joint/ee，15 Hz | P NPZ 回放；S live；原任务 checker 外增加持物/接触/settle 条件（具体依 task）；53 个 task，不能等同 Arena 的 38 个 YAML port | 4/0/102 | [S176][S176] [S177][S177] [S099][S099][S100][S100][S101][S101] |
| `robopaint` · 86 (43/43/0) | EFE 自有绘画 task；图像/笔刷组件含 cmubig/Frida、libmypaint | ManiSkill / SAPIEN，CPU physics / GPU render；scorer 独立角色 | P sim API + 评分服务；S RGB/depth/proprio，画笔 joint/ee；目标图像 | P NPZ 双回放；S live 画布，图像相似度与过程规则共同判 success；保留连续 final_reward，不能只用 binary 汇总所有差异 | 0/86/0 | [S178][S178] [S179][S179] [S102][S102][S103][S103][S104][S104][S105][S105] |
| `robotwin-2` · 94 (47/47/0) | RoboTwin-Platform/RoboTwin；本地 third_party/RoboTwin 子模块 | SAPIEN + cuRobo；GPU planner/render，物理 250 Hz；此处不据 GPU 需求推断 physics backend | P RoboTwin/RCB API；S RGB/depth、相机标定、proprio；14D joint / 28D pos+vel，或 16D ee | P NPZ 回放；S live check_success；47/50 task 的 EFE 子集。S action 的 dt 与 native take_action 的变长 TOPP 轨迹不相同 | 94/0/0 | [S180][S180] [S181][S181] [S106][S106][S107][S107][S108][S108][S109][S109] |
| `robowits` · 30 (15/15/0) | UMass-Embodied-AGI/RoboWits @ 9cc30ae | Genesis 0.4.7；当前包装默认 CPU physics + EGL GPU render；host/driver 约束与最低 VRAM 未核实 | P rcb_robowits；S 三 RGB/depth、proprio；双臂 16D joint/ee、30 Hz（说明） | P NPZ 回放；S live；额外释放/无接触与稳定性窗口；只取冻结 eval0，不能声称已保留上游全部 seed 协议 | 0/4/26 | [S182][S182] [S183][S183] [S110][S110][S111][S111][S112][S112] |
| `vlabench` · 72 (36/36/0) | OpenMOSS/VLABench @ cf588fe | dm_control / MuJoCo；CPU + OSMesa | P vlb_tool；S RGB/proprio；9D joint targets，10 Hz | P NPZ 回放且不允许终止后动作；S live should_terminate_episode；36 个冻结实例；native driver 是 7D delta EE→IK，不相同 | 72/0/0 | [S184][S184] [S185][S185] [S113][S113][S114][S114][S115][S115] |
| `yamlab` · 20 (10/10/0) | ARISE-Initiative/yamlab @ ec0455d | Isaac Sim 5.1 / IsaacLab；CPU PhysX + RTX | P rcb_yamlab；S RGB/depth/proprio；双臂14D joint 或16D ee，30 Hz | P NPZ 回放；S live；ordered stages + hold/fall checker；2 个 family × 5 个实例，不应当误写为 10 个独立任务族 | 20/0/0 | [S186][S186] [S187][S187] [S116][S116][S117][S117] |

各表行描述的是 EFE 实现；API/判分路由依据所链工具、grader与task配方；调用外部checker只能证明调用关系，其未在本地展开的全部内部语义仍为“未核实”。精确维数、频率、资源若在行内明确标注为说明声明，则仍需读取运行时 `/spec` 和固定版本上游才能验收；不能以本表替代 task-level schema。


### 2.3 会改变比较结果的 EFE 规则

- P/S/RT 总数分别为 **1,034 / 1,142 / 84**；oracle 标签合计 **full 1,313 / partial 141 / none 806**。本轮还逐目录确认所有 full/partial 项有非空 `solution/`；只检查文件存在，不证明解答可运行或成功。计数复核脚本在 §8；原始证据是各 suite 下 task.toml / solution。[S016][S016]
- P 不是一律“最后状态加两次精确 hash”：协议允许 task 选择一次回放；RoboDojo 选择一次；AMBench 的浮点重放条件另有例外。S/RT 的判分时刻是 live episode，之后的视频回放不应影响 verdict。[S188][S188] [S189][S189] [S190][S190]
- S 的 reset budget、自动停止/agent-ended、success 是否可见，必须从 task 的 compose 与 `/spec` 固定。不能给所有 S 统一加 horizon，或默认 unlimited reset。RoboDojo 的 `/finish` 和隐藏成功使“何时主动结束”成为被测能力。[S191][S191] [S095][S095]
- 把 EFE 一个冻结 task 的多个 coding-agent seed 当作多个独立物理实例会夸大覆盖。EFE seeds 的默认/allowed/build/oracle 有独立元数据，运行文档说明当前 task 限定默认 seed；需要逐 task 解释，不能仅把 Orbit trial.seed 写到结果文件。[S192][S192]
- Oracle 只在 oracle method 中可见；sim、checker、oracle 的可见边界是规格的一部分。privileged 也不意味着可以读 hidden evaluator；roboEngineer 没有 privileged twin，因为隐藏动力学就是题目本身。[S193][S193] [S011][S011]
- EFE 官方运行还有原生 Harbor agent、网关、cutoff、不加 prompt、seed/重试等条件；从 Orbit 跑通并不自动得到 EFE 官方成绩资格。相关要求是文档约束，Orbit 当前逐项兼容性 **未核实**。[S194][S194]

## 3. 原生 benchmark：被测对象、episode 与评分

### 3.1 先界定“原生”的证据边界

下表区分三件事：上游本体、vla-eval 中实际实现的 driver、Arena 中的 port。能在 driver 看到 `env.step` 不等于已核实它与某论文官方评测完全等价；完整官方协议、数据版本和结果复现若只由注释声称，均 **未核实**。本轮找到的 vla-eval native 接入代码覆盖 LIBERO 系、RoboCasa/365、RoboTwin、BEHAVIOR、MolmoSpaces、RoboDojo、VLABench，以及本题要求的 ManiSkill2、SimplerEnv、CALVIN。各自代码在下表。Arena 本地另有 38 个 RoboLab task YAML；它们是 Arena port，不能冒充原版 RoboLab 评测分布。[S195][S195] [S196][S196]

“原生被测对象”在以下 driver 中是一个已经给定的 policy（VLA、视觉 policy、state policy、RL policy 或 planner 均可实现该 API）；是否真的使用 VLA 取决于挂接的模型，不是 benchmark 类名能保证。对 EFE，本体通常改为 coding agent 设计动作程序；EmbodiedSWE 自己本来就是 coding benchmark，不能强行把它解释成 VLA benchmark。[S197][S197] [S198][S198] [S199][S199]

### 3.2 已核实的 native driver 合同

| Benchmark / 被测对象 | 观测与动作 | 频率、episode / seed 协议 | 成功与 native driver 行为 | EFE / native 差异与证据 |
|---|---|---|---|---|
| **LIBERO**；language-conditioned manipulation policy | primary RGB 256² + language；wrist、8D EE/gripper state 可选；7D delta position/axis-angle + gripper，亦有 absolute action 配置 | driver `step_dt=.05`，20 Hz；默认 seed 7；reset 后取 `get_task_init_states()[episode_idx]`，10 dummy warmup steps；默认各 task 最多 50 episodes；spatial/goal/object/10/90 horizon=220/300/280/520/400 | `env.step` 的 done 当 success；sync 每步交互，可经通用 server 缓存 chunk；CPU/GPU renderer 可选。具体 init-state 数据是否与选用 official release 匹配未核实 | EFE 是 MAX+PRO 的 64 个冻结 dynamic cases，coding subject 与评分/采样条件改变，不能填回 native LIBERO 栏。[S200][S200] [S010][S010] [S201][S201] [S202][S202] [S203][S203] |
| **LIBERO-Pro / Plus / Mem**；robustness 或 memory policy | Pro/Plus 继承 LIBERO 的观测/动作；Mem 跟踪 sequential subgoals | Pro 按 perturbation suite；Plus 用 classification 文件筛选 task；Mem max_steps=1000、50 episode/task | 不能把 MAX、PRO、Plus、Mem 相互别名化。Plus/Pro 的完整扰动数/论文统计这里只由文档注释声明，未核实数据全集 | EFE MAX 使用 PRO 的底层包，不代表评了 PRO 完整协议；Mem 的记忆状态不可跨 episode 泄漏。[S204][S204] [S205][S205] [S206][S206] [S207][S207] |
| **RoboCasa v0.2 路径**；policy | 默认 agentview_left + eye-in-hand RGB、language；可选 base/gripper state；policy 7D arm delta+grip，driver 补零成全身 env action | 20 Hz；24 atomic task，排除 NavigateKitchen；5 个固定 kitchen layout/style pair；seed 给定时按 seed+episode_idx；horizon 从 task registry | 每步 `_check_success`，成功即停；否则 horizon。CPU/GPU render。其 action 限制属于 vla-eval 实现，不可泛称上游全部 policy 都只有 7D | EFE 29 个 task、冻结 demo/scene、12D 全身动作、最终状态 success；样本集合、embodiment 控制能力和成功时刻均不同。[S208][S208] [S209][S209] [S210][S210] [S211][S211] [S087][S087] |
| **RoboCasa365**；policy | 3 RGB + 官方 key 的 state dict + language；12D OSC：pos3+axis-angle3+grip1+base4+mode1 | driver 20 Hz；split registry；seed+episode_idx；每 task registry horizon；`success_check_interval` 默认 16 | 跑完整 horizon；每 16 步及最后一步读 info.success 并锁存。这里是实际代码；是否与任意上游版本官方 chunk evaluator 等价未核实 | EFE 是13D joint control + final-state checker，不能把二者动作重采样后共用分数。[S212][S212] [S213][S213] [S214][S214] [S215][S215] [S092][S092] |
| **RoboTwin 2**；双臂 policy / planner | head + left/right wrist RGB、language；可选14D joint state / 16D EE state；qpos14 或 ee16 | 默认 test_num=100、seed=0，候选起点 `100000*(1+seed)`；expert 先筛可解实例，或用 fingerprint 匹配的 seed cache；seen/unseen instruction；setup_demo reset；物理250 Hz，但 take_action 可经 TOPP 展开为变长子步，policy频率不是250 Hz | `eval_success`，step limit / take_action_cnt；skip_expert_check、fast_init、render_every 都会改变条件，必须入 fingerprint。native源码也有 expert/motion planning 与 `_base_task.take_action` | EFE 47冻结 task、NPZ 或 live sidecar；native 随机可解性筛选与 action planner 路径不同。本地子模块也有自己的 server/multitask launcher，不能把“进程成功数”当 episode success。[S216][S216] [S217][S217] [S218][S218] [S219][S219] [S220][S220] [S221][S221] |
| **BEHAVIOR-1K / B100**；R1Pro policy | wrapper 多相机 RGB、可选 depth/proprio；23D action，运行时检查 robot.action_dim；自然语言 task | 30 Hz / 120 Hz physics；vla-eval 调 v3.9.4 evaluator，num_envs=1；task list、train/public_test/hidden_test 与 instance ID 映射来自 evaluator；reset 有固定 eval seed；首个 query 放宽计时，后续 response timeout | 裸 env_accessor.success + final q_score，并保留 time/distance 效率指标；policy timeout 有官方风格零分与 failure_reason。官方完整种子/实例分布仍须锁定 evaluator/assets | EFE image3.9.2、25D动作、100冻结 task、goal释放/静止30步、settle窗口；不仅 subject 不同，成功条件也不同。[S222][S222] [S223][S223] [S224][S224] [S225][S225] [S226][S226] [S227][S227] [S228][S228] |
| **MolmoSpaces**；policy | primary/wrist RGB + language；可选7joint+grip state；driver 的8D action（不足补零/多余截断），不是所有 Molmo robot 都统一8D | 每个 JSON episode 成为 task；JsonEvalTaskSampler + house_index；默认 horizon600，config seed42；控制频率未在此 driver 显式设置，**未核实** | reset/step 使用 task API；最终 `judge_success()`，异常时回退 info.success；CPU/GPU renderer。需保存 JSON episode identity，不能只写文本任务名 | EFE 覆盖 FR3 / RBY1，action和冻结对象集合不同；native8D driver不能自动代表RBY1路径。[S229][S229] [S230][S230] [S231][S231] [S232][S232] [S233][S233] [S234][S234] |
| **RoboDojo**；batched双臂 policy | RGB多相机+language+14D state；14D joint actions，经 take_action_batch | VectorStepBenchmark，默认 num_envs=1、task_exclusive=true、partial_reset=false；按 layout queue / task seed 分配 slots；round 同 task；控制 Hz 未在 driver 明确声明，**未核实** | success 得1，否则 process_score/100；settling不稳布局 EpisodeSkipped；PhysX故障可 EnvUnusable。不是“全部异常一律success0”；正式分母须保留 attempt/skip ledger | EFE S 是隐藏成功、显式finish、固定实例；P 单回放；native批内同步、布局过滤、partial score均需独立保留。[S235][S235] [S236][S236] [S237][S237] [S238][S238] [S239][S239] |
| **VLABench**；policy | primary RGB+language；driver不发送完整点云/深度；7D delta EE + Euler rotation + grip，IK映射成9joint | 10 Hz；默认5个 task、max_steps200；load_env/reset 未显式传 episode seed，**原生 seed 协议未核实** | driver把 timestep.last 当 success；需核验上游 last 是否包含失败终止，不能仅凭 dm_control 通用语义证明正确 | EFE 36冻结 task、9D关节目标、should_terminate_episode；两者样本/动作/终止解释不同。[S240][S240] [S241][S241] [S242][S242] [S115][S115] |
| **ManiSkill2**；manipulation policy | driver env=rgbd、pd_ee_delta_pose；实际forward primary RGB+language，未转发完整depth；7D delta EE/grip | 控制20 Hz、physics500 Hz；默认5任务、每task50episode、max400；reset 未显式 seed | terminated或truncated停止，success读info；gripper实际转换按代码阈值，不能靠变量名推断正负号 | EFE没有名为ManiSkill的suite；PandaDyn/RoboPaint借ManiSkill3建自有任务，不是nativeManiSkill2；本地driver也不能代表ManiSkill3全集。[S243][S243] [S244][S244] [S245][S245] [S246][S246] |
| **SimplerEnv**；Google Robot / WidowX policy | image+language，可选TCP/base状态；7D EE delta + gripper；gripper sticky / binary转换因机器人而异 | visual matching / variant aggregation配置；VM按episode配置，VA笛卡尔网格；有seed则reset使用该seed；dt读env.control_timestep，注释Google3 Hz、WidowX5 Hz，具体运行值未核实 | `early_stop` / `accumulate` / `truncation` success_mode；默认truncation按末态，accumulate取ever；GPU SAPIEN renderer。这是仿真 real-to-sim benchmark，非实机执行 | EFE无对应suite；应直接接SimplerEnv并固定VM/VA、机器人、背景/物体变化及success_mode，不能只注册一个“real robot”类别。[S247][S247] [S248][S248] [S249][S249] [S250][S250] [S251][S251] |
| **CALVIN**；language-conditioned长时序policy | rgb_static+当前子目标语言；可选wrist、8D state；7D absolute/delta EE+grip，AA/Euler转换在driver | PyBullet；30 Hz控制/240 Hz physics；默认seed0，ABC→D1000序列×5子任务，每目标360步；sequence初态reset，子任务间不reset环境 | oracle task detector完成子目标后换语言；`episode_restart`用于重置policy缓存；success=完成5个，另报completed_subtasks；CPU TinyRenderer路径与其他renderer视觉条件不同 | EFE无对应suite；不能拆成5个相互独立的“成功率”替代长链指标，也不能在子目标切换偷偷复位世界。[S252][S252] [S253][S253] [S254][S254] [S255][S255] [S256][S256] |
| **Arena RoboLab port**；PolicyBase（VLA、RL、VLM planner均可） | DROID可选absolute joint / IK等embodiment；OpenPI DROID adapter用外相机+wrist224²、7joint+1grip、prompt；action8 | 本地38 task YAML；默认15 Hz（1/120×8），另有50 Hz helper；seed默认42，可placement/rebuild；例如banana任务50s；可单进程多env、分布式rank seed偏移 | 从task termination manager取success，SuccessRate计完成episodes平均；Pi0/Pi05默认chunk open-loop horizon10/15；不宣称这些port等价RoboLab官方全部任务 | EFE RoboLab53task及strict规则另立身份；Arena场景/placement/renderer/physics/default horizon均要固定。[S257][S257] [S258][S258] [S259][S259] [S260][S260] |


### 3.3 没有原生证据时，不补写一个“常见设置”

| 对应 EFE suite / 家族 | 本地能够确认的范围 | 尚缺的 native 合同 |
|---|---|---|
| MetaWorld+ → MetaWorld | EFE requirements 锁定 Farama MetaWorld，mw_tool 调上游 API；指定 vla-eval 目录没有 MetaWorld driver | native RL/state observation schema、ML/MT split、task/seed sampling、episode数、ever/final success、official aggregation **未核实**。EFE的4D/80Hz/500步只证明该包装条件。[S068][S068] [S069][S069] [S261][S261] |
| RoboCasa-GR1、LIBERO-MAX | 有EFE实现/镜像来源；vla-eval有RoboCasa和LIBERO派生driver，但没有相同名称的直接driver | GR1原生24D控制/数据划分、MAX完整Base/Dynamic paired protocol和官方总分 **未核实**；不能拿相近driver冒名。[S261][S261] [S168][S168] [S150][S150] |
| ABC Sim、AMBench、AutoBio、BiGym2、DexJoCo、DexToolBench、HumanoidBench、KinDER、LabUtopia、ManiGuard、MuJoCo Playground、MyoSuite、RoboWits、YAMLab | 本轮指定本地仓库里，有EFE包装/构建下载引用，未找到同名native evaluator完整checkout；上表可以核实EFE动作和check入口 | native policy/规划器种类、obs/action完整空间、官方frequency/seed/horizon/score协议 **未核实**。尤其不能把EFE的hold、移除horizon、成功阈值反推为native规则。[S262][S262] [S263][S263] [S261][S261] [S264][S264] |
| DexHand、Olympics Fun/Match、Safety Exam、iSpatialGym、PandaDyn、RoboARC、roboEngineer、RoboPaint | 本地有EFE自身task/API；Match只含导出文件；部分构件来自其他库 | 若另行提出“native版”，须给出独立subject与官方runner证据；本轮原生评测身份/官方seed协议 **未核实**，不能因用了某sim就归并进该sim的其他benchmark。[S016][S016] [S262][S262] |
| EmbodiedSWE | 来源本身就是软件工程/控制程序题，EFE有代码提交和online两条路径 | 其完整原版task全集、所有grading条件与当前包装的差分 **未核实**；不能预设原版是VLA。[S048][S048] [S049][S049] |
| Arena README中的LIBERO、RoboCasa、RoboTwin、RoboDojo生态链接 | README有合作/扩展链接和coming-soon描述 | 不证明本地已经实现对应官方benchmark全集，也不证明原版MuJoCo→Isaac port的物理/观测/评分等价；本轮 **未核实**。[S265][S265] |

另有 vla-eval driver 可说明 category 的覆盖范围，但不能当作本题 EFE 上游的替身：MIKASA 是 ManiSkill3 上的 memory task；RoboMME 有 conditioning video 与 joint/EE/其他 action mode；RoboCerebra 是 LIBERO/robosuite 长链；DuoBench 是双臂RCS接口；Kinetix是2D功能式物理；OCBench是MuJoCo Warp多world vector runner。这些定位在对应driver可见，完整官方协议/性能 **未核实**。它们仍可落入EP加相应profile，而不是每个library新建类别。[S266][S266] [S267][S267] [S268][S268] [S269][S269] [S270][S270] [S271][S271]


## 4. 实际存在的交互契约与运行方式

### 4.1 vla-eval 的共同 runtime：可以复用，但不是 benchmark 身份

vla-eval 消息包含 HELLO、EPISODE_START/END、READY、OBSERVATION、ACTION、VECTOR_STEP/RESULT、PUBLISH、EPISODE_ERROR；使用 msgpack 编解码 NumPy。PUBLISH 的 index/source_seq 提供 latest-wins / 过期丢弃语义。sync runner 的顺序是 start→观测→等待 policy ready→act→apply action→判断结束；慢推理使仿真等待。live runner 不等待每次动作，在时钟下推进，缺新动作走 benchmark 的 hold 逻辑，记录 effective_control_hz 等；如果环境本身跟不上，其警告不是硬实时保证。[S272][S272] [S273][S273] [S274][S274] [S275][S275]

PredictModelServer 的预测输出可为 `[T,D]`，后续动作从每个episode的buffer取；`max_batch_size`、`max_wait_time`、`max_rows`控制跨episode batching与并发。这与simulator vectorization是两回事：单环境逐步仿真也可以合批推理，单次批量env.step也可以逐slot请求policy。需要逐episode reset/finish recurrent state及chunk cache。[S198][S198] [S276][S276] [S277][S277]

通用 StepBenchmark 的 `step_dt` 可以为None，hold不能盲目重放delta动作，否则机器人会继续移动；有hold实现才可启用相应live模式。给任意benchmark加一个`--live`选项并不能证明其支持合理实时控制。[S278][S278] [S275][S275]

记录包含SQLite episode/step元数据、step记录和video接口；是否实际记录完整观测/动作取决于recorder配置和具体driver调用，默认产物不保证够独立复核。普通异常由orchestrator写success=False+failure_reason；EpisodeSkipped单独记账且不进入collector。collector对某指标实际只聚合包含该数值字段的episode；因此只看aggregate.json不能证明所有计划episode都在分母里，非success指标的missing值不能默认为0。[S279][S279] [S280][S280] [S281][S281] [S282][S282]

### 4.2 Arena：local policy、remote chunk、VLM goal，不止一种执行接口

Arena policy_runner `env.reset()`、`policy.reset()`后循环 `get_action(env, observation)` / `env.step(action)`，对reset的env IDs重置policy state。其本地PolicyBase可拿到env对象，不能由此宣称强隔离或只见摄像头；真正的remote policy需要由adapter筛选可见字段。rollout可按steps或episodes停止，分布式按rank偏移seed。[S283][S283] [S284][S284]

OpenPI remote chunk path使用WebSocket、逐环境cache，再把action堆叠成batch；这条路径的逐env请求不能称作wire-level批推理。另一条SyncedBatchActionScheduler会等所有env需要chunk才一起推理，提前结束的env可能在新初态hold至多H−1步。这会影响初态settling、任务计时与并发比较，必须记为评测条件。remote一次请求最多三次尝试（含首次）的transport retry也不等于“同一物理episode从头重跑”。[S285][S285] [S286][S286] [S287][S287]

Arena还显式定义 VLM observation modality=image/state/image_state、VLMChunkPolicy（固定chunk_size）与VLMGoalPolicy（max_steps_per_goal、位置/旋转容差），将模型的高层goal交给motion/action adapter执行。这是“planner→goal→controller”契约，不能把高层一次决策计成一次物理step；也不能把state版成绩与image-only版混在一起。[S288][S288] [S289][S289] [S290][S290]

OSMO只应理解为资源/工作流层：Arena workflow将policy server和evaluation task组织到group，再启动collector；OSMO的COMPLETED表示工作流task成功。Arena collector还会排除failed Run的episode目录，只留失败报告。因此OSMO COMPLETED、Arena Run completed、机器人episode success、Orbit valid是四种不同状态，不能互相替代。[S291][S291] [S292][S292] [S293][S293]

### 4.3 契约清单

| 契约 | subject 的输入→输出 | clock / 边界 | 本地例证与 category |
|---|---|---|---|
| 单步闭环policy | RGB/depth/proprio/language → 一个typed action | env暂停等response；reset清policy状态 | LIBERO、ManiSkill2，EP。[S201][S201] [S245][S245] |
| Action chunk | 一次观测→H个动作；执行前K个再观测 | H/K、缓存、过期动作、episode切换规则固定 | PredictModelServer、Arena OpenPI，EP。[S198][S198] [S294][S294] |
| Asynchronous / realtime policy | 时序观测流→带序号动作/更新 | 固定sim dt、wall-time pace、deadline、hold/latest-wins | vla-eval live、EFE RT，EP或EI。[S275][S275] [S295][S295] |
| 本地开发→封存轨迹/代码 | task/API/可见实例→NPZ或可执行控制程序 | coding budget与最终rollout budget分开；fresh trusted evaluator | EFE privileged、EmbodiedSWE，EC。[S009][S009] [S049][S049] |
| 在线具身工具调用 | 文本任务+交互工具→观测/动作/重置/finish/报告 | 工具调用与episode状态连续；可有多个尝试 | EFE standard与Safety Exam，EI。[S046][S046] |
| 数值controller deployment campaign | nominal model、噪声反馈→系数/权重，反复部署后封存 | 固定部署次数、hidden bank、selected policy rule | roboEngineer，EC的campaign profile；不是普通S/HTTP动作服务。[S096][S096] |
| 高层goal / skill planning | 图像/状态+任务→ee goal / skill / program | 高层decisions与低层physics steps分开记；executor固定 | Arena VLMGoal，EP；coding agent可改skill时成为EI/EC。[S296][S296] |
| Language multi-task / long horizon | task language、连续scene、当前subgoal→action | 子目标切换可reset模型cache，不一定reset世界 | CALVIN、LIBERO-Mem，EP；语言本身不另立category。[S255][S255] [S297][S297] |
| 图像目标 / 记忆前缀 | goal image或conditioning video→action/program | 可见信息与history window固定 | iSpatialGym、RoboMME，EI/EC或EP。[S298][S298] [S299][S299] |
| 对抗 / 回合制 / 动态skill | seat observation、review→ready / act / skill服务 | opponent、review freeze、chess clock、no-show属于规则 | Olympics Match，EI；不能等价实时抓取。[S012][S012] [S044][S044] |
| 实机robot | 传感器→controller commands；reset/安全停机需外部执行者 | 独占设备租约、无法用Docker重建物理状态 | 本轮未找到并核实所列仓库中完整可用的实机benchmark链；这是EP/EI必需的拟议hardware profile，非已实现能力。SimplerEnv仅是仿真证据。[S247][S247] |

## 5. Orbit category integration spec（建议，未实现 / 未核实）

### 5.1 共用底座与身份

本节所有“必须”均为建议的验收约束。底座继续用Orbit一套daemon、资源账本、solve→verify→score→aggregate与Web UI。现有Outcome已把execution / evaluation / cleanup分开；FailureKind是闭集；OfficialRule有errors=exclude/fail与unit=sample/task；EpisodeTrajectory有episode/action/observation/media结构。这些可作为实现锚点，不能证明新增category字段已经存在。[S300][S300] [S301][S301] [S302][S302] [S303][S303]

每个直接注册的benchmark提供下列静态contract，启动时freeze，运行时写resolved copy和hash：

| 字段组 | 必须明确的内容 |
|---|---|
| identity | category/version；benchmark上游repo+commit；task/dataset/split/assets哈希；镜像digest；wrapper/grader版本；subject模型权重/CLI版本/配置；机器人、controller、renderer、driver版本 |
| subject interface | actor_kind=CLI coding agent / fixed policy / planner；transport；request/response schema；可见字段allowlist；相机key/颜色/分辨率/depth单位；proprio字段/单位；action shape/dtype/有限性/范围；关节顺序、坐标系、absolute/delta、quaternion顺序、gripper意义；chunk H/K与低层executor |
| timing | physics_dt、control_dt、observation cadence、policy query cadence；stepped/realtime/turn；wall/sim budget；slowdown；首步warmup；deadline/missed response/hold/overrun规则；reset/finish权限 |
| episode protocol | task/instance/layout/episode ID；env_seed / policy_seed / dataset init index / instruction seed分开；episode数、warmup/settle、horizon；reset/rebuild/skip/expert筛选；子目标/对手/试用与heldout边界 |
| score contract | trusted score source及判分时刻；ever/final/hold/terminal；成功、连续分、process score、效率、违规字段；normal failure与infra error；原始官方aggregate与Orbitaggregate的分母/权重 |
| resource roles | main/subject、sim、policy_server、monitor/scorer、verifier、media renderer；CPU/RAM/shm/GPU数量/显存/graphics/RTx/驱动/模型；可同卡与不可同卡条件；资产只读挂载；冷启动与每阶段timeout |
| evidence contract | 计划episode清单、实际attempt ledger、可信verdict/trace；必要与可选媒体；动作请求与执行对应；权限隔离；日志/frames格式与schema；缺失何种证据导致invalid |
| calibration | positive/negative/empty/known-failure；覆盖哪些instance/seed；预期区间与容差；校准失败的阻断条件；没有oracle时的替代证据 |

这些字段来自已发现的实际差异：RoboTwin的动作展开、RoboCasa365的间隔判分、CALVIN的子目标生命周期、roboEngineer的hidden bank、Arena的batch等待；其代码证据分别见 §3–4。建议让class定义以上共同字段的required性，bench package只实现本体差异，避免复制一套runtime。

**Trial单位建议**：普通EP一个trial=一个独立环境episode；CALVIN一个trial=一条五子目标sequence；EI一个trial=一次有预算的agent session，内含重置尝试；EC一个trial=一次开发/提交campaign，内含最终验收episodes。向量化仅是执行优化，可把多个独立episode同批调度，仍分别记trial/episode identity。roboEngineer hidden bank属于一个提交的验收样本集合，不应把同一生成controller的多个case误写成多个独立coding trials。

### 5.2 EC：控制制品生成

| 规格项 | 精确要求（建议） |
|---|---|
| subject接口 | CLI agent得到task instruction、固定SDK、允许的开发sim/nominal model；输出类型枚举trajectory / executable controller / bounded numeric policy。交付清单列路径、schema、hash、entrypoint、依赖与调用ABI；不能仅写“任意output目录” |
| 环境角色 | main含agent开发工具；开发sim可在main或独立dev service；trusted evaluator独立且看不到未声明可写卷；hidden instances/评分器只在trusted侧；需要动态执行用户代码时另开低权限executor，通过proxy给白名单API，不把它放进有评分文件权限的sim进程 |
| 资源 | coding GPU、dev sim GPU、final sim GPU、renderer分时或并时分别声明；roboEngineer G1要记录训练GPU型号和预算；verifier重放并发也占资源；CPU MuJoCo不得被模型server的GPU需求误归为GPU物理 |
| 生命周期 | reserve→准备资产→healthcheck→启动coding预算→开发/部署回合→cutoff时停止agent及子进程→封存选择规则下的制品→fresh reset/seed→执行固定评估bank→封存verdict→可选视频渲染→清理。若是campaign，nominal/adaptation/heldout样本和反馈泄漏界限单独声明 |
| 评分与有效性 | 使用trusted replay/heldout checker；缺交付、格式错误、controller正常运行却未完成任务，在预先定义的benchmark契约下可valid 0；环境启动失败、错误实例/资产、必需回放无法完成、grader崩溃、证据不一致为invalid。不能把agent写入的reward.json作为真值；不强求所有sim bitwise deterministic |
| 证据 | 原始提交与hash、生成/训练成本、开发尝试、选择哪个policy/部署轮、每个评估case seed/init hash、state/action trace、回放结果与差分。媒体注明live或posthoc replay；轨迹缺失且无法评分时应invalid，合法未提交已有明确0分证据时不伪造轨迹 |
| 校准 | 可用full reference按相同预算/隐藏bank执行；NPZ已知成功回放、故意扰动action/终态的负例、缺提交、随机/静止controller。只有partial时按覆盖subset验收并注明，不声明全部task正例已校准 |
| 聚合 | 先计算一次提交的官方验收分（all-cases-success、mean-case-score等），再按task/seed聚合；同时公开case级成功率与invalid。不要把每个case作为独立agent能力样本扩大N |
| 匹配 | EFE P轨迹套件；EmbodiedSWE P；Olympics Match P skill；roboEngineer S虽叫standard也归EC/campaign。后者内部运行policy仍是EC的一部分，不能重复算一遍EP成绩 |

这类需求已有局部依据：EFE隔离/封存/回放规则、EmbodiedSWE proxy、roboEngineer验收bank与case digest；Orbit尚需把交付类型/隐藏case/多阶段资源写成category schema。[S193][S193] [S304][S304] [S305][S305] [S096][S096]

### 5.3 EI：在线具身编程

| 规格项 | 精确要求（建议） |
|---|---|
| subject接口 | CLI agent通过typed tools/HTTP/CLI驱动环境；声明/spec、observe、submit、watch、kinematics、reset、finish，以及ask/report/ready等扩展；每次调用都有operation ID与完成状态；接口选择不能凭standard后缀猜测 |
| 环境角色 | main为agent，sim sidecar持有物理真值，monitor在sim内/可信sidecar读状态并判分；agent只得白名单观测，隐藏success/predicates按任务规则处理；agent自建skill server只在agent容器中执行 |
| 资源 | sim/renderer常驻；agent model可API远程或独立policy服务；live clock下不得因资源争用默默降速；timing profile、GPU占用及slowdown固定；网络可达性随实际benchmark规则设定 |
| 生命周期 | 服务healthcheck与初态验证后启动agent预算；记录每个episode/reset；step mode只在动作调用时推进，RT按独立时钟，turn按seat clock；结束agent→拒绝新请求→按task规则finish/settle→冻结live verdict→导出→cleanup |
| 评分与有效性 | live monitor是唯一行为评分源；posthoc replay只用于媒体或诊断。正常失败/超时/主动结束/对手赢/skill没赶上deadline的映射按benchmark预先定义；sim服务丢失可信状态、恢复不连续、checker异常为invalid。异常是否agent-caused必须有可审计规则，不能见到任何crash就自动给agent0 |
| 证据 | agent工具轨迹与sim episode轨迹分两层，并用operation/episode/action ID关联；记录预算、每次reset、sim/wall时间、被拒请求、deadline/hold、实际执行动作、最终goal/safety判据；RT必须记录动作生效时刻；对抗另记seat/opponent版本与review/ready事件 |
| 校准 | 脚本调用同一公开工具接口；full oracle、empty/no-op、已知失败、成功后破坏目标、关键接触/hold边界；check隐藏goal未泄漏；RT测试迟到/乱序/断连但只验合同，不在本报告执行 |
| 聚合 | 一个session为一个trial；report success、first_success、reset次数、simulation steps、cost；不同reset budget / clock / visible-state条件分榜；对抗按官方match win/score汇总，勿换成每点平均 |
| 匹配 | EFE S/RT大多数suite；Safety Exam；Olympics Match标准/RT/turn。roboEngineer虽有sidecar，主要交付是controller，例外归EC |

依据：EFE live判分规则、Safety Exam语义调用、Olympics Match live grader的特殊错误规则及timed skill调用。Orbit需要保存这些benchmark差异而不能将其抹成一个通用Gym接口。[S304][S304] [S047][S047] [S044][S044] [S306][S306]

### 5.4 EP：原生策略 rollout

| 规格项 | 精确要求（建议） |
|---|---|
| subject接口 | 给定model/checkpoint/planner，支持reset(context)、act(obs)→action/chunk/goal、finish(result)；模型能否online adaptation、跨episode memory、访问privileged state都必须显式。传输可WS/msgpack、进程RPC或隔离in-process wrapper；传输不是类别 |
| 环境角色 | benchmark-native env负责reset/step与机器人控制；policy server负责推理/缓存；monitor读native success/termination/metrics；verifier检查完整性/计算结果，绝不从policy自报success取分。planner内部controller也要固定版本 |
| 资源 | CPU仿真、GPU仿真、GPU graphics、模型推理GPU分开声明；向量env数/每GPUbatch/每server并发显式；sim与policy原子预留，避免占住一半资源等待另一半；batch优化改变clock时另立配置 |
| 生命周期 | 提前生成episode计划→reserve→启动server/sim→schema/capability握手→加载资产/模型→warmup→按native reset/seed/init-state→policy reset→闭环rollout→trusted结果→policy finish→下一episode或cleanup；子目标事件按native是否reset policy/cache执行，不自动reset世界 |
| score | 保留native task success、continuous/q_score、subgoal完成数、违规、efficiency；声明ever/final/hold/interval；保留terminated/truncated/endedBy。达到benchmark horizon是正常完成的失败episode，不是运行平台watchdog超时 |
| invalid | infra/启动/重置/服务器/模型响应/环境step/评分/必需证据错误为invalid并分类；官方将timeout等记0仍在official视图按规则计0；异常可恢复/skip仅按预先固定的native协议，不在失败后临时换seed |
| evidence | episode计划与实际seed、初态hash/数据index、观测schema与必要frames、多机位video、proprio、请求action与真正送env的action、chunk index与来源obs、控制/物理step计数、reward/success/safety变化、server延迟与deadline、官方原始结果 |
| 校准 | official expert/演示replay/已知checkpoint优先；必须经同一action解码/runner路径。empty不保证0（初态可能已满足、hold可能触发目标）；随机、平移扰动、反转gripper等负例只能按任务定义选择。没有可用正例时标“未完成正例校准”，不能宣布正式可比 |
| 聚合 | 基本unit是episode，但保留task/sequence层级；先按native规则算official，另给Orbit task均值；同时给planned/completed/valid/invalid/skipped及分母。batch size不改变样本权重；CALVIN等专用曲线、BEHAVIOR q_score应保留独立report artifact |
| 匹配 | 原生LIBERO、RoboCasa/365/GR1、MetaWorld、RoboTwin、ManiSkill、SimplerEnv、CALVIN、BEHAVIOR、MolmoSpaces、VLABench、RoboDojo；Arena的policy/planner任务也在此类，但port必须独立身份 |

这些要求不是所有native driver已经满足的事实；缺seed、不同成功时刻、batch reset、unknown frequency等具体缺口已在§3列出。原生policy是行为角色，VLA/RL/LLM planner是实现类型：若LLM每次输出goal，它是EP planner；若CLI agent可改代码并反复部署，它是EC/EI。


### 5.5 Trial validity、证据与review共用规范

Orbit现有失败闭集为 `infra, agent_install, env_start, env_step, reset_failed, policy_start, policy_act, server_unreachable, call_watchdog, resume_failed, scorer_error, judge_unavailable, model_unavailable, budget_exceeded`。以下是**建议映射**，不添加诸如robot_fell、grasp_failed为failure kind；这些通常是任务负结果，应放metrics/endedBy。[S301][S301]

| 事件 | Orbit evaluation / score 建议 | failure与必须保留的信息 |
|---|---|---|
| 正常rollout，未满足目标；正常到horizon；robot跌倒；任务规则认定违规 | valid / native负分或0 | 无failure；保留reason、success predicate、physical violation |
| 合同明确的deadline miss/skill error/比赛超时导致失败，可信monitor完整结束 | valid / native分 | 这是任务规则的负结果；必须保留timing证据。不可与服务完全失联混为一谈 |
| sim启动、资产/renderer初始化失败 | invalid / null | env_start；镜像、资产hash、driver日志 |
| reset不成功/初态hash错/状态污染 | invalid / null | reset_failed；planned与actual identity |
| sim step出错且不能获得合同定义的可信结局 | invalid / null | env_step；如果benchmark对agent-caused数值崩溃有明确0分规则，仅在该规则有证据时例外 |
| policy server无法启动 / 权重不可用 | invalid / null | policy_start / model_unavailable；不能算任务没完成 |
| 正在运行的policy响应错误或不可解析，且benchmark未定义成任务失败 | invalid / null | policy_act；保留原始响应及解析错误 |
| 连接不可达 / 独立调用watchdog触发 | invalid / null | server_unreachable / call_watchdog；与benchmark自身time-limit分开 |
| 运行平台总预算被耗尽，尚无可信最终结果 | invalid / null | budget_exceeded；如EI已有合同定义的cutoff live verdict则依该verdict判，不机械丢弃 |
| checker挂掉、判分文件缺失、计划episode缺项而无法补全 | invalid / null或job partial | scorer_error（或实际上游根因）；不要伪造0、补成功、忽略缺项 |
| 断点恢复不连续 / 必需历史丢失 | invalid / null | resume_failed；完整保留attempt ledger，不能把新初态续在旧trace后 |
| daemon/设备/OOM/通用执行设施失效 | invalid / null | 优先确切阶段映射，否则infra；OOM不是新failure枚举 |
| native EpisodeSkipped / expert拒绝seed / 不稳layout | 不暗中消失；按native计划规则替换/跳过并显式记账 | 保留候选seed、拒绝原因、消耗预算与最终分母；不是独立成功或任务失败trial |

Orbit设计已经区分valid负结果与基础设施invalid，也要求官方与valid-only两种口径；具体category实现仍要验证core分类不会把一个拥有可信live verdict的正常cutoff覆盖成invalid。上表的冲突解决规则是待实现项目，不是对现有代码行为的宣称。[S307][S307] [S308][S308] [S309][S309] [S281][S281]

**Evidence bundle建议**：`contract.json`、`episode_plan.jsonl`、`attempts.jsonl`、`verdict.json`、`official_result.json`、typed observation/action records、原始agent session、policy/service logs、multi-camera media与checksums；EC另存封存制品、EI另存工具operation journal、EP另存model/reset/chunk transcript。文件名是建议，不是现有Orbit强制格式。trusted scorer的结果只读导入；对agent自报成本/轨迹标记self-reported。已有EpisodeTrajectory能承载最多16相机、action/proprio/reward/terminated/truncated、late/stall、media时间映射和producer/trust，但不会自动表达每一种goal、safety proposition、requested-vs-executed action；这些应在typed sidecar artifact里保存并在UI索引，必要时版本化扩schema。[S303][S303]

**Review建议**：一页同时显示合同/身份、validity与原因、官方metric、episode计划完成率；共用sim时间轴展示多个camera、proprio/action通道、reward/goal/safety事件、chunk和deadline。coding任务另对齐agent工具调用与sim action；CALVIN标子目标分界；campaign显示开发与heldout边界；vector batch可选slot；实机标reset/人工介入。live录像和re-render须醒目标注，不能让不一致的重放视频冒充实际episode证据。EFE已将视频与评分解耦；媒体是否“必需”应在contract预先声明，不能事后凭一段缺失视频随意改分。[S310][S310]

### 5.6 Calibration与aggregation：避免“通过平台测试＝科学可比”

建议把calibration划成三项分别报告：①传输/资源/cleanup可用；②native grader和正常失败边界正确；③评测条件与目标benchmark的官方protocol一致。每项记录passed/failed/not_run，不能用empty跑通替代正例，也不能用单一seed的oracle推断seed全集。EFE的full/partial标签仅给出候选positive来源；native优先official expert或已知checkpoint，并经同一观测/action路径运行。无positive时允许开发接入，但正式比较状态应为“正例校准未核实”。

建议对每类保留如下校准证据：EC=同一提交的新进程重复验收+失败提交；EI=公共API脚本+reset/cutoff/hidden-success与deadline边界；EP=已知policy/expert、action units/frames/gripper校验、episode reset/chunk清空、seed计划一致性。还要至少检查一例“成功后撤销”、一例“目标短暂成立”、一例“必需记录缺失”，按本体规则决定结果，而不是全类别固定相同答案。采用这些用例的依据正是RoboCasa final/ever差异、BEHAVIOR hold和RoboDojo hidden finish；它们不是本轮已运行的测试。[S311][S311] [S312][S312] [S228][S228] [S095][S095]

聚合建议保存三层：每episode原始值、task/sequence/campaign值、benchmark官方汇总。给出planned/attempted/completed/valid/invalid/skipped数量和每个metric的分母，禁止将缺metric自动丢掉后仍称全量平均。Orbit valid-only可按task均值再跨task均值，官方errors=fail则将invalid按官方failValue纳入对应分母；同时显示二者，不把invalid改名valid 0。CALVIN需要完成1…5子任务的曲线及平均完成长度，roboEngineer需要all-cases与mean-case两层，BEHAVIOR还需q_score；这些不能由一个mean_success完整表达。CALVIN曲线具体官方发布格式本轮**未核实**，应先保存完整completed_subtasks原始记录再与官方runner核对。现有OfficialRule仅提供sample/task与error处理，复杂规则应保留原生report artifact并补显式aggregation实现。[S313][S313] [S309][S309] [S314][S314] [S255][S255] [S315][S315] [S097][S097]

## 6. 直接集成各 benchmark 的具体工作

### 6.1 必须直接注册的 native 包

下面均是**建议工程工作，未实现 / 未核实**。可调用固定版本官方environment/evaluator，也可复用vla-eval/Arena组件作为库，但注册身份、task manifest、episode计划、评分规则和验收证据归每个benchmark包。

| 直接benchmark / category | 可以复用的本地证据 | 接入前必须补齐的具体工作 |
|---|---|---|
| LIBERO-native / EP | vla-eval reset/step/observe与init-state索引 [S010][S010] | 锁定原版LIBERO commit、BDDL/assets/init-states；显式选择spatial/object/goal/10/90；把episode索引映射进trial计划而非总从0开始；固定resize/翻转/wrist/state、gripper/absolute模式；验证horizon、50episode/task等目标protocol；positive checkpoint/expert+empty；MAX/Pro/Plus/Mem分别注册 |
| RoboCasa-native / EP | v0.2 driver的task/scene与action补零 [S208][S208] [S211][S211] | 选择原版release与任务集合；决定是否允许base/torso，并忠实匹配目标protocol；固定layout/style、对象split、seed、registry horizon；确认成功是ever还是final；恢复官方多episode与scene权重；29 EFE cases不得冒充原版集 |
| RoboCasa365-native / EP | typed12D action、多相机state、间隔锁存success [S212][S212] [S215][S215] | 与v0.2独立包；固定split/registry、控制器和成功检查interval；保证policy chunk与check interval的关系；锁定reset seed与任务horizon；与官方脚本逐episode对照。GR1另包，补原生evaluator与native oracle，不能用Panda adapter |
| MetaWorld-native / EP | EFE锁定上游依赖及4D env调用可作入口 [S316][S316] [S069][S069] | 先读取目标版本官方ML/MT评测器，明确task/goal split与采样、policy所见state/image、control_mode、episode数与success定义；这些native细节目前未核实。用官方scripted policies作positive候选，但必须确认当前版本/seed适用性；不得复制EFE最终状态判分当official |
| RoboTwin-native / EP | 本地RoboTwin task/env与vla-eval seed筛选 [S317][S317] [S217][S217] | 锁定task_config/robot/assets与50task目标全集；显式保存候选seed→expert筛选→评估seed，限制筛选预算并校验cache fingerprint；固定seen/unseen文本；保留TOPP/IK执行、take_action计数；逐task检查max_steps；GPU sim/planner/policy联合资源；渲染优化需单独calibrate |
| ManiSkill-native / EP | ManiSkill2 driver与MIKASA ManiSkill3接口示例 [S244][S244] [S266][S266] | 首先选择ManiSkill2或3及官方task set，独立bench ID；官方reset seed、obs_mode、controller和horizon必须落实；RGBD不能创建后只转RGB却声称同protocol；记录动作归一化、gripper符号；3的vector env需要每slot独立seed/reset/mask。PandaDyn/RoboPaint独立保留 |
| SimplerEnv-native / EP | VM/VA条件构造、gripper与success模式 [S248][S248] [S251][S251] | 固定Google/WidowX模型、机器人频率、VM/VA变化网格与权重、seed、sticky gripper、camera/背景；选定官方success_mode与完整horizon；GPU renderer与模型分别分配；不能将real-to-sim命名成实机成绩 |
| CALVIN-native / EP long-horizon | sequence reset、oracle子任务检测和stateful执行 [S254][S254] [S255][S255] | 锁定ABC→D数据、1000条sequence与annotation；每trial一完整chain，scene不在子任务间reset；显式policy memory/chunk reset规则；保存completed_subtasks与1…5链统计；TinyRenderer需与目标官方视觉协议对照，否则单列renderer条件 |
| BEHAVIOR-native / EP | native BatchedEvaluator wrapper及q_score [S223][S223] [S227][S227] | 获取合法可用资产并锁定evaluator版本；B100/B1K任务集合、train/public/hidden instance与seeds明确；确认23D R1Pro action与camera/proprio处理；保留官方time budget/timeout/距离效率；普通task failure与policy/env error分开；不能加入EFE 30步静止条件。GPU RTX/显存与warmup实测后定资源 |
| MolmoSpaces-native / EP | JSON episode loader、judge_success [S229][S229] [S232][S232] | 绑定benchmark JSON、house/assets、机器人；澄清native频率和每family horizon；验证8D action适用robot，禁止默默pad/truncate作为通用兼容策略；记录final predicate与task.step结束规则 |
| RoboDojo-native / EP vector | layout queue、take_action_batch、skip/process_score [S236][S236] [S238][S238] | 明确official layout计划/可跳过条件/partial score；实现batch→独立episode身份映射、round barrier与不可partial reset；保存被筛掉的layout，不靠aggregate掩盖缺项；严重PhysX故障重建sim并留attempt |
| VLABench-native / EP | load_env、7D EE→IK、timestep.last [S241][S241] | 补seed/instance/任务集合与upstream termination语义核验；决定官方输入是否RGB/depth/pointcloud/state；核对action控制器与10Hz；不得把last无条件认成success后未经校准发布 |
| RoboLab / Arena-port / EP | 38task YAML、DROID adapter、SuccessRate [S195][S195] [S260][S260] | 可先明确注册为`robolab-arena-port`；固定USD/scenes/placement、physics backend、seed/rebuild、task horizon与success predicate。若要称native RoboLab，另做上游task/obs/action/初态/score差分与配对验证；不能仅因task同名宣称保真 |

### 6.2 EFE自身的直接注册

EFE category绑定规则可以由suite task元数据与交付合同生成：普通P→EC；普通S/RT→EI；EmbodiedSWE P→EC/executable；roboEngineer全suite→EC/campaign；Olympics Match按P skill或live/turn分别走EC/EI。每个task仍保留EFE task DIGEST、协议版本、frozen instance、oracle覆盖和原始reward字段；原来的Harbor目录可以作为安装/打包格式，不决定category。原始EFE是被评测benchmark时保留其包装，原生LIBERO等则直接注册新的native包，两者不合并排行榜。[S318][S318] [S175][S175] [S137][S137]

### 6.3 当前 Orbit 示例与新规格之间的明确缺口

1. **hub优先与用户目标不同。** Orbit design §9.14写“跟随hub与协议，不逐个追bench”，这是当前文档方向；本报告按用户本次要求提出category + benchmark直接身份，复用底层代码而不让hub变成必经中转。L0/L1/L2描述实现/打包成本，EC/EI/EP描述科学交互语义，是两个正交维度。[S319][S319]
2. **现有`kind`不是所需taxonomy。** contracts的bench capability `kind`仍是browser/desktop/mobile/other；示例VLA使用external/empty，不代表独立PolicySpec/具身category已实现。需要版本化category与profile字段，兼容现有method与adapter控制面。[S320][S320] [S015][S015]
3. **示例非通用20benchmark适配器。** tasks探测和solve都硬编码conda环境`libero`；main资源固定CPU4、RAM16GB、GPU0。BEHAVIOR、RoboTwin等不能沿用这些假设；应由每个直接bench的resource profile解析。[S321][S321] [S322][S322]
4. **trial.seed未落实环境样本。** solve只把registration params写入vla-eval YAML，未使用trial.seed；L1示例也固定seed7、episodes_per_task1。结合LIBERO按episode_idx选init state，每次新的调用会从episode0开始，改变Orbit trial seed不保证改变物理初态。需要显式episode计划与policy seed，并在产物中核对实际值。[S015][S015] [S323][S323] [S010][S010]
5. **当前verify是重读aggregate，不是独立评分。** check.py检查有episode和success字段，选排序后的最后一个aggregate；没有证明task/seed/计划episode数、可信生产者或完整原始trace。它可以作为格式检查，不能独自满足native trial真实性和完整性验收。[S324][S324]
6. **一组episodes合成一个trial会损失有效性粒度。** 示例先对所有episode算mean_success，再按error数处理。只要一部分episode出错，不能让官方聚合把整个组的成功样本一起清零，或只保留错误以外的均值却遗漏分母；需逐episode导入/逐trial计划，或显式compound-trial结果。[S325][S325] [S326][S326]
7. **catalog是证据索引，不是本轮复现。** catalog的支持/校准声明与旧embodied研究笔记已读取用于定位代码；本轮没有验证其中运行成绩、GPU sidecar正例或Arena运行稳定性。不能把文档支持矩阵当本报告实测。[S327][S327] [S328][S328]
8. **Orbit/OSMO不能双重分配同一GPU。** 若未来使用OSMO，应作为明确执行backend或外部服务边界，设备租约只有一个最终owner。当前建议在Orbit容器内直接执行native env/policy，复用Arena组件而不引入另一套控制面；这一点是架构建议，非OSMO已有机器人评分能力。[S329][S329] [S292][S292]

## 7. 会击穿朴素分类的边界情况

| 朴素判断 | 反例与后果 | category/profile应如何表达 |
|---|---|---|
| 同名机器人任务就是同一benchmark | EFE BEHAVIOR改subject、25D动作与30步goal保持；native是23D evaluator path。[S228][S228] [S222][S222] | 上游版本、wrapper、成功条件都进identity；EFE与native分别注册 |
| standard等于policy step | roboEngineer封存数值policy；Match有turn与skill。[S096][S096] [S012][S012] | 按真实交付/调用合同归类，不按后缀 |
| privileged意味着可读所有目标 | iSpatialGym提供scene但隐藏target checker；可见信息维度并非一个布尔值。[S298][S298] | observation allowlist、goal visibility分别列 |
| MuJoCo都CPU、Isaac都需要同样GPU | BiGym2还带controller，roboEngineer G1在main训练GPU而evaluator CPU；roboARC混合引擎。[S330][S330] [S098][S098] [S331][S331] | 资源按角色/阶段/任务声明，GPU compute与graphics分开 |
| control Hz就是policy Hz | RoboTwin TOPP一action展开多physics steps；chunk执行多动作；CALVIN子目标切换。[S332][S332] [S198][S198] [S255][S255] | physics/control/query cadence与action展开映射分别记录 |
| realtime协议版本即可推导时钟 | RoboARC standard用2.4；Match RT还有冻结review及同步skill等待。[S165][S165] [S306][S306] | timing profile显式，不能按protocol数字推断 |
| 一次step返回done就成功 | LIBERO driver这样解释；ManiSkill2终止/截断另看info；VLABench last解释仍需核验。[S333][S333] [S245][S245] [S242][S242] | terminate与success独立typed字段，逐bench映射 |
| success只是一个可随时读取的布尔值 | RoboCasa365间隔锁存、EFE RoboCasa末态、BEHAVIOR hold、RoboDojo隐藏finish。[S215][S215] [S312][S312] [S228][S228] [S095][S095] | score sampling、visibility、hold/latch/final各自版本化 |
| 有轨迹就能事后重放评分 | EFE明确S/RT按live，某些sim不保证bitwise可回放；视频源必须标注。[S310][S310] | 评分和媒体生命周期分开，不用replay覆盖live verdict |
| 多次agent seed等于多物理seed | EFE冻结实例；当前Orbit LIBERO示例不传trial.seed。[S192][S192] [S015][S015] | seed向量+init-state identity，统计独立性另述 |
| batch只是加速 | Arena等所有env需要chunk时会hold早结束env；RoboDojo要求round reset。[S287][S287] [S236][S236] | batch barrier、待机动作、计时、seed分配都纳入条件 |
| error永远0或永远invalid | Match有agent-caused world_step的有效0；vla-eval普通错误计官方failure，EpisodeSkipped另行处理。[S334][S334] [S281][S281] | 同时保存native outcome、Orbit validity、official分母映射 |
| empty一定0，full oracle一定可用 | no-op可被静态已满足目标、自动动力学或hold规则影响；元数据标签不提供本轮运行证据。ABC为ball-tray专门避免静止即得分。[S335][S335] [S119][S119] | 校准预期按实例定义；full仍需本版本实跑，partial只验覆盖subset |
| simulator/domain决定类别 | ManiSkill可承载native policy、PandaDyn编程、RoboPaint图像/过程评分；EmbodiedSWE本身coding。[S244][S244] [S081][S081] [S103][S103] [S199][S199] | category按subject contract；sim作为implementation字段 |
| 只要用真机器人数据就是实机bench | Simpler driver构建仿真env；实机reset/独占lease在本轮未找到完整验证链。[S249][S249] | real-hardware profile独立验收；Docker只隔离软件，不等于复位物理世界 |
| 工作流成功就是评测有效 | OSMO COMPLETED是task状态；Arena失败Run可被collector排除。[S292][S292] [S293][S293] | 执行成功、结果完整、trial valid、任务success四层记录 |


## 8. 复核方法与尚未完成的验证

本轮只进行了目录/配置解析、源码阅读、引用路径检查；没有修改任何被审计仓库，也没有启动GPU作业、下载资产、访问在线服务或发送消息。所有simulation/policy/calibration结果均为 **未核实**。以下只读脚本可重算35套件的task、mode和oracle计数；它不执行task代码：

```python
from pathlib import Path
from collections import Counter
import tomllib  # Python 3.11+

root = Path("embodied-first-exam/tasks")
all_modes, all_oracles = Counter(), Counter()
for suite in sorted(p for p in root.iterdir() if p.is_dir()):
    modes, oracles = Counter(), Counter()
    for path in sorted(suite.glob("*/task.toml")):
        cfg = tomllib.loads(path.read_text())
        name = path.parent.name
        mode = ("RT" if name.endswith("-standard-realtime") else
                "P" if name.endswith("-privileged") else
                "S" if name.endswith("-standard") else "unknown")
        oracle = cfg["metadata"].get("oracle", "unknown")
        modes[mode] += 1
        oracles[oracle] += 1
        if oracle in {"full", "partial"}:
            assert any((path.parent / "solution").glob("*")), path
    print(suite.name, sum(modes.values()), dict(modes), dict(oracles))
    all_modes.update(modes)
    all_oracles.update(oracles)
print("TOTAL", dict(all_modes), dict(all_oracles))
```

待执行验收应以§6每个直接bench为单位：补齐native官方协议来源、锁定所有依赖与资产、验证actual observation/action schema、positive/negative/empty校准、seed/episode计划对齐、故障映射、角色资源实测、最终trace/UI复核。尤其最小显存、跨GPU/CPU/renderer等价、随机seed全集、完整upstream success predicates、所有oracle成功率、隐藏test集可用性、真实机器人全流程均 **未核实**。本报告给出的是可以逐项落实的分类与规格，不是“35 suites已原生接入Orbit”的认证。

## 9. 本地证据索引

路径均以本轮本地工作树为准；数字为行号入口。目录链接用于全量清点/代码存在性证据，不能单独证明运行或官方等价。

| 编号 | 本地文件或目录（行号为入口） |
|---|---|
| S001 | [orbit/.git][S001] |
| S002 | [embodied-first-exam/.git][S002] |
| S003 | [vla-evaluation-harness/.git][S003] |
| S004 | [IsaacLab-Arena/.git][S004] |
| S005 | [OSMO/.git][S005] |
| S006 | [embodied-first-exam/third_party/RoboTwin/.git][S006] |
| S007 | [IsaacLab-Arena/submodules/IsaacLab/.git][S007] |
| S008 | [IsaacLab-Arena/submodules/Isaac-GR00T/.git][S008] |
| S009 | [embodied-first-exam/docs/protocol/README.md:70][S009] |
| S010 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:179][S010] |
| S011 | [embodied-first-exam/tasks/roboengineer/README.md:70][S011] |
| S012 | [embodied-first-exam/tasks/embodied-olympics-match/README.md:48][S012] |
| S013 | [embodied-first-exam/tasks/embodiedswe/README.md:35][S013] |
| S014 | [orbit/docs/design.md:550][S014] |
| S015 | [orbit/examples/bench-adapters/vla-eval/adapter.py:160][S015] |
| S016 | [embodied-first-exam/tasks][S016] |
| S017 | [embodied-first-exam/docs/core_set.toml][S017] |
| S018 | [embodied-first-exam/docs/protocol/README.md:130][S018] |
| S019 | [embodied-first-exam/docs/protocol/README.md:278][S019] |
| S020 | [embodied-first-exam/docs/protocol/README.md:143][S020] |
| S021 | [embodied-first-exam/images/abc-sim/Dockerfile:15][S021] |
| S022 | [embodied-first-exam/images/abc-sim/tools/rcb_abc.py:86][S022] |
| S023 | [embodied-first-exam/images/abc-sim/tools/standard/server.py:9][S023] |
| S024 | [embodied-first-exam/images/ambench/Dockerfile:42][S024] |
| S025 | [embodied-first-exam/embodied_first_exam/benchmarks/ambench/privileged/environment/rcb_ambench.py:628][S025] |
| S026 | [embodied-first-exam/images/autobio/Dockerfile:26][S026] |
| S027 | [embodied-first-exam/tasks/autobio/autobio-insert-centrifuge-5430-i00-privileged/environment/rcb_autobio.py:50][S027] |
| S028 | [embodied-first-exam/images/behavior/Dockerfile:10][S028] |
| S029 | [embodied-first-exam/embodied_first_exam/benchmarks/behavior-1k/rcb_behavior.py:1390][S029] |
| S030 | [embodied-first-exam/images/bigym2/Dockerfile:29][S030] |
| S031 | [embodied-first-exam/embodied_first_exam/benchmarks/bigym2/privileged/environment/rcb_bigym2.py:91][S031] |
| S032 | [embodied-first-exam/embodied_first_exam/benchmarks/bigym2/privileged/environment/rcb_bigym2.py:147][S032] |
| S033 | [embodied-first-exam/images/dexhand/Dockerfile:17][S033] |
| S034 | [embodied-first-exam/embodied_first_exam/benchmarks/dexhand/sim/server.py:69][S034] |
| S035 | [embodied-first-exam/embodied_first_exam/benchmarks/dexhand/privileged/tests/grade.py:118][S035] |
| S036 | [embodied-first-exam/images/dexjoco/Dockerfile:13][S036] |
| S037 | [embodied-first-exam/embodied_first_exam/benchmarks/dexjoco/privileged/environment/rcb_dexjoco.py:312][S037] |
| S038 | [embodied-first-exam/embodied_first_exam/benchmarks/dexjoco/privileged/tests/grade.py:137][S038] |
| S039 | [embodied-first-exam/embodied_first_exam/benchmarks/dextoolbench/privileged/environment/rcb_dtb.py:42][S039] |
| S040 | [embodied-first-exam/embodied_first_exam/benchmarks/dextoolbench/sim/server_mj.py:622][S040] |
| S041 | [embodied-first-exam/images/embodied-olympics-fun/Dockerfile:12][S041] |
| S042 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-fun/rcb_rfo.py:125][S042] |
| S043 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-fun/standard/server.py:167][S043] |
| S044 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-match/standard-realtime/tests/grade.py:96][S044] |
| S045 | [embodied-first-exam/tasks/embodied-olympics-match/README.md:81][S045] |
| S046 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-safety-exam/standard/server.py:282][S046] |
| S047 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-safety-exam/standard/server.py:442][S047] |
| S048 | [embodied-first-exam/images/embodiedswe/Dockerfile:77][S048] |
| S049 | [embodied-first-exam/embodied_first_exam/benchmarks/embodiedswe/rcb_embodiedswe.py:902][S049] |
| S050 | [embodied-first-exam/images/humanoidbench/Dockerfile:50][S050] |
| S051 | [embodied-first-exam/embodied_first_exam/benchmarks/humanoidbench/privileged/tests/rcb_rewards.py][S051] |
| S052 | [embodied-first-exam/embodied_first_exam/benchmarks/humanoidbench/sim/server.py:203][S052] |
| S053 | [embodied-first-exam/images/ispatialgym/Dockerfile:43][S053] |
| S054 | [embodied-first-exam/embodied_first_exam/benchmarks/ispatialgym/sim/server.py:104][S054] |
| S055 | [embodied-first-exam/embodied_first_exam/benchmarks/ispatialgym/standard/tests/grade.py:20][S055] |
| S056 | [embodied-first-exam/images/kinder/Dockerfile:17][S056] |
| S057 | [embodied-first-exam/embodied_first_exam/benchmarks/kinder/privileged/environment/rcb_kinder.py:154][S057] |
| S058 | [embodied-first-exam/embodied_first_exam/benchmarks/kinder/sim/server.py:50][S058] |
| S059 | [embodied-first-exam/images/labutopia/Dockerfile:46][S059] |
| S060 | [embodied-first-exam/tasks/labutopia/labutopia-open-door-i00-privileged/environment/rcb_labutopia.py:55][S060] |
| S061 | [embodied-first-exam/tasks/labutopia/labutopia-open-door-i00-privileged/environment/rcb_labutopia.py:257][S061] |
| S062 | [embodied-first-exam/images/libero-max/Dockerfile:22][S062] |
| S063 | [embodied-first-exam/embodied_first_exam/benchmarks/libero-max/sim/server.py:90][S063] |
| S064 | [embodied-first-exam/embodied_first_exam/benchmarks/libero-max/sim/server.py:173][S064] |
| S065 | [embodied-first-exam/images/maniguard/Dockerfile:93][S065] |
| S066 | [embodied-first-exam/embodied_first_exam/benchmarks/maniguard/privileged/environment/rcb_maniguard.py:17][S066] |
| S067 | [embodied-first-exam/embodied_first_exam/benchmarks/maniguard/standard/tests/grade.py:21][S067] |
| S068 | [embodied-first-exam/images/metaworld/requirements.txt:1][S068] |
| S069 | [embodied-first-exam/embodied_first_exam/benchmarks/metaworldplus/privileged/environment/mw_tool.py:35][S069] |
| S070 | [embodied-first-exam/embodied_first_exam/benchmarks/metaworldplus/privileged/environment/mw_tool.py:348][S070] |
| S071 | [embodied-first-exam/images/molmospaces/Dockerfile:13][S071] |
| S072 | [embodied-first-exam/embodied_first_exam/benchmarks/molmospaces/privileged/environment/rcb_molmospaces.py:256][S072] |
| S073 | [embodied-first-exam/embodied_first_exam/benchmarks/molmospaces/standard/tests/grade.py:30][S073] |
| S074 | [embodied-first-exam/embodied_first_exam/benchmarks/mujoco-playground/privileged/environment/rcb_quadruped.py][S074] |
| S075 | [embodied-first-exam/embodied_first_exam/benchmarks/mujoco-playground/sim/server_mj.py:348][S075] |
| S076 | [embodied-first-exam/images/myosuite/Dockerfile:18][S076] |
| S077 | [embodied-first-exam/embodied_first_exam/benchmarks/myosuite/privileged/environment/rcb_myosuite.py:415][S077] |
| S078 | [embodied-first-exam/embodied_first_exam/benchmarks/myosuite/privileged/environment/rcb_myosuite.py:457][S078] |
| S079 | [embodied-first-exam/images/pandadyn/Dockerfile][S079] |
| S080 | [embodied-first-exam/embodied_first_exam/benchmarks/pandadyn/privileged/environment/rcb_pandadyn.py:189][S080] |
| S081 | [embodied-first-exam/embodied_first_exam/benchmarks/pandadyn/sim/server.py:83][S081] |
| S082 | [embodied-first-exam/embodied_first_exam/benchmarks/roboarc/rcb_topogym.py:3488][S082] |
| S083 | [embodied-first-exam/embodied_first_exam/benchmarks/roboarc/rcb_topogym.py:3897][S083] |
| S084 | [embodied-first-exam/embodied_first_exam/benchmarks/roboarc/standard/grade.py:44][S084] |
| S085 | [embodied-first-exam/embodied_first_exam/benchmarks/roboarc/ikea/privileged/environment/rcb_ikea.py:422][S085] |
| S086 | [embodied-first-exam/images/robocasa/Dockerfile:17][S086] |
| S087 | [embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:382][S087] |
| S088 | [embodied-first-exam/images/robocasa-gr1/Dockerfile:20][S088] |
| S089 | [embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:281][S089] |
| S090 | [embodied-first-exam/tasks/robocasa-gr1/robocasa-gr1-bottle-to-cabinet-close-i00-standard/environment/sim/Dockerfile:5][S090] |
| S091 | [embodied-first-exam/images/robocasa365/Dockerfile:19][S091] |
| S092 | [embodied-first-exam/embodied_first_exam/benchmarks/robocasa365/privileged/environment/casa_tool.py:391][S092] |
| S093 | [embodied-first-exam/images/robodojo/Dockerfile:32][S093] |
| S094 | [embodied-first-exam/embodied_first_exam/benchmarks/robodojo/privileged/environment/rcb_robodojo.py:466][S094] |
| S095 | [embodied-first-exam/embodied_first_exam/benchmarks/robodojo/sim/server.py:242][S095] |
| S096 | [embodied-first-exam/embodied_first_exam/benchmarks/roboengineer/standard/tests/grade.py:66][S096] |
| S097 | [embodied-first-exam/embodied_first_exam/benchmarks/roboengineer/standard/tests/grade.py:125][S097] |
| S098 | [embodied-first-exam/tasks/roboengineer/README.md:109][S098] |
| S099 | [embodied-first-exam/images/robolab/Dockerfile:31][S099] |
| S100 | [embodied-first-exam/embodied_first_exam/benchmarks/robolab/rcb_robolab.py:949][S100] |
| S101 | [embodied-first-exam/embodied_first_exam/benchmarks/robolab/sim/server.py:211][S101] |
| S102 | [embodied-first-exam/images/robopaint/Dockerfile:55][S102] |
| S103 | [embodied-first-exam/embodied_first_exam/benchmarks/robopaint/rcb_brush_score.py:308][S103] |
| S104 | [embodied-first-exam/embodied_first_exam/benchmarks/robopaint/rcb_brush_strict.py:30][S104] |
| S105 | [embodied-first-exam/embodied_first_exam/benchmarks/robopaint/standard/grade.py:1][S105] |
| S106 | [embodied-first-exam/.gitmodules:1][S106] |
| S107 | [embodied-first-exam/embodied_first_exam/benchmarks/robotwin-2/sim/server.py:27][S107] |
| S108 | [embodied-first-exam/embodied_first_exam/benchmarks/robotwin-2/sim/server.py:106][S108] |
| S109 | [embodied-first-exam/tasks/robotwin-2/README.md:87][S109] |
| S110 | [embodied-first-exam/images/robowits/Dockerfile:19][S110] |
| S111 | [embodied-first-exam/embodied_first_exam/benchmarks/robowits/privileged/tests/rcb_robowits.py:96][S111] |
| S112 | [embodied-first-exam/embodied_first_exam/benchmarks/robowits/sim/server.py:312][S112] |
| S113 | [embodied-first-exam/images/vlabench/Dockerfile:21][S113] |
| S114 | [embodied-first-exam/embodied_first_exam/benchmarks/vlabench/privileged/environment/vlb_tool.py:198][S114] |
| S115 | [embodied-first-exam/embodied_first_exam/benchmarks/vlabench/privileged/environment/vlb_tool.py:297][S115] |
| S116 | [embodied-first-exam/images/yamlab/Dockerfile:43][S116] |
| S117 | [embodied-first-exam/embodied_first_exam/benchmarks/yamlab/privileged/environment/rcb_yamlab.py:569][S117] |
| S118 | [embodied-first-exam/tasks/abc-sim/README.md][S118] |
| S119 | [embodied-first-exam/tasks/abc-sim][S119] |
| S120 | [embodied-first-exam/tasks/ambench/README.md][S120] |
| S121 | [embodied-first-exam/tasks/ambench][S121] |
| S122 | [embodied-first-exam/tasks/autobio/README.md][S122] |
| S123 | [embodied-first-exam/tasks/autobio][S123] |
| S124 | [embodied-first-exam/tasks/behavior-1k/README.md][S124] |
| S125 | [embodied-first-exam/tasks/behavior-1k][S125] |
| S126 | [embodied-first-exam/tasks/bigym2/README.md][S126] |
| S127 | [embodied-first-exam/tasks/bigym2][S127] |
| S128 | [embodied-first-exam/tasks/dexhand/README.md][S128] |
| S129 | [embodied-first-exam/tasks/dexhand][S129] |
| S130 | [embodied-first-exam/tasks/dexjoco/README.md][S130] |
| S131 | [embodied-first-exam/tasks/dexjoco][S131] |
| S132 | [embodied-first-exam/tasks/dextoolbench/README.md][S132] |
| S133 | [embodied-first-exam/tasks/dextoolbench][S133] |
| S134 | [embodied-first-exam/tasks/embodied-olympics-fun/README.md][S134] |
| S135 | [embodied-first-exam/tasks/embodied-olympics-fun][S135] |
| S136 | [embodied-first-exam/tasks/embodied-olympics-match/README.md][S136] |
| S137 | [embodied-first-exam/tasks/embodied-olympics-match][S137] |
| S138 | [embodied-first-exam/tasks/embodied-safety-exam/README.md][S138] |
| S139 | [embodied-first-exam/tasks/embodied-safety-exam][S139] |
| S140 | [embodied-first-exam/tasks/embodiedswe/README.md][S140] |
| S141 | [embodied-first-exam/tasks/embodiedswe][S141] |
| S142 | [embodied-first-exam/tasks/humanoidbench/README.md][S142] |
| S143 | [embodied-first-exam/tasks/humanoidbench][S143] |
| S144 | [embodied-first-exam/tasks/ispatialgym/README.md][S144] |
| S145 | [embodied-first-exam/tasks/ispatialgym][S145] |
| S146 | [embodied-first-exam/tasks/kinder/README.md][S146] |
| S147 | [embodied-first-exam/tasks/kinder][S147] |
| S148 | [embodied-first-exam/tasks/labutopia/README.md][S148] |
| S149 | [embodied-first-exam/tasks/labutopia][S149] |
| S150 | [embodied-first-exam/tasks/libero-max/README.md][S150] |
| S151 | [embodied-first-exam/tasks/libero-max][S151] |
| S152 | [embodied-first-exam/tasks/maniguard/README.md][S152] |
| S153 | [embodied-first-exam/tasks/maniguard][S153] |
| S154 | [embodied-first-exam/tasks/metaworldplus/README.md][S154] |
| S155 | [embodied-first-exam/tasks/metaworldplus][S155] |
| S156 | [embodied-first-exam/tasks/molmospaces/README.md][S156] |
| S157 | [embodied-first-exam/tasks/molmospaces][S157] |
| S158 | [embodied-first-exam/tasks/mujoco-playground/README.md][S158] |
| S159 | [embodied-first-exam/tasks/mujoco-playground][S159] |
| S160 | [embodied-first-exam/tasks/myosuite/README.md][S160] |
| S161 | [embodied-first-exam/tasks/myosuite][S161] |
| S162 | [embodied-first-exam/tasks/pandadyn/README.md][S162] |
| S163 | [embodied-first-exam/tasks/pandadyn][S163] |
| S164 | [embodied-first-exam/tasks/roboarc/README.md][S164] |
| S165 | [embodied-first-exam/tasks/roboarc][S165] |
| S166 | [embodied-first-exam/tasks/robocasa/README.md][S166] |
| S167 | [embodied-first-exam/tasks/robocasa][S167] |
| S168 | [embodied-first-exam/tasks/robocasa-gr1/README.md][S168] |
| S169 | [embodied-first-exam/tasks/robocasa-gr1][S169] |
| S170 | [embodied-first-exam/tasks/robocasa365/README.md][S170] |
| S171 | [embodied-first-exam/tasks/robocasa365][S171] |
| S172 | [embodied-first-exam/tasks/robodojo/README.md][S172] |
| S173 | [embodied-first-exam/tasks/robodojo][S173] |
| S174 | [embodied-first-exam/tasks/roboengineer/README.md][S174] |
| S175 | [embodied-first-exam/tasks/roboengineer][S175] |
| S176 | [embodied-first-exam/tasks/robolab/README.md][S176] |
| S177 | [embodied-first-exam/tasks/robolab][S177] |
| S178 | [embodied-first-exam/tasks/robopaint/README.md][S178] |
| S179 | [embodied-first-exam/tasks/robopaint][S179] |
| S180 | [embodied-first-exam/tasks/robotwin-2/README.md][S180] |
| S181 | [embodied-first-exam/tasks/robotwin-2][S181] |
| S182 | [embodied-first-exam/tasks/robowits/README.md][S182] |
| S183 | [embodied-first-exam/tasks/robowits][S183] |
| S184 | [embodied-first-exam/tasks/vlabench/README.md][S184] |
| S185 | [embodied-first-exam/tasks/vlabench][S185] |
| S186 | [embodied-first-exam/tasks/yamlab/README.md][S186] |
| S187 | [embodied-first-exam/tasks/yamlab][S187] |
| S188 | [embodied-first-exam/docs/protocol/README.md:119][S188] |
| S189 | [embodied-first-exam/tasks/robodojo/README.md:110][S189] |
| S190 | [embodied-first-exam/tasks/ambench/README.md:176][S190] |
| S191 | [embodied-first-exam/docs/protocol/README.md:47][S191] |
| S192 | [embodied-first-exam/docs/protocol/running.md:27][S192] |
| S193 | [embodied-first-exam/docs/protocol/README.md:261][S193] |
| S194 | [embodied-first-exam/docs/protocol/running.md:8][S194] |
| S195 | [IsaacLab-Arena/isaaclab_arena_environments/robolab/tasks][S195] |
| S196 | [IsaacLab-Arena/isaaclab_arena_environments/robolab/task_catalog.md][S196] |
| S197 | [vla-evaluation-harness/src/vla_eval/benchmarks/base.py:1][S197] |
| S198 | [vla-evaluation-harness/src/vla_eval/model_servers/predict.py:13][S198] |
| S199 | [embodied-first-exam/tasks/embodiedswe/README.md:1][S199] |
| S200 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:48][S200] |
| S201 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:225][S201] |
| S202 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:270][S202] |
| S203 | [embodied-first-exam/tasks/libero-max/README.md:1][S203] |
| S204 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero_pro/benchmark.py:40][S204] |
| S205 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero_plus/benchmark.py:41][S205] |
| S206 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero_plus/benchmark.py:94][S206] |
| S207 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero_mem/benchmark.py:14][S207] |
| S208 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:40][S208] |
| S209 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:72][S209] |
| S210 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:211][S210] |
| S211 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:234][S211] |
| S212 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:61][S212] |
| S213 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:118][S213] |
| S214 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:196][S214] |
| S215 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:214][S215] |
| S216 | [vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:238][S216] |
| S217 | [vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:368][S217] |
| S218 | [vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:479][S218] |
| S219 | [vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:513][S219] |
| S220 | [embodied-first-exam/third_party/RoboTwin/envs/_base_task.py:1603][S220] |
| S221 | [embodied-first-exam/third_party/RoboTwin/scripts/eval_policy_multitask.py:1056][S221] |
| S222 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:59][S222] |
| S223 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:188][S223] |
| S224 | [vla-evaluation-harness/docker/Dockerfile.behavior1k:11][S224] |
| S225 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:240][S225] |
| S226 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:257][S226] |
| S227 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:330][S227] |
| S228 | [embodied-first-exam/embodied_first_exam/benchmarks/behavior-1k/rcb_behavior.py:1414][S228] |
| S229 | [vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:142][S229] |
| S230 | [vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:165][S230] |
| S231 | [vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:213][S231] |
| S232 | [vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:296][S232] |
| S233 | [vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:354][S233] |
| S234 | [embodied-first-exam/tasks/molmospaces/README.md:72][S234] |
| S235 | [vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:82][S235] |
| S236 | [vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:386][S236] |
| S237 | [vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:441][S237] |
| S238 | [vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:483][S238] |
| S239 | [vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:553][S239] |
| S240 | [vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:54][S240] |
| S241 | [vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:102][S241] |
| S242 | [vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:135][S242] |
| S243 | [vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:48][S243] |
| S244 | [vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:118][S244] |
| S245 | [vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:142][S245] |
| S246 | [vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:183][S246] |
| S247 | [vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:48][S247] |
| S248 | [vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:145][S248] |
| S249 | [vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:202][S249] |
| S250 | [vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:332][S250] |
| S251 | [vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:384][S251] |
| S252 | [vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:160][S252] |
| S253 | [vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:227][S253] |
| S254 | [vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:458][S254] |
| S255 | [vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:509][S255] |
| S256 | [vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:622][S256] |
| S257 | [IsaacLab-Arena/isaaclab_arena_environments/robolab/tasks/banana_in_bowl.yaml:6][S257] |
| S258 | [IsaacLab-Arena/isaaclab_arena_openpi/policy/droid_adapter.py:17][S258] |
| S259 | [IsaacLab-Arena/isaaclab_arena/environments/isaaclab_arena_manager_based_env_cfg.py:185][S259] |
| S260 | [IsaacLab-Arena/isaaclab_arena/metrics/success_rate.py:24][S260] |
| S261 | [vla-evaluation-harness/src/vla_eval/benchmarks][S261] |
| S262 | [embodied-first-exam/embodied_first_exam/benchmarks][S262] |
| S263 | [embodied-first-exam/images][S263] |
| S264 | [IsaacLab-Arena/isaaclab_arena_environments][S264] |
| S265 | [IsaacLab-Arena/README.md:254][S265] |
| S266 | [vla-evaluation-harness/src/vla_eval/benchmarks/mikasa/benchmark.py:73][S266] |
| S267 | [vla-evaluation-harness/src/vla_eval/benchmarks/robomme/benchmark.py:161][S267] |
| S268 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocerebra/benchmark.py:35][S268] |
| S269 | [vla-evaluation-harness/src/vla_eval/benchmarks/duobench/benchmark.py:90][S269] |
| S270 | [vla-evaluation-harness/src/vla_eval/benchmarks/kinetix/benchmark.py:73][S270] |
| S271 | [vla-evaluation-harness/src/vla_eval/benchmarks/ocbench/benchmark.py:41][S271] |
| S272 | [vla-evaluation-harness/src/vla_eval/protocol/messages.py:15][S272] |
| S273 | [vla-evaluation-harness/src/vla_eval/connection.py][S273] |
| S274 | [vla-evaluation-harness/src/vla_eval/runners/sync_runner.py:25][S274] |
| S275 | [vla-evaluation-harness/src/vla_eval/runners/live_runner.py:41][S275] |
| S276 | [vla-evaluation-harness/src/vla_eval/model_servers/engine.py][S276] |
| S277 | [vla-evaluation-harness/src/vla_eval/runners/vector_runner.py][S277] |
| S278 | [vla-evaluation-harness/src/vla_eval/benchmarks/base.py:74][S278] |
| S279 | [vla-evaluation-harness/src/vla_eval/recording.py:53][S279] |
| S280 | [vla-evaluation-harness/src/vla_eval/recording.py:533][S280] |
| S281 | [vla-evaluation-harness/src/vla_eval/orchestrator.py:429][S281] |
| S282 | [vla-evaluation-harness/src/vla_eval/results/collector.py:63][S282] |
| S283 | [IsaacLab-Arena/isaaclab_arena/evaluation/policy_runner.py:66][S283] |
| S284 | [IsaacLab-Arena/isaaclab_arena/evaluation/policy_runner.py:197][S284] |
| S285 | [IsaacLab-Arena/isaaclab_arena/policy/remote_policy_base.py:64][S285] |
| S286 | [IsaacLab-Arena/isaaclab_arena/policy/remote_policy_base.py:157][S286] |
| S287 | [IsaacLab-Arena/isaaclab_arena/policy/action_scheduling/synced_batch_action_scheduler.py:16][S287] |
| S288 | [IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:40][S288] |
| S289 | [IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:100][S289] |
| S290 | [IsaacLab-Arena/isaaclab_arena_vlm_agent/action_adapter.py][S290] |
| S291 | [IsaacLab-Arena/osmo/workflows/arena_experiment_workflow.py:51][S291] |
| S292 | [OSMO/src/utils/job/workflow.py:52][S292] |
| S293 | [IsaacLab-Arena/osmo/scripts/build_experiment_output.py:142][S293] |
| S294 | [IsaacLab-Arena/isaaclab_arena_openpi/policy/droid_adapter.py:30][S294] |
| S295 | [embodied-first-exam/docs/protocol/README.md:84][S295] |
| S296 | [IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:118][S296] |
| S297 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero_mem/benchmark.py:33][S297] |
| S298 | [embodied-first-exam/tasks/ispatialgym/README.md:88][S298] |
| S299 | [vla-evaluation-harness/src/vla_eval/benchmarks/robomme/benchmark.py:244][S299] |
| S300 | [orbit/packages/orbit/src/contracts/bench.ts:219][S300] |
| S301 | [orbit/packages/orbit/src/contracts/bench.ts:333][S301] |
| S302 | [orbit/packages/orbit/src/contracts/bench.ts:370][S302] |
| S303 | [orbit/packages/orbit/src/contracts/trajectory.ts:28][S303] |
| S304 | [embodied-first-exam/docs/protocol/README.md:295][S304] |
| S305 | [embodied-first-exam/embodied_first_exam/benchmarks/embodiedswe/esw_proxy.py][S305] |
| S306 | [embodied-first-exam/tasks/embodied-olympics-match/README.md:83][S306] |
| S307 | [orbit/docs/design.md:459][S307] |
| S308 | [orbit/docs/design.md:499][S308] |
| S309 | [orbit/docs/design.md:537][S309] |
| S310 | [embodied-first-exam/docs/protocol/README.md:124][S310] |
| S311 | [vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:249][S311] |
| S312 | [embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:397][S312] |
| S313 | [orbit/packages/orbit/src/contracts/bench.ts:365][S313] |
| S314 | [vla-evaluation-harness/src/vla_eval/results/collector.py:85][S314] |
| S315 | [vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:362][S315] |
| S316 | [embodied-first-exam/images/metaworld/requirements.txt][S316] |
| S317 | [embodied-first-exam/third_party/RoboTwin/envs][S317] |
| S318 | [embodied-first-exam/docs/protocol/README.md:330][S318] |
| S319 | [orbit/docs/design.md:979][S319] |
| S320 | [orbit/packages/orbit/src/contracts/bench.ts:157][S320] |
| S321 | [orbit/examples/bench-adapters/vla-eval/adapter.py:76][S321] |
| S322 | [orbit/examples/bench-adapters/vla-eval/adapter.py:200][S322] |
| S323 | [orbit/examples/bench-manifests/vla-eval-libero/orbit-bench.yaml:1][S323] |
| S324 | [orbit/examples/bench-adapters/vla-eval/check.py:9][S324] |
| S325 | [orbit/examples/bench-adapters/vla-eval/adapter.py:231][S325] |
| S326 | [orbit/examples/bench-adapters/vla-eval/adapter.py:270][S326] |
| S327 | [orbit/docs/catalog.md][S327] |
| S328 | [orbit/docs/research/embodied-bench][S328] |
| S329 | [IsaacLab-Arena/osmo/workflows/arena_experiment_workflow.py:70][S329] |
| S330 | [embodied-first-exam/images/bigym2/Dockerfile][S330] |
| S331 | [embodied-first-exam/tasks/roboarc/README.md:70][S331] |
| S332 | [embodied-first-exam/third_party/RoboTwin/envs/_base_task.py:1611][S332] |
| S333 | [vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:297][S333] |
| S334 | [embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-match/standard-realtime/tests/grade.py:111][S334] |
| S335 | [embodied-first-exam/images/abc-sim/tools/rcb_abc.py][S335] |

[S001]: orbit/.git
[S002]: embodied-first-exam/.git
[S003]: vla-evaluation-harness/.git
[S004]: IsaacLab-Arena/.git
[S005]: OSMO/.git
[S006]: embodied-first-exam/third_party/RoboTwin/.git
[S007]: IsaacLab-Arena/submodules/IsaacLab/.git
[S008]: IsaacLab-Arena/submodules/Isaac-GR00T/.git
[S009]: embodied-first-exam/docs/protocol/README.md:70
[S010]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:179
[S011]: embodied-first-exam/tasks/roboengineer/README.md:70
[S012]: embodied-first-exam/tasks/embodied-olympics-match/README.md:48
[S013]: embodied-first-exam/tasks/embodiedswe/README.md:35
[S014]: orbit/docs/design.md:550
[S015]: orbit/examples/bench-adapters/vla-eval/adapter.py:160
[S016]: embodied-first-exam/tasks
[S017]: embodied-first-exam/docs/core_set.toml
[S018]: embodied-first-exam/docs/protocol/README.md:130
[S019]: embodied-first-exam/docs/protocol/README.md:278
[S020]: embodied-first-exam/docs/protocol/README.md:143
[S021]: embodied-first-exam/images/abc-sim/Dockerfile:15
[S022]: embodied-first-exam/images/abc-sim/tools/rcb_abc.py:86
[S023]: embodied-first-exam/images/abc-sim/tools/standard/server.py:9
[S024]: embodied-first-exam/images/ambench/Dockerfile:42
[S025]: embodied-first-exam/embodied_first_exam/benchmarks/ambench/privileged/environment/rcb_ambench.py:628
[S026]: embodied-first-exam/images/autobio/Dockerfile:26
[S027]: embodied-first-exam/tasks/autobio/autobio-insert-centrifuge-5430-i00-privileged/environment/rcb_autobio.py:50
[S028]: embodied-first-exam/images/behavior/Dockerfile:10
[S029]: embodied-first-exam/embodied_first_exam/benchmarks/behavior-1k/rcb_behavior.py:1390
[S030]: embodied-first-exam/images/bigym2/Dockerfile:29
[S031]: embodied-first-exam/embodied_first_exam/benchmarks/bigym2/privileged/environment/rcb_bigym2.py:91
[S032]: embodied-first-exam/embodied_first_exam/benchmarks/bigym2/privileged/environment/rcb_bigym2.py:147
[S033]: embodied-first-exam/images/dexhand/Dockerfile:17
[S034]: embodied-first-exam/embodied_first_exam/benchmarks/dexhand/sim/server.py:69
[S035]: embodied-first-exam/embodied_first_exam/benchmarks/dexhand/privileged/tests/grade.py:118
[S036]: embodied-first-exam/images/dexjoco/Dockerfile:13
[S037]: embodied-first-exam/embodied_first_exam/benchmarks/dexjoco/privileged/environment/rcb_dexjoco.py:312
[S038]: embodied-first-exam/embodied_first_exam/benchmarks/dexjoco/privileged/tests/grade.py:137
[S039]: embodied-first-exam/embodied_first_exam/benchmarks/dextoolbench/privileged/environment/rcb_dtb.py:42
[S040]: embodied-first-exam/embodied_first_exam/benchmarks/dextoolbench/sim/server_mj.py:622
[S041]: embodied-first-exam/images/embodied-olympics-fun/Dockerfile:12
[S042]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-fun/rcb_rfo.py:125
[S043]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-fun/standard/server.py:167
[S044]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-match/standard-realtime/tests/grade.py:96
[S045]: embodied-first-exam/tasks/embodied-olympics-match/README.md:81
[S046]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-safety-exam/standard/server.py:282
[S047]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-safety-exam/standard/server.py:442
[S048]: embodied-first-exam/images/embodiedswe/Dockerfile:77
[S049]: embodied-first-exam/embodied_first_exam/benchmarks/embodiedswe/rcb_embodiedswe.py:902
[S050]: embodied-first-exam/images/humanoidbench/Dockerfile:50
[S051]: embodied-first-exam/embodied_first_exam/benchmarks/humanoidbench/privileged/tests/rcb_rewards.py
[S052]: embodied-first-exam/embodied_first_exam/benchmarks/humanoidbench/sim/server.py:203
[S053]: embodied-first-exam/images/ispatialgym/Dockerfile:43
[S054]: embodied-first-exam/embodied_first_exam/benchmarks/ispatialgym/sim/server.py:104
[S055]: embodied-first-exam/embodied_first_exam/benchmarks/ispatialgym/standard/tests/grade.py:20
[S056]: embodied-first-exam/images/kinder/Dockerfile:17
[S057]: embodied-first-exam/embodied_first_exam/benchmarks/kinder/privileged/environment/rcb_kinder.py:154
[S058]: embodied-first-exam/embodied_first_exam/benchmarks/kinder/sim/server.py:50
[S059]: embodied-first-exam/images/labutopia/Dockerfile:46
[S060]: embodied-first-exam/tasks/labutopia/labutopia-open-door-i00-privileged/environment/rcb_labutopia.py:55
[S061]: embodied-first-exam/tasks/labutopia/labutopia-open-door-i00-privileged/environment/rcb_labutopia.py:257
[S062]: embodied-first-exam/images/libero-max/Dockerfile:22
[S063]: embodied-first-exam/embodied_first_exam/benchmarks/libero-max/sim/server.py:90
[S064]: embodied-first-exam/embodied_first_exam/benchmarks/libero-max/sim/server.py:173
[S065]: embodied-first-exam/images/maniguard/Dockerfile:93
[S066]: embodied-first-exam/embodied_first_exam/benchmarks/maniguard/privileged/environment/rcb_maniguard.py:17
[S067]: embodied-first-exam/embodied_first_exam/benchmarks/maniguard/standard/tests/grade.py:21
[S068]: embodied-first-exam/images/metaworld/requirements.txt:1
[S069]: embodied-first-exam/embodied_first_exam/benchmarks/metaworldplus/privileged/environment/mw_tool.py:35
[S070]: embodied-first-exam/embodied_first_exam/benchmarks/metaworldplus/privileged/environment/mw_tool.py:348
[S071]: embodied-first-exam/images/molmospaces/Dockerfile:13
[S072]: embodied-first-exam/embodied_first_exam/benchmarks/molmospaces/privileged/environment/rcb_molmospaces.py:256
[S073]: embodied-first-exam/embodied_first_exam/benchmarks/molmospaces/standard/tests/grade.py:30
[S074]: embodied-first-exam/embodied_first_exam/benchmarks/mujoco-playground/privileged/environment/rcb_quadruped.py
[S075]: embodied-first-exam/embodied_first_exam/benchmarks/mujoco-playground/sim/server_mj.py:348
[S076]: embodied-first-exam/images/myosuite/Dockerfile:18
[S077]: embodied-first-exam/embodied_first_exam/benchmarks/myosuite/privileged/environment/rcb_myosuite.py:415
[S078]: embodied-first-exam/embodied_first_exam/benchmarks/myosuite/privileged/environment/rcb_myosuite.py:457
[S079]: embodied-first-exam/images/pandadyn/Dockerfile
[S080]: embodied-first-exam/embodied_first_exam/benchmarks/pandadyn/privileged/environment/rcb_pandadyn.py:189
[S081]: embodied-first-exam/embodied_first_exam/benchmarks/pandadyn/sim/server.py:83
[S082]: embodied-first-exam/embodied_first_exam/benchmarks/roboarc/rcb_topogym.py:3488
[S083]: embodied-first-exam/embodied_first_exam/benchmarks/roboarc/rcb_topogym.py:3897
[S084]: embodied-first-exam/embodied_first_exam/benchmarks/roboarc/standard/grade.py:44
[S085]: embodied-first-exam/embodied_first_exam/benchmarks/roboarc/ikea/privileged/environment/rcb_ikea.py:422
[S086]: embodied-first-exam/images/robocasa/Dockerfile:17
[S087]: embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:382
[S088]: embodied-first-exam/images/robocasa-gr1/Dockerfile:20
[S089]: embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:281
[S090]: embodied-first-exam/tasks/robocasa-gr1/robocasa-gr1-bottle-to-cabinet-close-i00-standard/environment/sim/Dockerfile:5
[S091]: embodied-first-exam/images/robocasa365/Dockerfile:19
[S092]: embodied-first-exam/embodied_first_exam/benchmarks/robocasa365/privileged/environment/casa_tool.py:391
[S093]: embodied-first-exam/images/robodojo/Dockerfile:32
[S094]: embodied-first-exam/embodied_first_exam/benchmarks/robodojo/privileged/environment/rcb_robodojo.py:466
[S095]: embodied-first-exam/embodied_first_exam/benchmarks/robodojo/sim/server.py:242
[S096]: embodied-first-exam/embodied_first_exam/benchmarks/roboengineer/standard/tests/grade.py:66
[S097]: embodied-first-exam/embodied_first_exam/benchmarks/roboengineer/standard/tests/grade.py:125
[S098]: embodied-first-exam/tasks/roboengineer/README.md:109
[S099]: embodied-first-exam/images/robolab/Dockerfile:31
[S100]: embodied-first-exam/embodied_first_exam/benchmarks/robolab/rcb_robolab.py:949
[S101]: embodied-first-exam/embodied_first_exam/benchmarks/robolab/sim/server.py:211
[S102]: embodied-first-exam/images/robopaint/Dockerfile:55
[S103]: embodied-first-exam/embodied_first_exam/benchmarks/robopaint/rcb_brush_score.py:308
[S104]: embodied-first-exam/embodied_first_exam/benchmarks/robopaint/rcb_brush_strict.py:30
[S105]: embodied-first-exam/embodied_first_exam/benchmarks/robopaint/standard/grade.py:1
[S106]: embodied-first-exam/.gitmodules:1
[S107]: embodied-first-exam/embodied_first_exam/benchmarks/robotwin-2/sim/server.py:27
[S108]: embodied-first-exam/embodied_first_exam/benchmarks/robotwin-2/sim/server.py:106
[S109]: embodied-first-exam/tasks/robotwin-2/README.md:87
[S110]: embodied-first-exam/images/robowits/Dockerfile:19
[S111]: embodied-first-exam/embodied_first_exam/benchmarks/robowits/privileged/tests/rcb_robowits.py:96
[S112]: embodied-first-exam/embodied_first_exam/benchmarks/robowits/sim/server.py:312
[S113]: embodied-first-exam/images/vlabench/Dockerfile:21
[S114]: embodied-first-exam/embodied_first_exam/benchmarks/vlabench/privileged/environment/vlb_tool.py:198
[S115]: embodied-first-exam/embodied_first_exam/benchmarks/vlabench/privileged/environment/vlb_tool.py:297
[S116]: embodied-first-exam/images/yamlab/Dockerfile:43
[S117]: embodied-first-exam/embodied_first_exam/benchmarks/yamlab/privileged/environment/rcb_yamlab.py:569
[S118]: embodied-first-exam/tasks/abc-sim/README.md
[S119]: embodied-first-exam/tasks/abc-sim
[S120]: embodied-first-exam/tasks/ambench/README.md
[S121]: embodied-first-exam/tasks/ambench
[S122]: embodied-first-exam/tasks/autobio/README.md
[S123]: embodied-first-exam/tasks/autobio
[S124]: embodied-first-exam/tasks/behavior-1k/README.md
[S125]: embodied-first-exam/tasks/behavior-1k
[S126]: embodied-first-exam/tasks/bigym2/README.md
[S127]: embodied-first-exam/tasks/bigym2
[S128]: embodied-first-exam/tasks/dexhand/README.md
[S129]: embodied-first-exam/tasks/dexhand
[S130]: embodied-first-exam/tasks/dexjoco/README.md
[S131]: embodied-first-exam/tasks/dexjoco
[S132]: embodied-first-exam/tasks/dextoolbench/README.md
[S133]: embodied-first-exam/tasks/dextoolbench
[S134]: embodied-first-exam/tasks/embodied-olympics-fun/README.md
[S135]: embodied-first-exam/tasks/embodied-olympics-fun
[S136]: embodied-first-exam/tasks/embodied-olympics-match/README.md
[S137]: embodied-first-exam/tasks/embodied-olympics-match
[S138]: embodied-first-exam/tasks/embodied-safety-exam/README.md
[S139]: embodied-first-exam/tasks/embodied-safety-exam
[S140]: embodied-first-exam/tasks/embodiedswe/README.md
[S141]: embodied-first-exam/tasks/embodiedswe
[S142]: embodied-first-exam/tasks/humanoidbench/README.md
[S143]: embodied-first-exam/tasks/humanoidbench
[S144]: embodied-first-exam/tasks/ispatialgym/README.md
[S145]: embodied-first-exam/tasks/ispatialgym
[S146]: embodied-first-exam/tasks/kinder/README.md
[S147]: embodied-first-exam/tasks/kinder
[S148]: embodied-first-exam/tasks/labutopia/README.md
[S149]: embodied-first-exam/tasks/labutopia
[S150]: embodied-first-exam/tasks/libero-max/README.md
[S151]: embodied-first-exam/tasks/libero-max
[S152]: embodied-first-exam/tasks/maniguard/README.md
[S153]: embodied-first-exam/tasks/maniguard
[S154]: embodied-first-exam/tasks/metaworldplus/README.md
[S155]: embodied-first-exam/tasks/metaworldplus
[S156]: embodied-first-exam/tasks/molmospaces/README.md
[S157]: embodied-first-exam/tasks/molmospaces
[S158]: embodied-first-exam/tasks/mujoco-playground/README.md
[S159]: embodied-first-exam/tasks/mujoco-playground
[S160]: embodied-first-exam/tasks/myosuite/README.md
[S161]: embodied-first-exam/tasks/myosuite
[S162]: embodied-first-exam/tasks/pandadyn/README.md
[S163]: embodied-first-exam/tasks/pandadyn
[S164]: embodied-first-exam/tasks/roboarc/README.md
[S165]: embodied-first-exam/tasks/roboarc
[S166]: embodied-first-exam/tasks/robocasa/README.md
[S167]: embodied-first-exam/tasks/robocasa
[S168]: embodied-first-exam/tasks/robocasa-gr1/README.md
[S169]: embodied-first-exam/tasks/robocasa-gr1
[S170]: embodied-first-exam/tasks/robocasa365/README.md
[S171]: embodied-first-exam/tasks/robocasa365
[S172]: embodied-first-exam/tasks/robodojo/README.md
[S173]: embodied-first-exam/tasks/robodojo
[S174]: embodied-first-exam/tasks/roboengineer/README.md
[S175]: embodied-first-exam/tasks/roboengineer
[S176]: embodied-first-exam/tasks/robolab/README.md
[S177]: embodied-first-exam/tasks/robolab
[S178]: embodied-first-exam/tasks/robopaint/README.md
[S179]: embodied-first-exam/tasks/robopaint
[S180]: embodied-first-exam/tasks/robotwin-2/README.md
[S181]: embodied-first-exam/tasks/robotwin-2
[S182]: embodied-first-exam/tasks/robowits/README.md
[S183]: embodied-first-exam/tasks/robowits
[S184]: embodied-first-exam/tasks/vlabench/README.md
[S185]: embodied-first-exam/tasks/vlabench
[S186]: embodied-first-exam/tasks/yamlab/README.md
[S187]: embodied-first-exam/tasks/yamlab
[S188]: embodied-first-exam/docs/protocol/README.md:119
[S189]: embodied-first-exam/tasks/robodojo/README.md:110
[S190]: embodied-first-exam/tasks/ambench/README.md:176
[S191]: embodied-first-exam/docs/protocol/README.md:47
[S192]: embodied-first-exam/docs/protocol/running.md:27
[S193]: embodied-first-exam/docs/protocol/README.md:261
[S194]: embodied-first-exam/docs/protocol/running.md:8
[S195]: IsaacLab-Arena/isaaclab_arena_environments/robolab/tasks
[S196]: IsaacLab-Arena/isaaclab_arena_environments/robolab/task_catalog.md
[S197]: vla-evaluation-harness/src/vla_eval/benchmarks/base.py:1
[S198]: vla-evaluation-harness/src/vla_eval/model_servers/predict.py:13
[S199]: embodied-first-exam/tasks/embodiedswe/README.md:1
[S200]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:48
[S201]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:225
[S202]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:270
[S203]: embodied-first-exam/tasks/libero-max/README.md:1
[S204]: vla-evaluation-harness/src/vla_eval/benchmarks/libero_pro/benchmark.py:40
[S205]: vla-evaluation-harness/src/vla_eval/benchmarks/libero_plus/benchmark.py:41
[S206]: vla-evaluation-harness/src/vla_eval/benchmarks/libero_plus/benchmark.py:94
[S207]: vla-evaluation-harness/src/vla_eval/benchmarks/libero_mem/benchmark.py:14
[S208]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:40
[S209]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:72
[S210]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:211
[S211]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:234
[S212]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:61
[S213]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:118
[S214]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:196
[S215]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa365/benchmark.py:214
[S216]: vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:238
[S217]: vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:368
[S218]: vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:479
[S219]: vla-evaluation-harness/src/vla_eval/benchmarks/robotwin/benchmark.py:513
[S220]: embodied-first-exam/third_party/RoboTwin/envs/_base_task.py:1603
[S221]: embodied-first-exam/third_party/RoboTwin/scripts/eval_policy_multitask.py:1056
[S222]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:59
[S223]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:188
[S224]: vla-evaluation-harness/docker/Dockerfile.behavior1k:11
[S225]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:240
[S226]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:257
[S227]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:330
[S228]: embodied-first-exam/embodied_first_exam/benchmarks/behavior-1k/rcb_behavior.py:1414
[S229]: vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:142
[S230]: vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:165
[S231]: vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:213
[S232]: vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:296
[S233]: vla-evaluation-harness/src/vla_eval/benchmarks/molmospaces/benchmark.py:354
[S234]: embodied-first-exam/tasks/molmospaces/README.md:72
[S235]: vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:82
[S236]: vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:386
[S237]: vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:441
[S238]: vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:483
[S239]: vla-evaluation-harness/src/vla_eval/benchmarks/robodojo/benchmark.py:553
[S240]: vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:54
[S241]: vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:102
[S242]: vla-evaluation-harness/src/vla_eval/benchmarks/vlabench/benchmark.py:135
[S243]: vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:48
[S244]: vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:118
[S245]: vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:142
[S246]: vla-evaluation-harness/src/vla_eval/benchmarks/maniskill2/benchmark.py:183
[S247]: vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:48
[S248]: vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:145
[S249]: vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:202
[S250]: vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:332
[S251]: vla-evaluation-harness/src/vla_eval/benchmarks/simpler/benchmark.py:384
[S252]: vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:160
[S253]: vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:227
[S254]: vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:458
[S255]: vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:509
[S256]: vla-evaluation-harness/src/vla_eval/benchmarks/calvin/benchmark.py:622
[S257]: IsaacLab-Arena/isaaclab_arena_environments/robolab/tasks/banana_in_bowl.yaml:6
[S258]: IsaacLab-Arena/isaaclab_arena_openpi/policy/droid_adapter.py:17
[S259]: IsaacLab-Arena/isaaclab_arena/environments/isaaclab_arena_manager_based_env_cfg.py:185
[S260]: IsaacLab-Arena/isaaclab_arena/metrics/success_rate.py:24
[S261]: vla-evaluation-harness/src/vla_eval/benchmarks
[S262]: embodied-first-exam/embodied_first_exam/benchmarks
[S263]: embodied-first-exam/images
[S264]: IsaacLab-Arena/isaaclab_arena_environments
[S265]: IsaacLab-Arena/README.md:254
[S266]: vla-evaluation-harness/src/vla_eval/benchmarks/mikasa/benchmark.py:73
[S267]: vla-evaluation-harness/src/vla_eval/benchmarks/robomme/benchmark.py:161
[S268]: vla-evaluation-harness/src/vla_eval/benchmarks/robocerebra/benchmark.py:35
[S269]: vla-evaluation-harness/src/vla_eval/benchmarks/duobench/benchmark.py:90
[S270]: vla-evaluation-harness/src/vla_eval/benchmarks/kinetix/benchmark.py:73
[S271]: vla-evaluation-harness/src/vla_eval/benchmarks/ocbench/benchmark.py:41
[S272]: vla-evaluation-harness/src/vla_eval/protocol/messages.py:15
[S273]: vla-evaluation-harness/src/vla_eval/connection.py
[S274]: vla-evaluation-harness/src/vla_eval/runners/sync_runner.py:25
[S275]: vla-evaluation-harness/src/vla_eval/runners/live_runner.py:41
[S276]: vla-evaluation-harness/src/vla_eval/model_servers/engine.py
[S277]: vla-evaluation-harness/src/vla_eval/runners/vector_runner.py
[S278]: vla-evaluation-harness/src/vla_eval/benchmarks/base.py:74
[S279]: vla-evaluation-harness/src/vla_eval/recording.py:53
[S280]: vla-evaluation-harness/src/vla_eval/recording.py:533
[S281]: vla-evaluation-harness/src/vla_eval/orchestrator.py:429
[S282]: vla-evaluation-harness/src/vla_eval/results/collector.py:63
[S283]: IsaacLab-Arena/isaaclab_arena/evaluation/policy_runner.py:66
[S284]: IsaacLab-Arena/isaaclab_arena/evaluation/policy_runner.py:197
[S285]: IsaacLab-Arena/isaaclab_arena/policy/remote_policy_base.py:64
[S286]: IsaacLab-Arena/isaaclab_arena/policy/remote_policy_base.py:157
[S287]: IsaacLab-Arena/isaaclab_arena/policy/action_scheduling/synced_batch_action_scheduler.py:16
[S288]: IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:40
[S289]: IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:100
[S290]: IsaacLab-Arena/isaaclab_arena_vlm_agent/action_adapter.py
[S291]: IsaacLab-Arena/osmo/workflows/arena_experiment_workflow.py:51
[S292]: OSMO/src/utils/job/workflow.py:52
[S293]: IsaacLab-Arena/osmo/scripts/build_experiment_output.py:142
[S294]: IsaacLab-Arena/isaaclab_arena_openpi/policy/droid_adapter.py:30
[S295]: embodied-first-exam/docs/protocol/README.md:84
[S296]: IsaacLab-Arena/isaaclab_arena_vlm_agent/vlm_agent_policy.py:118
[S297]: vla-evaluation-harness/src/vla_eval/benchmarks/libero_mem/benchmark.py:33
[S298]: embodied-first-exam/tasks/ispatialgym/README.md:88
[S299]: vla-evaluation-harness/src/vla_eval/benchmarks/robomme/benchmark.py:244
[S300]: orbit/packages/orbit/src/contracts/bench.ts:219
[S301]: orbit/packages/orbit/src/contracts/bench.ts:333
[S302]: orbit/packages/orbit/src/contracts/bench.ts:370
[S303]: orbit/packages/orbit/src/contracts/trajectory.ts:28
[S304]: embodied-first-exam/docs/protocol/README.md:295
[S305]: embodied-first-exam/embodied_first_exam/benchmarks/embodiedswe/esw_proxy.py
[S306]: embodied-first-exam/tasks/embodied-olympics-match/README.md:83
[S307]: orbit/docs/design.md:459
[S308]: orbit/docs/design.md:499
[S309]: orbit/docs/design.md:537
[S310]: embodied-first-exam/docs/protocol/README.md:124
[S311]: vla-evaluation-harness/src/vla_eval/benchmarks/robocasa/benchmark.py:249
[S312]: embodied-first-exam/embodied_first_exam/benchmarks/robocasa/privileged/environment/casa_tool.py:397
[S313]: orbit/packages/orbit/src/contracts/bench.ts:365
[S314]: vla-evaluation-harness/src/vla_eval/results/collector.py:85
[S315]: vla-evaluation-harness/src/vla_eval/benchmarks/behavior1k/benchmark.py:362
[S316]: embodied-first-exam/images/metaworld/requirements.txt
[S317]: embodied-first-exam/third_party/RoboTwin/envs
[S318]: embodied-first-exam/docs/protocol/README.md:330
[S319]: orbit/docs/design.md:979
[S320]: orbit/packages/orbit/src/contracts/bench.ts:157
[S321]: orbit/examples/bench-adapters/vla-eval/adapter.py:76
[S322]: orbit/examples/bench-adapters/vla-eval/adapter.py:200
[S323]: orbit/examples/bench-manifests/vla-eval-libero/orbit-bench.yaml:1
[S324]: orbit/examples/bench-adapters/vla-eval/check.py:9
[S325]: orbit/examples/bench-adapters/vla-eval/adapter.py:231
[S326]: orbit/examples/bench-adapters/vla-eval/adapter.py:270
[S327]: orbit/docs/catalog.md
[S328]: orbit/docs/research/embodied-bench
[S329]: IsaacLab-Arena/osmo/workflows/arena_experiment_workflow.py:70
[S330]: embodied-first-exam/images/bigym2/Dockerfile
[S331]: embodied-first-exam/tasks/roboarc/README.md:70
[S332]: embodied-first-exam/third_party/RoboTwin/envs/_base_task.py:1611
[S333]: vla-evaluation-harness/src/vla_eval/benchmarks/libero/benchmark.py:297
[S334]: embodied-first-exam/embodied_first_exam/benchmarks/embodied-olympics-match/standard-realtime/tests/grade.py:111
[S335]: embodied-first-exam/images/abc-sim/tools/rcb_abc.py
