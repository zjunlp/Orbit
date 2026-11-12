# 具身评测快速开始

Orbit 分别登记 **Policy**（模型服务、权重和 I/O）与 **benchmark**（原生仿真环境、任务和评测协议）。
提交时用 Method 选定 Policy，Orbit 核对观测和动作的语义映射，并冻结本次使用的样本与配置。

## 1. 选组合并登记

从[已实测的模型组合](embodied-compatibility.md#真实模型实测)选择具体权重和评测协议，再按
[配置指南索引](../../examples/bench-adapters/embodied/README.md)准备对应的源码、镜像、权重和场景资产。
常用起点有 [π₀.₅ × LIBERO Spatial](../../examples/bench-adapters/embodied/OPENPI-LIBERO.md)和
[可在 CPU 上运行的 VIMA 20M × VIMA-Bench](../../examples/bench-adapters/embodied/VIMA-BENCH.md)。
产品目录会显示 Orbit 支持的家族，本机可用的登记用 `orbit bench ls` 和 `orbit policy ls` 查看。

各组合的指南给出镜像构建、数据集登记（如需）、`orbit bench add-file`、`orbit policy add` 和
`plan.py` 的参数。初次运行时，用 `orbit bench tasks "$BENCHMARK" --json` 选一个任务，
按照所选协议生成只含一个初态的样本计划。

## 2. 跑一个样本

把变量设为已登记的 benchmark 名、Policy 名和生成的样本计划路径。

```bash
orbit bench run "$BENCHMARK" --method "model=policy,policyRef=$POLICY" \
  --sample-plan "$SAMPLE_PLAN"
```

一个样本对应一个 Trial。Solve 执行仿真并保存证据，Verify 在独立 CPU Run 中校验证据并计分。
先看 Trial 是否有效，再看任务得分。模型在步数上限内未完成任务可以是有效的零分；
无法初始化或证据缺失则会有对应的问题状态。
要扩大样本量，见[固定批量运行](embodied-batches.md)和[短接入验收](policy-integration-checks.md)。

## 3. 在 Web 回看 Trial

运行 `orbit web --open`，进入 **Evaluations**，打开作业并点击列表或矩阵里的 Trial。

- 作业页查看分数、有效样本数和报告版本。Trial 页查看单次判定、Solve 和 Verify。
- 有录像时，在 Trial 的产物中打开视频。录像取决于该登记的观测与记录配置。
- 有轨迹索引时，**Episode timeline** 同步显示已保存的相机、动作和状态。RoboTwin、LIBERO、RoboDojo 与 RoboLab
  的时间轴字段及历史证据重查方式见 [Web 轨迹复盘](gui-bench-web.md#embodied-episodes)。

要对保存的 episode 重评，可运行 `orbit bench rescore "$JOB" --trial "$TRIAL"`。
重评使用 Solve 保存的证据，保留历史分数，并生成报告版本。

[接入自己的 Policy 或 benchmark](embodied-onboarding.md) · [开发验证和 Python 环境](embodied-development.md)
