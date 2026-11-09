# 原生具身评测兼容矩阵

范围是 Orbit 的 C6 原生 benchmark 与独立 Policy。表中「实测」表示该权重与 recipe 已运行真实抽样 episode，并完成独立验证。任务数表示已登记的目录大小。破折号表示该套件与模型的组合暂无真实模型抽样记录。新增组合使用同一套接入模板记录。[接入模板](embodied-onboarding.md)

| 环境与套件 | 任务数 | Benchmark 登记 | π₀.₅ | GR00T N1.7 | GR00T N1.5 | OpenVLA-OFT | SmolVLA | MolmoAct2 | X-VLA | Diffusion Policy |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LIBERO Spatial `libero_spatial` | 10 | `libero-native` / `libero-oft-native` / `libero-smolvla-native` | 实测 | 实测 `groot-n17-libero` | — | 实测 `openvla-oft-libero-spatial`、`openvla-oft-libero-combined-spatial` | 实测 `smolvla-libero` | — | — | — |
| LIBERO Object `libero_object` | 10 | `libero-object-native` / `libero-oft-object-native` | 实测 | 实测 `groot-n17-libero-object` | — | 实测 `openvla-oft-libero-combined-object` | — | — | — | — |
| LIBERO Goal `libero_goal` | 10 | `libero-goal-native` / `libero-oft-goal-native` / `libero-goal-molmoact2-native` | 实测 | 实测 `groot-n17-libero-goal` | — | 实测 `openvla-oft-libero-combined-goal` | — | 实测 `molmoact2-libero` | — | — |
| LIBERO Long `libero_10` | 10 | `libero-long-native` / `libero-oft-long-native` | 实测 | 实测 `groot-n17-libero-long` | — | 实测 `openvla-oft-libero-combined-long` | — | — | — | — |
| LIBERO-90 `libero_90` | 90 | `libero-90-native` / `libero-oft-90-native` | — | — | — | 实测 `openvla-oft-rlinf-libero-90` | — | — | — | — |
| SimplerEnv WidowX（GR00T recipe） | 7 | `simpler-widowx-native` | — | 实测 `groot-n17-widowx` | — | — | — | — | — | — |
| SimplerEnv Google Robot（GR00T recipe） | 6 | `simpler-google-native` | — | 实测 `groot-n17-google` | — | — | — | — | — | — |
| SimplerEnv Google Robot Prepackaged | 21 | `simpler-google-prepackaged-native` | — | — | — | — | — | — | — | — |
| SimplerEnv WidowX Prepackaged | 7 | `simpler-widowx-prepackaged-native` | — | — | — | — | — | — | — | — |
| SimplerEnv Google Robot Visual Matching | 11 | `simpler-google-visual-matching-native` | — | — | — | — | — | — | — | — |
| SimplerEnv Google Robot Variant Aggregation | 11 | `simpler-google-variant-aggregation-native` | — | — | — | — | — | — | — | — |
| SimplerEnv WidowX Visual Matching | 4 | `simpler-widowx-visual-matching-native` | — | — | — | — | — | — | — | — |
| SimplerEnv 策略终止协议 | 三套固定网格共用原目录 | `simpler-<profile>-stop-native` | — | — | — | — | — | — | — | — |
| 原版 RoboCasa v0.2 Atomic | 24，每任务 50 个种子 | `robocasa-v02-atomic-native` | — | — | — | — | — | — | — | — |
| RoboCasa365 Atomic-Seen | 18 | `robocasa365-atomic-seen-native` / `robocasa365-atomic-seen-gr00t-native` / `robocasa365-atomic-seen-diffusion-policy-native` | 实测 `pi05-robocasa365-shared` | — | 实测 `groot-n15-robocasa365-shared` | — | — | — | — | 实测 `diffusion-policy-robocasa365-shared` |
| RoboCasa365 Composite-Seen | 16 | `robocasa365-composite-seen-native` / `robocasa365-composite-seen-gr00t-native` | — | — | 实测（`target50` 抽样） | — | — | — | — | — |
| RoboCasa365 Composite-Unseen | 16 | `robocasa365-composite-unseen-native` / `robocasa365-composite-unseen-gr00t-native` | — | — | 实测（`target50` 抽样） | — | — | — | — | — |
| RoboCasa365 固定版本全目录 | 317 | `robocasa365-all-tasks-native` / `robocasa365-all-tasks-gr00t-native` | — | — | — | — | — | — | — | — |
| RoboCasa365 Lifelong | 125 | 四个阶段及三个累计套件，[登记说明](../../examples/bench-adapters/embodied/ROBOCASA365.md) | — | — | — | — | — | — | — | — |
| RoboTwin 2.0 Clean（单任务验收） | 1 | `robotwin-demo-clean-native` | 实测 `pi05-robotwin-adjust-bottle-shared` | — | — | — | — | — | — | — |
| RoboTwin 2.0 Clean | 50 | `robotwin-demo-clean-full-native` | — | — | — | — | — | — | — | — |
| RoboTwin 2.0 Randomized | 50 | `robotwin-demo-randomized-full-native` | — | — | — | — | — | — | — | — |
| ManiSkill3 Plate-25（RLinf） | 1 | `maniskill3-plate25-native` | — | — | — | 实测 `openvla-oft-rlinf-maniskill3` | — | — | — | — |
| ManiSkill3 原生桌面套件 | 20，含两个待资产验证的任务 | `maniskill3-tabletop-<profile>-native` | — | — | — | — | — | — | — | — |
| Meta-World MT50（RLinf） | 50 | `metaworld-mt50-native` | 实测 `pi05-rlinf-metaworld` | — | — | — | — | — | — | — |
| RoboTwin 2.0 Clean（末端位姿） | 50 | `robotwin-demo-clean-cartesian-native` | — | — | — | — | — | — | 实测 `xvla-robotwin2` | — |
| RoboTwin 2.0 Randomized（末端位姿） | 50 | `robotwin-demo-randomized-cartesian-native` | — | — | — | — | — | — | 实测 `xvla-robotwin2` | — |
| CALVIN ABC→D | 1（1,000 条序列） | `calvin-abc-d-native` | 实测 `pi05-rlinf-calvin-abc-d` | — | — | — | — | — | — | — |

