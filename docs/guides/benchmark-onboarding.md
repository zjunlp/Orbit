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

Web 的 **Benchmarks** 卡片可选择最多四个家族，再点 **Compare selected**。
选择保存在 URL，改变搜索、六维或本地登记筛选不会移除已选家族；隐藏项有明确提示。
对比页按家族选择一个 protocol profile，查看协议标签、支持范围、验证来源和本地 setup，
不提供分数排名，也不表示任意模型都能运行这些任务。

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

也可在 Web 点击 **Add your own benchmark**（`/benchmarks?mode=add`），填写
Benchmark name、daemon 机器上的新绝对目录与 Template。确认文件预览后点击
**Create tutorial**，由 daemon 写入；目标父目录必须存在，目标不能已存在或在 Orbit
home/data 内，路径祖先不能是 symlink。错误后可修正输入重试；离开页面不会取消已提交的创建。
成功后显示真实生成的目录、文件列表及可复制命令，仍需自己明确执行登记和校准。

默认 `adapter` 模板提供独立 verify grader；`manifest` 模板由可信原生 runner 写结果，
verify 复核记录。后者不允许任意模型自行报告分数。manifest 模板只支持 empty/oracle；adapter 模板也支持 Agent solve，校准默认先用这两个对照。
生成 benchmark.json 和 README，不自动登记或启动。按生成输出执行 `add-file`、
`coverage` 与 `calibrate` 命令；在真实接入前替换合成数据、runner 与评分逻辑。

## 4. 检查自定义定义，再明确登记

CLI 可读取生成或自行编写的 benchmark JSON：

```bash
orbit bench add-file /absolute/path/benchmark.json --check --json
orbit bench add-file /absolute/path/benchmark.json --create-only
```

先用 `--json` 检查完整返回的定义、supported/listed、suite、unsupported 原因与方法/指标；
不带 `--json` 的人类输出仅包含名称、重名状态与覆盖摘要。
`--check` 不登记，也不创建 job/Run；它会在 daemon 主机执行 adapter 的 tasks 代码，
只检查可信来源的定义与适配器。检查成功仅证明任务枚举与配置校验，不证明运行就绪或校准。
`--create-only` 是另一步明确登记，重名时拒绝覆盖；不带该参数的旧登记命令仍允许替换。
检查和 create-only 参数不能同时使用。

Web **Add your own benchmark → Import definition** 可上传 JSON 文件或粘贴 JSON（最多 1 MiB）。
教学生成成功后也可点 **Continue to registration** 带入定义；旧 daemon 未返回定义时使用生成的
benchmark.json。点 **Check definition** 后审阅规范化定义中的路径、配置/env/passEnv 名称、任务覆盖、
suite 与不支持原因，再点 **Register local setup**。修改输入会撤销旧检查结果；错误后须重新检查。
同名登记存在时显示提示并禁止登记，最终提交仍使用 create-only 保护检查后的重名竞争。
成功后用 **View setup and task coverage** 查看，或明确选择 **Evaluate**；不会自动启动评测。
家族专属资源准备继续使用 **Prepare resources**，不由这个通用导入流程替代。

## 5. 用校准检查接线，再验证真实协议

```bash
orbit bench coverage my-bench
orbit bench calibrate my-bench --sample 1
```

模板校准只证明教学示例的执行、独立验收、重复、清理和 rescore 接线，不能作为真实
benchmark 验证。真实接入须用官方任务检查 empty/oracle 或适合该协议的对照，
检查私有答案未进入 solve 输入、资源边界和失败诊断，并与官方评分核对。
抽样检查的报告应写明任务与版本范围；完整套件统计等价需要另行证明。
根据 `orbit bench usage <job>` 的实测数据调整 resources，再扩大任务范围。

## 6. 创建 Evaluation 时先看兼容反馈

在 **New evaluation** 选择已登记环境后，**Configurations** 和 **Review & start** 会显示
当前 CLI Agent 的准入反馈。已知 MCP/能力阻断会显示原因；凭据下拉仅提供同时满足所选
Agent harness 与其接受 auth kind 的 profile。编辑配置、切换或刷新环境不会清空配置草稿。

更新 Agent、凭据或 adapter 后点 **Refresh configuration checks**，重新枚举任务并读取
当前定义；这可能执行可信 adapter 的 tasks 代码。targeted 检查不沿用旧目录缓存或历史成绩。
unknown、检查失败、旧 daemon 无即时来源标记都不等于允许或 ready；它们本身不阻止继续，
已知 profile/能力错误仍需修复。任务枚举失败则仍需刷新成功后才能继续，
不同于兼容 metadata unknown 本身不阻断。最终提交始终由 daemon 再验，资源、安装、模型连通性与
校准需要独立验证。empty/oracle、external 使用各自规则，不显示为 CLI Agent 兼容结论。
