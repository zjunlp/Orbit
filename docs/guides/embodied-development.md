# 具身评测开发验证

Orbit CLI 和 daemon 使用项目规定的 Node。具身 Python 代码分成主机工具、共享 SDK、模拟器和模型服务。
本页的 Python 测试从仓库根目录运行。变量 `PYTHON38` 和 `PYTHON311` 指向各自隔离环境的
`bin/python`，可以使用已准备的虚拟环境。

手动运行 `configure_*.py`、`plan.py` 等工具时，使用当前 shell 选定的 Python。
daemon 另行在主机上启动 adapter，原生 adapter 的 `/usr/bin/env` 从 daemon 的 `PATH` 找
`python3`。Solve 和 Verify 使用 benchmark 镜像中的 Python，Policy 服务使用其自己的镜像。

## Python 3.8 共享 SDK 回归

用显式模块列表检查 adapter 协议、Binding、episode 驱动、证据、批次与模型传输。该列表不收集各 benchmark
的主机配置工具。覆盖这些模块是为了守住旧运行时的兼容路径，例如 LIBERO 的模拟器镜像。

```bash
PYTHONPATH=examples/sdk "$PYTHON38" -B -m unittest -v \
  orbit_bench.test_protocol \
  orbit_embodied.test_core orbit_embodied.test_batch \
  orbit_embodied.test_openpi orbit_embodied.test_groot orbit_embodied.test_openvla
```

## Python 3.11 主机集成回归

完整发现同时跑共享 SDK 测试和主机工具回归，例如 RoboDojo、RoboLab、RoboTwin 和 SimplerEnv 的配置生成器。
RoboDojo 配置工具使用 `Path.is_relative_to()`，需要 Python 3.9 或更新版本。
复现单个工具问题时，可用相同环境运行对应模块，例如
`PYTHONPATH=examples/sdk "$PYTHON311" -B -m unittest -v orbit_embodied.test_robodojo`。
工具的实际构建和登记依赖按各 [benchmark 的配置指南](../../examples/bench-adapters/embodied/README.md)准备。

```bash
PYTHONPATH=examples/sdk "$PYTHON311" -B -m unittest discover -s examples/sdk -p 'test_*.py' -v
```

两组检查使用 NumPy、固定 OpenPI checkout 的 `openpi-client`、Pillow、`websockets==13.1`、
`pyzmq==26.2.0`、`msgpack==1.1.0` 和 `msgpack-numpy==0.4.8`。
Python 3.11 的真实 HDF5 生命周期检查还使用 `h5py`。缺少可选依赖时检查输出中的 skip；
导入期缺包会报 `ModuleNotFoundError`，那是环境问题而不是代码缺陷，各包对应的可选依赖见
[SDK 说明](../../examples/sdk/README.md#optional-dependencies)。
这些回归包括明确标注的合成策略和本地传输测试。

`pnpm verify` 还会用当前虚拟环境的 `python3` 发现适配器根目录的测试。需要模拟器镜像的回归由各 benchmark 指南给出运行命令。

## 固定运行时中的原生验证

按各组合的镜像配方运行模拟器和 Policy。镜像内的 Python 与主机工具虚拟环境分开选定。例如
π₀.₅ × LIBERO 的固定配方中，模拟器使用 3.8.20，OpenPI 服务使用 3.11.9。
登记后使用 [组合验收流程](embodied-onboarding.md#组合验收)，分别记录实际执行的原生检查、真实模型样本和
上游参考对照。CPU 重评使用保存的证据。