π₀.₅ 的四个已实测 LIBERO 套件共用官方 `pi05_libero` 权重，Policy 登记为 `pi05-libero`，共享 GPU 配置登记为 `pi05-libero-shared`。RoboCasa365 使用自己的公开 π₀.₅ 权重。GR00T 的 LIBERO 权重按 suite 子目录选择，WidowX 用 Bridge，Google Robot 用 Fractal，三条路径共用固定 backbone 缓存。OFT 的 Spatial 专用权重和四套件联合权重分别有实测记录。联合权重按 suite 选择 `<suite>_no_noops`，Long 对应 `libero_10_no_noops`。[LIBERO 套件选择](libero-suites.md) · [RoboCasa365 配置](../../examples/bench-adapters/embodied/ROBOCASA365.md) · [GR00T 配置](../../examples/bench-adapters/embodied/GR00T.md) · [OFT 模型配置](../../examples/bench-adapters/embodied/profiles/openvla-model.json)

## 评测条件

LIBERO 提供 OpenPI 和 OFT 两类原生登记。已验收的 π₀.₅ 和 GR00T 组合用 OpenPI recipe，OFT 组合用 OFT recipe。两条 recipe 共用 OpenPI 固定版本的 LIBERO 仿真与初态文件。配对比较按冻结的样本和评测条件核对，包含 recipe、镜像、渲染和实际预算。[评测条件](../../packages/orbit/src/bench/summary.ts)

| Recipe | 样本与控制 | 渲染配置 |
| --- | --- | --- |
| LIBERO OpenPI | 环境 seed 7，10 步 settle，每 5 步重规划 | 默认 CPU OSMesa，共享 GPU 时用 EGL |
| LIBERO OFT | 环境 seed 0，10 步 settle，每 8 步重规划 | 默认 CPU OSMesa，共享 GPU 时用 EGL |
| WidowX（GR00T recipe） | 生成场景 seed，5 Hz，每 4 步重规划，horizon 300 | Vulkan，可显式共享主角色 GPU |
| Google Robot（GR00T recipe） | 生成场景 seed，3 Hz，每步重规划，horizon 300，原生 sticky gripper | Vulkan，可显式共享主角色 GPU |
| SimplerEnv Prepackaged | 固定上游 fork 的原生任务和 seed。Google Robot 3 Hz。WidowX 按任务使用 3 或 5 Hz | Vulkan |
| SimplerEnv 固定场景网格 | 按场景索引展开上游脚本的初态网格、场景变体和 horizon | Vulkan，使用原生脚本指定的着色器 |
| RoboCasa365 OpenPI | RoboCasa 1.0.0，`pretrain` 或 `target` 场景的独立种子，20 Hz，每 5 步重规划，原生成功时停止 | EGL，可显式共享主角色 GPU |
| RoboCasa365 GR00T N1.5 | RoboCasa 1.0.1，`pretrain` 或 `target` 场景的独立种子，20 Hz，每 16 步重规划，按动作段末尾的成功信号计分 | EGL，可显式共享主角色 GPU |
| RoboCasa365 Diffusion Policy | RoboCasa 1.0.0，两帧观测，20 Hz，每 8 步重规划，按全程原生稀疏奖励计分 | EGL，可显式共享主角色 GPU |
| RoboTwin 2.0 Clean / Randomized | Aloha-AgileX，按上游候选流筛选专家通过种子，按任务使用原生控制上限 | SAPIEN Vulkan 光追，Randomized 使用上游评测贴图 |
| RoboTwin 2.0 Clean 末端位姿 | Aloha-AgileX 双臂末端控制，最多 10 个 30 步动作块，并遵守原生任务上限 | SAPIEN Vulkan 光追 |
| ManiSkill3 Plate-25 | WidowX，640×480 前相机，7 维目标增量，每 8 步重规划，最多 80 步 | SAPIEN Vulkan 与 GPU PhysX |
| Meta-World MT50 | Sawyer，480×480 相机和 4 维末端状态，15 步 settle，每 5 步重规划，最多 160 步 | MuJoCo EGL |
| CALVIN ABC→D | 场景 D 五指令序列，每条指令最多 480 步，在指令完成时立即重规划 | PyBullet EGL |

