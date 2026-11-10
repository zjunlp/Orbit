# 原生具身 benchmark 覆盖与模型实测

[具身评测快速开始](embodied-quickstart.md) · [配置指南索引](../../examples/bench-adapters/embodied/README.md) · [接入与验收模板](embodied-onboarding.md)

## Benchmark 接入范围

上游范围按 Orbit 所选的固定版本与协议统计。任务、初态、扰动变体、指令序列分别计数。
多个登记可能复用任务，同一任务在不同观测或控制协议下也可能有多个登记。
原生检查一列记录实际跑过的目录、重置、观测、控制或证据检查。

| Benchmark | 上游范围与计数单位 | Orbit 接入 | 原生检查与已知缺口 |
| --- | --- | --- | --- |
| [LIBERO](libero-suites.md) | 5 个套件，130 个任务 | 5 个套件全部接入，包含 LIBERO-90 | 130 个任务做过 reset 和控制步检查。[Spatial](../tasks/20261109-embodied-benchmark-coverage.md) · [Object、Goal、Long](../tasks/20261107-libero-suites.md) · [LIBERO-90](../tasks/20261108-libero-90.md) |
| [LIBERO-Plus](../../examples/bench-adapters/embodied/LIBERO-PLUS.md) | 4 个套件，10,030 个扰动变体 | 全部变体，每变体 1 个原生初态 | 核对全部初态文件解析，原生 GPU 检查覆盖每套 7 个扰动类别，共 28 个变体。[记录](../tasks/20261109-libero-plus.md) |
| [VLABench](../../examples/bench-adapters/embodied/VLABENCH.md) | 6 条 Policy 轨道。五条固定轨道共 2,460 个场景，Cross Task 开放轨道有 96 个任务 ID | 6 条轨道全接入，Cross Task 按选定种子生成场景 | 全量核对轨道目录，6 条轨道均有抽样 reset、渲染和控制检查。[记录](../tasks/20261109-vlabench.md) |
| [SimplerEnv](../../examples/bench-adapters/embodied/SIMPLER.md) | Prepackaged 为 Google 21、WidowX 7 个任务；固定网格分别有 1,164（Google Visual Matching）、1,992（Google Variant Aggregation）和 96（WidowX Visual Matching）个初态 | 两套 Prepackaged、三套网格、三套网格的策略终止协议，另有 GR00T 专用登记 | 141 次原生检查覆盖任务 ID 和代表性场景设置；三套网格做过脚本停止与证据检查。Google 的 OptiX 降噪异常可用独立关闭降噪配置。[目录](../tasks/20261108-simplerenv-task-sets.md) · [终止协议](../tasks/20261109-embodied-benchmark-coverage.md) |
| [RoboCasa v0.2](../../examples/bench-adapters/embodied/ROBOCASA-V02.md) | Atomic-24，24 个任务，每任务 50 个种子 | 24 个任务，完整计划 1,200 个样本 | 24 个任务通过 CPU reset、相机和原生控制。另有固定动作对照及脚本 episode 重评。[记录](../tasks/20261109-robocasa-v02.md) |
| [RoboCasa365](../../examples/bench-adapters/embodied/ROBOCASA365.md) | 固定运行时 317 个任务。Multitask 为 18 Atomic-Seen、16 Composite-Seen、16 Composite-Unseen；Lifelong 共 125 个任务 | 317 任务全目录、三个 Multitask 组与汇总、Lifelong 四阶段与三个累计登记。场景划分单独配置 | 317 个任务在 1.0.1 pretrain 场景做过原生检查；50 个 Multitask 任务跨两个运行时和两个场景划分共 200 次检查；核对了 Lifelong 登记范围。[Multitask](../tasks/20261108-robocasa365-task-sets.md) · [全目录与 Lifelong](../tasks/20261109-embodied-benchmark-coverage.md) |
| [RoboTwin 2.0](../../examples/bench-adapters/embodied/ROBOTWIN.md) | Aloha-AgileX 50 个任务，Clean 与 Randomized 共用任务 ID | 两种模式各 50 个任务，冻结专家通过的种子；另有末端位姿登记和单任务模型验收登记 | 两种模式各 50 个任务做过原生控制、三相机和判定检查，另有专家种子抽样。[记录](../tasks/20261108-robotwin-suites.md) |
| [ManiSkill3](../../examples/bench-adapters/embodied/NATIVE-EXPANSION.md#maniskill3-native-tabletop-tasks) | 固定桌面目录 20 个候选任务，另有独立 RLinf Plate-25 recipe | 桌面 profiles 覆盖目录中的 20 个任务，已生成并验证 18 个可运行任务的登记；Plate-25 单独接入 | 桌面 18 个任务通过原生检查，`AssemblingKits-v1` 和 `TurnFaucet-v1` 缺资产实测。Plate-25 做过 GPU reset、渲染和控制。[桌面](../tasks/20261109-embodied-benchmark-coverage.md) · [Plate-25](../tasks/20261108-embodied-native-expansion.md) |
| [Meta-World](../../examples/bench-adapters/embodied/NATIVE-EXPANSION.md) | MT50，50 个任务 | 50 个任务，按 RLinf 单任务 seeded recipe 执行 | 50 个任务通过原生 reset、渲染和控制。[记录](../tasks/20261108-embodied-native-expansion.md) |
| [RLBench](../../examples/bench-adapters/embodied/RLBENCH.md) | MT100 为 100 个任务；RVT-18 为 18 个任务、450 个发布初态 | 两套目录与全部 RVT 初态，单 episode 执行 | 每个 recipe 抽查 3 个任务的原生重置、渲染和控制；有 RVT 固定动作对照、脚本 episode 与 CPU 重评。[记录](../tasks/20261109-rlbench.md) |
| [CALVIN](../../examples/bench-adapters/embodied/CALVIN.md) | ABC→D，1,000 条五指令序列 | Scene D 的 1,000 条序列，原生 oracle 分段计分 | 已展开全量样本计划，两个模型样本覆盖原生逐段执行与重评。[目录](../tasks/20261109-embodied-benchmark-coverage.md) · [原生执行](../tasks/20261108-embodied-calvin-xvla.md) |
| [RoboDojo](../../examples/bench-adapters/embodied/ROBODOJO.md) | ARX-X5，54 个任务（42 基础、12 随机变体） | 全部 54 个任务列入目录，缺布局的任务标记为不可用 | 通过原生目录、配置与运行时前置检查；真实原生任务校准待完成。[记录](../tasks/20261109-robodojo-robolab.md) |
| [RoboLab](../../examples/bench-adapters/embodied/ROBOLAB.md) | DROID，120 个任务 | 120 个任务，可选择子目录登记 | 有真实 RGB、控制和 648 步官方回放的 CPU 验证记录；修正证据封存后的完整 GPU 批次待验证。[记录](../tasks/20261109-robodojo-robolab.md) |
| [RoboMimic](../../examples/bench-adapters/embodied/ROBOMIMIC.md) | PH v1.5.1 的 5 个仿真任务 | 5 个任务各有低维和 RGB 登记，共 10 个 | 10 个登记均通过原生检查；Lift、Transport 做过固定动作对照及 PH 示教回放；另有脚本 Lift 重评。[记录](../tasks/20261110-robomimic.md) |
| [VIMA-Bench](../../examples/bench-adapters/embodied/VIMA-BENCH.md) | 4 个测试划分，42 个划分内条目，17 个不同任务模板 | 4 个划分全部接入 | 42 个条目均通过原生 reset、观测与控制检查。[记录](../tasks/20261110-vima-bench.md) |

## 真实模型实测

这里列出有真实权重运行和独立 CPU 验证记录的组合。Policy 名用于查找登记，具体权重版本、归一化、渲染与控制条件见各组合配置和作业快照。
“短参考对照”只描述记录中实际对齐的边界，例如固定输入、固定动作或短 rollout。
现有证据尚未建立完整套件的统计等价。

| Policy / 权重 | 已实测的 benchmark 协议 | 真实模型样本与参考证据 |
| --- | --- | --- |
| π₀.₅ 官方 LIBERO，`pi05-libero` 或共享 GPU 登记 | LIBERO Spatial、Object、Goal、Long 的 OpenPI recipe | 四套件均有抽样；Spatial 的固定输入、动作及共享编译模型控制通过，独立 GPU 进程逐位对照失败。[Spatial](../tasks/20261105-embodied-eval.md) · [扩展](../tasks/20261107-libero-suites.md) |
| GR00T N1.7 的套件权重，`groot-n17-libero[-<suite>]` | LIBERO Spatial、Object、Goal、Long 的 OpenPI recipe | 四套件均有抽样；Spatial 有短参考边界检查。[Spatial](../tasks/20261106-embodied-endpoints.md) · [扩展](../tasks/20261107-libero-suites.md) |
| OpenVLA-OFT，`openvla-oft-libero-spatial` 与 `openvla-oft-libero-combined-<suite>` | LIBERO OFT recipe，Spatial 专用权重及 Spatial、Object、Goal、Long 联合权重 | 专用和联合 checkpoint 分别实测，另有确定性 I/O 对照；联合权重按套件选择归一化键。[接口](../tasks/20261106-embodied-endpoints.md) · [套件](../tasks/20261107-libero-suites.md) |
| RLinf OpenVLA-OFT，`openvla-oft-rlinf-libero-90` | LIBERO-90 OFT recipe | 两个冻结任务的真实批次、CPU 验证与重评。[记录](../tasks/20261108-libero-90-rlinf.md) |
| SmolVLA `smolvla-libero`；MolmoAct2 `molmoact2-libero` | 分别为 LIBERO Spatial、Goal 各自的模型协议 | 两个组合分别通过两个冻结样本、CPU 验证和选定重评。[记录](../tasks/20261108-embodied-native-expansion.md) |
| OpenVLA-OFT 联合权重，`openvla-oft-libero-combined-spatial` | LIBERO-Plus Spatial | 两个扰动样本（光照和纹理）通过真实批次、CPU 验证与重评。[记录](../../examples/bench-adapters/embodied/LIBERO-PLUS.md#verification) |
| OpenWAM，`openwam-alpha-sim-vlabench` | VLABench Track 1 | 一个真实 episode 与独立 CPU 验证；另做了参考客户端 I/O 和动作转换对照。[记录](../tasks/20261109-openwam.md) |
| GR00T N1.7 Bridge / Fractal，`groot-n17-widowx` / `groot-n17-google` | SimplerEnv WidowX / Google Robot 的 GR00T recipe | 两套均有真实抽样、批次和独立验证；WidowX 有参考边界抽查，Google 有固定动作对照。[WidowX](../tasks/20261106-embodied-batches.md) · [参考边界](../tasks/20261106-embodied-endpoints.md) · [Google](../tasks/20261107-groot-google.md) |
| RoboCasa365 π₀.₅，`pi05-robocasa365-shared` | RoboCasa365 Atomic-Seen，OpenPI recipe | 两个冻结样本通过真实批次及 CPU 验证，另有短原生状态与动作对照。[记录](../tasks/20261107-robocasa365.md) |
| RoboCasa365 GR00T N1.5，`groot-n15-robocasa365-shared` | RoboCasa365 Atomic-Seen 与 `target50` pretrain 中的两个 Composite 组 | Atomic 两个样本与官方多步 wrapper 对照；两个 Composite 组各一个真实样本，均有独立验证与重评。[Atomic](../tasks/20261107-robocasa365-gr00t-n15.md) · [Composite](../tasks/20261109-embodied-benchmark-coverage.md) |
| RoboCasa365 Diffusion Policy，`diffusion-policy-robocasa365-shared` | RoboCasa365 Atomic-Seen，双帧八步 recipe | 两个冻结样本覆盖成功停止与步数上限，完成 CPU 验证和选定重评。[记录](../tasks/20261109-robocasa365-diffusion-policy.md) |
| 社区 RoboTwin π₀.₅，`pi05-robotwin-adjust-bottle-shared` | RoboTwin Clean 单任务 `adjust_bottle` | 两个专家通过场景的真实批次及独立验证，另有原生固定动作对照。[记录](../tasks/20261107-robotwin.md) |
| X-VLA，`xvla-robotwin2` | RoboTwin Clean、Randomized 末端位姿协议 | 两套各两个真实样本并重评。[Clean](../tasks/20261108-embodied-calvin-xvla.md) · [Randomized](../tasks/20261109-embodied-benchmark-coverage.md) |
| RLinf OpenVLA-OFT，`openvla-oft-rlinf-maniskill3` | ManiSkill3 Plate-25 | 两个真实样本通过共享批次、CPU 验证和重评。[记录](../tasks/20261108-embodied-native-expansion.md) |
| RLinf π₀.₅，`pi05-rlinf-metaworld` | Meta-World MT50 | 两个任务实测并重评。短参考对照核对首个动作块与原生任务判定。[接入](../tasks/20261108-embodied-native-expansion.md) · [参考对照](../tasks/20261108-embodied-calvin-xvla.md) |
| RLinf π₀.₅，`pi05-rlinf-calvin-abc-d` | CALVIN ABC→D | 两条五指令序列经过真实批次、逐段计分、CPU 验证和重评。[记录](../tasks/20261108-embodied-calvin-xvla.md) |
| 官方 VIMA 20M，`vima-20m` | VIMA-Bench Placement | Visual Manipulation、Follow Order 有真实样本与重评；Follow Order 与上游无头示例对齐动作和终止序列。[记录](../tasks/20261110-vima-bench.md) |
