# 原生具身评测兼容矩阵

范围是 Orbit 的 C6 原生 benchmark 与独立 Policy。表中「实测」表示该权重与 recipe 已运行真实抽样 episode，并完成独立验证。任务数表示已登记的目录大小。破折号表示当前分支缺少该组合的登记与验证。新增组合使用同一套接入模板记录。[接入模板](embodied-onboarding.md)

| 环境与套件 | 任务数 | Benchmark 登记 | π₀.₅ | GR00T N1.7 | OpenVLA-OFT |
| --- | ---: | --- | --- | --- | --- |
| LIBERO Spatial `libero_spatial` | 10 | `libero-native` / `libero-oft-native` | 实测 | 实测 `groot-n17-libero` | 实测 `openvla-oft-libero-spatial`、`openvla-oft-libero-combined-spatial` |
| LIBERO Object `libero_object` | 10 | `libero-object-native` / `libero-oft-object-native` | 实测 | 实测 `groot-n17-libero-object` | 实测 `openvla-oft-libero-combined-object` |
| LIBERO Goal `libero_goal` | 10 | `libero-goal-native` / `libero-oft-goal-native` | 实测 | 实测 `groot-n17-libero-goal` | 实测 `openvla-oft-libero-combined-goal` |
| LIBERO Long `libero_10` | 10 | `libero-long-native` / `libero-oft-long-native` | 实测 | 实测 `groot-n17-libero-long` | 实测 `openvla-oft-libero-combined-long` |
| SimplerEnv WidowX Visual Matching | 7 | `simpler-widowx-native` | — | 实测 `groot-n17-widowx` | — |
| SimplerEnv Google Robot | 6 | `simpler-google-native` | — | 实测 `groot-n17-google` | — |
| RoboCasa365 Atomic-Seen | 18 | `robocasa365-atomic-seen-native` | 实测 `pi05-robocasa365-shared` | — | — |

LIBERO 的四个 π₀.₅ 套件共用官方 `pi05_libero` 权重，Policy 登记为 `pi05-libero`，共享 GPU 配置登记为 `pi05-libero-shared`。RoboCasa365 使用自己的公开 π₀.₅ 权重。GR00T 的 LIBERO 权重按 suite 子目录选择，WidowX 用 Bridge，Google Robot 用 Fractal，三条路径共用固定 backbone 缓存。OFT 的 Spatial 专用权重和四套件联合权重分别有实测记录。联合权重按 suite 选择 `<suite>_no_noops`，Long 对应 `libero_10_no_noops`。[LIBERO 套件选择](libero-suites.md) · [RoboCasa365 配置](../../examples/bench-adapters/embodied/ROBOCASA365.md) · [GR00T 配置](../../examples/bench-adapters/embodied/GR00T.md) · [OFT 模型配置](../../examples/bench-adapters/embodied/profiles/openvla-model.json)

## 评测条件

LIBERO 的每行有两个登记。π₀.₅ 和 GR00T 用左侧的 OpenPI recipe，OFT 用右侧的 OFT recipe。两条 recipe 共用 OpenPI 固定版本的 LIBERO 仿真与初态文件。配对比较按冻结的样本和评测条件核对，包含 recipe、镜像、渲染和实际预算。[评测条件](../../packages/orbit/src/bench/summary.ts)

| Recipe | 样本与控制 | 渲染配置 |
| --- | --- | --- |
| LIBERO OpenPI | 环境 seed 7，10 步 settle，每 5 步重规划 | 默认 CPU OSMesa，共享 GPU 时用 EGL |
| LIBERO OFT | 环境 seed 0，10 步 settle，每 8 步重规划 | 默认 CPU OSMesa，共享 GPU 时用 EGL |
| WidowX Visual Matching | 生成场景 seed，5 Hz，每 4 步重规划，horizon 300 | Vulkan，可显式共享主角色 GPU |
| Google Robot | 生成场景 seed，3 Hz，每步重规划，horizon 300，原生 sticky gripper | Vulkan，可显式共享主角色 GPU |
| RoboCasa365 Atomic-Seen | `pretrain` 场景的独立种子，20 Hz，每 5 步重规划，horizon 按任务固定 | EGL，可显式共享主角色 GPU |

LIBERO 的 horizon 按 Spatial、Object、Goal、Long 分别为 220、280、300、520。各套件的渲染配置以作业快照为准。LIBERO-90 的匹配权重组合尚无接入验收记录。[LIBERO 套件条件](libero-suites.md) · [WidowX recipe](../../examples/bench-adapters/embodied/profiles/groot-widowx.json) · [Google Robot recipe](../../examples/bench-adapters/embodied/profiles/groot-google.json)

## 验证依据

| 范围 | 已记录的验证 |
| --- | --- |
| LIBERO Spatial | π₀.₅ 真实样本、原生正负例和独立验证。GR00T 固定批次及独立 CPU 验证。OFT 专用和联合 checkpoint 分别通过真实抽样接入。[π₀.₅](../tasks/20261105-embodied-eval.md) · [GR00T 批次](../tasks/20261106-embodied-batches.md) · [OFT 专用](../tasks/20261106-embodied-endpoints.md) · [OFT 联合](../tasks/20261107-libero-suites.md) |
| LIBERO Object、Goal、Long | 30 个任务通过原生 reset 和控制步检查。9 个新增模型与套件组合分别通过两个冻结 episode 的真实接入检查。[LIBERO 扩展验收](../tasks/20261107-libero-suites.md) |
| SimplerEnv WidowX | 7 个任务通过原生初始化、渲染和控制步检查，Bridge 通过真实抽样与固定批次检查。[原生覆盖](../tasks/20261106-embodied-endpoints.md) · [Bridge 批次](../tasks/20261106-embodied-batches.md) |
| SimplerEnv Google Robot | 6 个任务通过原生初始化和控制步检查，原生固定动作对照通过，Fractal 通过有界真实抽样、CPU 验证与重评。[Google Robot 验收](../tasks/20261107-groot-google.md) |
| RoboCasa365 Atomic-Seen | 18 个任务通过原生初始化、渲染和控制步检查。两个任务的原生状态和控制向量一致，独立渲染最大差 1 个灰阶值。官方 π₀.₅ 通过两个冻结样本的共享 GPU 批次、CPU 验证和选定样本重评。[RoboCasa365 验收](../tasks/20261107-robocasa365.md) |
| 参考对照 | π₀.₅ Spatial 的确定性处理、固定动作和共享编译模型控制通过，独立 GPU 进程逐位比较失败。GR00T 的 Spatial 与 WidowX 做过抽样参考边界检查。OFT 做过确定性 I/O helper 对照。[π₀.₅ 对照](../tasks/20261105-embodied-eval.md) · [GR00T 与 OFT 对照](../tasks/20261106-embodied-endpoints.md) |
| 完整套件统计等价 | `not_run`。现有记录覆盖原生任务目录检查、真实抽样和指定条件下的参考对照。 |