LIBERO 的 horizon 按 Spatial、Object、Goal、Long、LIBERO-90 分别为 220、280、300、520、400。各套件的渲染配置以作业快照为准。[LIBERO 套件条件](libero-suites.md) · [WidowX recipe](../../examples/bench-adapters/embodied/profiles/groot-widowx.json) · [Google Robot recipe](../../examples/bench-adapters/embodied/profiles/groot-google.json)

SimplerEnv 的 Google Robot Visual Matching、Variant Aggregation 和 WidowX Visual Matching 分别有 1,164、1,992 和 96 个固定初态。不同登记可能复用相同任务 ID。RT 降噪异常的机器可使用独立的 `-no-rt-denoiser-native` 登记。[SimplerEnv 配置与采样](../../examples/bench-adapters/embodied/SIMPLER.md)

RoboCasa365 的 `target50` 登记汇总三个任务组。场景划分独立于任务组，`target` 场景登记带 `-target-native` 后缀。[RoboCasa365 配置](../../examples/bench-adapters/embodied/ROBOCASA365.md)

VLABench 的五条固定轨道共 2,460 个场景，开放跨任务轨道按 96 个原生任务 ID 及用户选择的种子运行。OpenWAM 的公开 VLABench 权重通过独立 Policy 登记。LIBERO-Plus 的 Spatial、Object、Goal、Long 分别有 2,402、2,518、2,591、2,519 个扰动变体，每个变体采用一个原生初始状态，兼容相应套件的 OpenVLA-OFT recipe。[VLABench 与 OpenWAM](../../examples/bench-adapters/embodied/VLABENCH.md) · [LIBERO-Plus](../../examples/bench-adapters/embodied/LIBERO-PLUS.md)

## 验证依据

