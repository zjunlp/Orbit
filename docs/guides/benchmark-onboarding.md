# 从发现 benchmark 到完成接入

## 1. 先找已有接入

```bash
orbit bench catalog
orbit bench catalog --search "browser"
orbit bench catalog --filter domains=software --filter interfaces=terminal
orbit bench catalog humaneval
orbit bench ls
```

`catalog` 是随版本发布的产品目录，`ls` 是本地登记。详情给出具体 suite/profile、
接入范围、验证事实与来源；登记存在、资源就绪、抽样校准、完整套件等价是不同事实。
`--registered` 只筛选有关联本地登记的产品。详情与筛选规则见 [目录](../catalog.md)。

## 2. 准备现有 benchmark 的资源

```bash
orbit bench resources humaneval
orbit bench prepare humaneval --help
```

先读取该家族的官方来源、许可与所需参数，再执行配方。已有下载可按配方使用
`--reuse RESOURCE=PATH`；数据、模型权重和运行输出放在源码目录之外。
部分家族需要手动授权、准备或导入 definition，不能仅凭产品目录推断自动下载可用。
准备命令与状态查看见 [资源准备](benchmark-resources.md)。完成登记后执行
`orbit bench coverage <registration>` 检查本机支持范围。

## 3. 没有现成接入时选择路线

| 路线 | 适用情况 | 优先复用 |
| --- | --- | --- |
| `harbor` | 已有 Harbor 任务目录与 verifier | 官方任务、环境和 verifier |
| `manifest` | 已有镜像、可信原生 runner 和结果 JSON | 原生 runner 的评分与结果协议 |
| `sdk` | Python 外部适配器，需要交互桥或独立证据处理 | SDK 协议辅助函数与官方 grader |
| `native` | 任意语言实现 Orbit adapter 协议，或包装原生执行流程 | 原生任务、执行器与官方 grader |

四条路线最终使用同一 adapter 协议；无需增加第二套执行系统。优先复用官方 grader，
说明上游版本、计分单位、私有参考答案边界和明确排除的任务。详见
[适配指南](bench-adapter.md) 和 [Python SDK](../../examples/sdk/README.md)。

生成一个 CPU 合成教学模板：

```bash
orbit bench init my-bench /absolute/path/my-bench
# 或：orbit bench init my-bench /absolute/path/my-bench --template manifest
```

默认 `adapter` 模板提供独立 verify grader；`manifest` 模板由可信原生 runner 写结果，
verify 复核记录。后者不允许任意模型自行报告分数。manifest 模板只支持 empty/oracle；adapter 模板也支持 Agent solve，校准默认先用这两个对照。
生成 benchmark.json 和 README，不自动登记或启动。按生成输出执行 `add-file`、
`coverage` 与 `calibrate` 命令；在真实接入前替换合成数据、runner 与评分逻辑。

## 4. 用校准检查接线，再验证真实协议

```bash
orbit bench coverage my-bench
orbit bench calibrate my-bench --sample 1
```

模板校准只证明教学示例的执行、独立验收、重复、清理和 rescore 接线，不能作为真实
benchmark 验证。真实接入须用官方任务检查 empty/oracle 或适合该协议的对照，
检查私有答案未进入 solve 输入、资源边界和失败诊断，并与官方评分核对。
抽样检查的报告应写明任务与版本范围；完整套件统计等价需要另行证明。
根据 `orbit bench usage <job>` 的实测数据调整 resources，再扩大任务范围。
