# 具身评测接入模板

模型端和 benchmark 端分别登记，组合验收记录具体的权重、评测 recipe 和样本计划。先从兼容矩阵选一个已有组合做基线。新增模型优先复用 benchmark 和 connector，新增套件优先复用原生 driver。遇到新的传输协议或环境 API 时，在对应端实现适配。[兼容矩阵](embodied-compatibility.md) · [原生适配器](../../examples/bench-adapters/embodied/README.md)

## 模型端

复制表格填写模型接入记录。生成的 `policy.json` 交给 `orbit policy add`。已有模型可直接参考对应的配置生成器。[PolicyDefinition](../../packages/orbit/src/contracts/embodied.ts) · [π₀.₅](../../examples/bench-adapters/embodied/configure.py) · [GR00T](../../examples/bench-adapters/embodied/configure_groot.py) · [OpenVLA-OFT](../../examples/bench-adapters/embodied/configure_openvla.py)

| 填写项 | 记录内容 |
| --- | --- |
| Policy 登记 | `name`、`version`、`kind: model`、connector、端口、调用超时和适用的套件或 embodiment |
| 源码与权重 | 固定源码版本和关键文件摘要。记录 checkpoint 版本与 `checkpointDigest`、`normalizationDigest`，按模型补充 `backboneDigest` 或 OFT 的 `normalizationKey` |
| 服务与资源 | 固定镜像 ID 或仓库 digest、启动命令、readiness 检查、CPU 与内存预算、GPU 分配方式、只读命名权重 dataset |
| Policy I/O | 输入 `profile` 的字段、形状、dtype、相机、坐标系和单位。动作声明控制器、坐标系、分量顺序、旋转和夹爪语义 |
| 模型侧转换 | 记录 `ioAdapter`（如适用）、预处理、归一化、动作转换和 `replanSteps`。握手核对冻结的身份和随机流声明 |

先用固定观测和动作检查客户端、服务握手及输出转换，覆盖错误身份、错误形状、非有限值和超时。模型端负责自身的输入处理和动作转换，环境端负责原生控制器的执行与判定。新增传输时参考 `LazyPolicy` 的客户端选择和身份校验。共享 GPU 时使用 `gpusOf: main`，由模拟器持有主角色 GPU，并把两端的显存预算相加。[模型接入入口](../../examples/bench-adapters/embodied/run.py)

## Benchmark 端

生成 `benchmark.json` 交给 `orbit bench add-file`。原生路径把评测条件放进 `reference`，通过 `profileDigest` 和 `implementationDigest` 校验 recipe 与实现。[适配器协议](bench-adapter.md) · [LIBERO reference 示例](../../examples/bench-adapters/embodied/reference.json) · [原生 Gym reference 示例](../../examples/bench-adapters/embodied/profiles/groot-google.json)

| 填写项 | 记录内容 |
| --- | --- |
| Benchmark 登记 | 名称、adapter、上游源码 checkout、固定模拟器镜像与渲染后端 |
| 目录与初态 | 套件 ID、任务列表、初态资产摘要与索引，或原生环境的生成 seed 规则 |
| 原生评测 recipe | reset、settle、控制频率（如适用）、horizon、重规划步数、终止与成功条件，以及 `official` 的聚合单位和错误处理 |
| Benchmark I/O | `benchmarkProfile` 描述原始观测与动作。用 `observationMap` 声明 Policy 字段到 benchmark 字段的对应 |
| 证据与重评 | 用 driver 和验证器保存样本、binding、实现摘要、原生执行动作及判定。确认每个 episode 都能独立使用保存的证据进行 CPU 验证与重评 |

新增环境 driver 时参考 LIBERO 或原生 Gym 的 `reset`、`step` 和状态记录，复用已有适配器的 `tasks`、`solve`、`verify` 和 `score` 流程。先核对目录及初态资产，再验证代表任务的 reset、观测、少量原生控制步、终止和正负例。记录实际完成原生检查的任务数。[LIBERO driver](../../examples/sdk/orbit_embodied/libero.py) · [Gym driver](../../examples/sdk/orbit_embodied/gym.py)

提交时 Orbit 校验映射和语义，再冻结 `ResolvedBinding`。维度相同的字段仍须匹配相机、单位、坐标系等语义。模型配置和 benchmark recipe 的重规划步数也须一致。

## 组合验收

使用已有生成器准备 `policy.json`、`benchmark.json` 和对应的 reference。下例适用于原生 LIBERO，在仓库根目录运行。将变量设为本地生成配置目录、命名 dataset、模型权重目录和矩阵中匹配的登记名。任务 ID 从 `bench tasks` 选取，环境 seed 和 suite ID 取自所选 recipe。

```bash
orbit data add "$WEIGHTS_DATASET" "$WEIGHTS_DIR"
orbit policy add "$LOCAL_CONFIG/policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"
orbit bench tasks "$BENCHMARK" --json

python3 examples/bench-adapters/embodied/plan.py \
  --reference-source "$BENCHMARK_SOURCE" --reference-file "$REFERENCE_FILE" \
  --suite "$SUITE" --task "$TASK_ID" --initial-state 0 --initial-state 1 \
  --environment-seed "$ENVIRONMENT_SEED" > "$LOCAL_CONFIG/samples.json"

orbit bench calibrate "$BENCHMARK" --policy "$POLICY" \
  --sample-plan "$LOCAL_CONFIG/samples.json" --budget 20 --json
```

SimplerEnv 使用对应 Gym reference 和任务 ID，可省略 `--suite`。它用 `environmentSeed + initialStateId` 生成场景。LIBERO 则用 `initialStateId` 索引已固定的初态文件。[LIBERO 配置示例](libero-suites.md) · [SimplerEnv 配置示例](../../examples/bench-adapters/embodied/GR00T.md)

每个新组合先跑 2–5 个冻结样本，通常选同一代表任务的不同初态。20 分钟预算包含排队、模型启动、执行、CPU 验证及默认首样本重评，最长可设 30 分钟。判定时检查真实模型身份、一个批次一次模型加载、独立 CPU 验证、重评一致性和清理完成。原生任务失败可以得到有效的 0 分，仍可通过接入检查。超时和无效结果按校准报告记录。[接入校准](policy-integration-checks.md) · [批量运行](embodied-batches.md)

复制以下验收记录。状态使用 `passed`、`failed` 或 `not_run`，并记录依据或原因。具体作业 ID、分数、权重、生成配置及运行产物留在源码工作树之外。

```md
## <模型权重版本> × <benchmark / recipe>

| 项目 | 记录 |
| --- | --- |
| Policy 与 benchmark 登记 | <两个登记名、套件、checkpoint / normalization 身份> |
| 固定评测条件 | <reference 与实现摘要、模拟器镜像、渲染、重规划、GPU 分配> |
| 固定样本计划 | <计划摘要、代表任务、初态或生成 seed、样本数、顺序、预算> |

| 检查 | 状态 | 范围与依据 |
| --- | --- | --- |
| 模型接口和语义 binding | <状态> | <检查版本与范围> |
| 原生任务覆盖 | <状态> | <目录数、实际 reset/step 数、正负例或固定动作对照> |
| 真实抽样接入 | <状态> | <样本数、批次、CPU 验证、重评、资源释放> |
| 参考对照 | <状态> | <上游版本、确定性 I/O / 固定动作 / rollout 的实际范围> |
| 完整套件统计 | <状态> | <样本范围、预先声明的统计标准，或未运行原因> |
```