| 范围 | 已记录的验证 |
| --- | --- |
| LIBERO Spatial | 10 个任务通过原生 reset、相机和控制步检查。π₀.₅、GR00T、OFT 均有真实抽样及独立验证。[原生目录验收](../tasks/20261109-embodied-benchmark-coverage.md) · [早期 π₀.₅](../tasks/20261105-embodied-eval.md) · [GR00T 批次](../tasks/20261106-embodied-batches.md) · [OFT 联合](../tasks/20261107-libero-suites.md) |
| LIBERO Object、Goal、Long | 30 个任务通过原生 reset 和控制步检查。9 个新增模型与套件组合分别通过两个冻结 episode 的真实接入检查。[LIBERO 扩展验收](../tasks/20261107-libero-suites.md) |
| LIBERO-90 | 90 个任务通过原生 reset、settle、相机和控制步检查。RLinf OpenVLA-OFT 在两个冻结任务上通过共享批次、独立 CPU 验证和重评。[目录验收](../tasks/20261108-libero-90.md) · [模型验收](../tasks/20261108-libero-90-rlinf.md) |
| SimplerEnv WidowX | 7 个任务通过原生初始化、渲染和控制步检查，Bridge 通过真实抽样与固定批次检查。[原生覆盖](../tasks/20261106-embodied-endpoints.md) · [Bridge 批次](../tasks/20261106-embodied-batches.md) |
| SimplerEnv Google Robot | 6 个任务通过原生初始化和控制步检查，原生固定动作对照通过，Fractal 通过有界真实抽样、CPU 验证与重评。[Google Robot 验收](../tasks/20261107-groot-google.md) |
| SimplerEnv 完整目录与固定网格 | 141 个任务与场景设置完成原生 reset、渲染和控制步。默认 OptiX 可在此机器返回空白原始帧，关闭降噪的独立配置通过 RT 复核。[SimplerEnv 验收](../tasks/20261108-simplerenv-task-sets.md) |
| SimplerEnv 策略终止协议 | 三套网格通过脚本策略的原生停止和 CPU 证据检查。Google 两套用关闭 OptiX 降噪的配置。[协议验收](../tasks/20261109-embodied-benchmark-coverage.md) |
| RoboCasa365 Atomic-Seen | 18 个任务通过原生初始化、渲染和控制步检查。两个任务的原生状态和控制向量一致，独立渲染最大差 1 个灰阶值。官方 π₀.₅ 通过两个冻结样本的共享 GPU 批次、CPU 验证和选定样本重评。[RoboCasa365 验收](../tasks/20261107-robocasa365.md) |
| RoboCasa365 Atomic-Seen，GR00T N1.5 | 1.0.1 的 18 个任务 ID 和 horizon 已核对，两个任务与官方多步 wrapper 的状态、控制和计分一致。官方 N1.5 通过两样本真实批次、CPU 验证和选定样本重评。[N1.5 验收](../tasks/20261107-robocasa365-gr00t-n15.md) |
| RoboCasa365 Atomic-Seen，Diffusion Policy | 两个冻结样本在共享 GPU 批次中分别覆盖步数上限和成功后停止，通过独立 CPU 验证和选定样本重评。[Diffusion Policy 验收](../tasks/20261109-robocasa365-diffusion-policy.md) |
| RoboCasa365 榜单目录 | 50 个任务在两个运行时和两种场景划分下共通过 200 个原生 EGL 重置、渲染与控制检查。两个 Composite 组分别选了一个任务，在四种配置下与原生环境直接对照。[RoboCasa365 扩展验收](../tasks/20261108-robocasa365-task-sets.md) |
| RoboCasa365 全目录和 Lifelong | 固定 1.0.1 的 317 个任务在 pretrain 场景中通过原生检查。Lifelong 的阶段和累计任务数已通过 CLI 核对。[全目录验收](../tasks/20261109-embodied-benchmark-coverage.md) |
| 参考对照 | π₀.₅ Spatial 的确定性处理、固定动作和共享编译模型控制通过，独立 GPU 进程逐位比较失败。GR00T 的 Spatial 与 WidowX 做过抽样参考边界检查。OFT 做过确定性 I/O helper 对照。[π₀.₅ 对照](../tasks/20261105-embodied-eval.md) · [GR00T 与 OFT 对照](../tasks/20261106-embodied-endpoints.md) |
| RoboTwin 2.0 Clean | `adjust_bottle` 的两个专家通过场景完成原生重置与固定动作对照。社区 π₀.₅ 通过两样本固定批次、独立 CPU 验证、选定样本重评和汇总核对。[接入配置](../../examples/bench-adapters/embodied/ROBOTWIN.md) · [验收记录](../tasks/20261107-robotwin.md) |
| RoboTwin 2.0 两套完整目录 | Clean 和 Randomized 各 50 个任务完成原生控制、三相机观测和判定检查。专家种子计划在两个模式下均有实测，逐任务验收范围见任务记录。[RoboTwin 套件验收](../tasks/20261108-robotwin-suites.md) |
| SmolVLA × LIBERO Spatial | 同一原生任务的两个冻结初态通过共享批次、独立 CPU 验证和选定样本重评。[接入验收](../tasks/20261108-embodied-native-expansion.md) |
| MolmoAct2 × LIBERO Goal | 同一原生任务的两个冻结初态通过共享批次、独立 CPU 验证和选定样本重评。[接入验收](../tasks/20261108-embodied-native-expansion.md) |
| ManiSkill3 Plate-25 | 原生场景通过断网 GPU 重置、渲染及控制检查。RLinf OFT 的两个冻结初态通过共享批次、独立 CPU 验证及重评。[接入验收](../tasks/20261108-embodied-native-expansion.md) |
| ManiSkill3 桌面套件 | 18 个任务通过原生重置、相机和控制步检查。PickCube 的脚本策略完成完整步数并通过 CPU 验证。另有两个任务等待上游资产。[桌面任务验收](../tasks/20261109-embodied-benchmark-coverage.md) |
| Meta-World MT50 | 50 个任务通过原生重置、渲染及控制步检查。RLinf π₀.₅ 在两个冻结任务上通过真实批次、独立 CPU 验证及重评。[接入验收](../tasks/20261108-embodied-native-expansion.md) |
| X-VLA × RoboTwin 2.0 Clean | 两个专家通过场景完成真实批次、独立 CPU 验证和重评。[接入验收](../tasks/20261108-embodied-calvin-xvla.md) |
| X-VLA × RoboTwin 2.0 Randomized | 两个专家通过任务完成真实批次、独立 CPU 验证和重评。[协议验收](../tasks/20261109-embodied-benchmark-coverage.md) |
| CALVIN ABC→D | 冻结目录包含 1,000 条原生指令序列。两个样本通过真实 π₀.₅ 批次、逐段计分、独立 CPU 验证和重评。[接入验收](../tasks/20261108-embodied-calvin-xvla.md) |
| 完整套件统计等价 | `not_run`。现有记录覆盖原生任务目录检查、真实抽样和指定条件下的参考对照。 |
