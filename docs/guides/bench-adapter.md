# 接入新 benchmark

适用版本：`refactor/ts-rewrite`（adapter 协议、资源文件、实测用量）。Agent 用的 skill：`plugin/skills/orbit-bench`。模型、判定规则与协议定义见 [design §7](../design.md#7-刷榜bench)。

## 1. 先选路线

| benchmark 的形态 | 路线 | 要改 Orbit 吗 |
| --- | --- | --- |
| Harbor 任务目录（`task.toml` + `instruction.md` + `environment/` + `tests/` + `solution/`），verifier 为 separate 或 shared 模式 | 内置 `harbor` 适配器 | 否 |
| ASI-Bench seed31415 | 内置 `asi` 适配器 | 否 |
| 其他任何形态 | 写一个外部适配器（任意语言的可执行文件），登记时 `--adapter /path/to/adapter` | 否 |

外部适配器和内置适配器走同一套协议，Orbit 不需要重新构建或重启。适配器文件放在 benchmark 仓库或任意目录。
示例：[ResearchClawBench](../../examples/bench-adapters/researchclawbench/) ·
[LongDS-Bench](../../examples/bench-adapters/longds/)（原生 Codex / Claude 多轮 runner、独立原版 judge） ·
[BrowserGym/MiniWoB](../../examples/bench-adapters/browsergym/)（外部 GUI 策略、实时原版奖励、截图与轨迹）。

### ASI-Bench 版本兼容

内置 `asi` 使用注册目录中的 ASI runner/scorer，不随 Orbit 捆绑一份 ASI 源码。
Agent 方法需要完整源码 checkout、支持 `--fail-on-agent-error` 的 CLI，以及已修复的
Codex/Claude 沙箱状态判定：正常退出不能被后台请求的 `timed out` 日志覆盖。
Orbit 在生成 Agent solve 命令前，使用 `config.python` 只读解析所选 adapter 与 CLI；
识别已知的错误条件结构时拒绝启动并提示升级。
这是已知版本问题的检查，不会改写第三方源码，也不会根据评分有效就改成执行成功。
oracle/empty 不经过 Agent adapter 检查；所有 solve 都显式启用失败退出码。

评分阶段请求 1 CPU、4 GiB 内存、0 GPU。TSP 任务的 native scorer 规定运行 3600 秒，
Max3SAT 为 1800 秒；Orbit 外层上限分别为 90 和 60 分钟，为启动、收尾和评分留出时间。
其他 ASI 任务维持 30 分钟。这不改变 task 的 solver 预算，也不改变求解阶段的资源配置。
修复后可用 `orbit bench rescore <job> -t <task>` 在原 job 中重评保存的产物，旧评分保留在 history。

如果使用仍有该问题的旧版源码，在 Codex/Claude OS adapter 中将
`if "timed out" in log: ... elif success: ...` 改为优先检查执行结果。例如，沙箱返回
`success, log` 且真实超时诊断为下列格式时，等价修复为：

```python
if success:
    status = RunStatus.COMPLETED
elif log == f"OS sandbox agent execution timed out ({eff_timeout}s)":
    status = RunStatus.TIMEOUT
else:
    status = RunStatus.FAILED
```

保留 adapter 后续已有的原生终止事件失败检查。分别验证正常退出带超时警告、真实沙箱超时、
其他非零退出；旧 CLI 若不支持 `--fail-on-agent-error`，还需升级到支持该选项的版本。

升级的是 `orbit bench ls` 中显示的**注册路径**。如果此前注册了固定快照，修改主 checkout
或仅升级 pip 包不会更新快照；为后续实验注册包含修复的新快照，并保留旧批次的源码与版本记录。
`orbit bench tasks asi` 仍仅列任务，Agent 兼容性检查在规划该方法的 solve 时执行。

trial review 显示最新 attempt 的 `completed` / `execution_timeout` / `execution_failed` /
`execution_incomplete`，分数是否 valid 由独立评分过程决定。真实超时仍可留下可评分的输出。
更新 Orbit 不自动重写已结束的 Run、退出码、日志或分数；历史误判需要逐项核验证据后单独纠正。

## 2. Harbor 路线

```bash
orbit bench add tbs /path/to/terminal-bench-science --adapter harbor
orbit bench tasks tbs                      # 列出任务；不支持的任务给出原因
orbit bench run tbs -t <task> -m oracle -m empty -n smoke
orbit bench show <job>
```

Orbit 读取的 `task.toml` 字段：

| 字段 | 用途 |
| --- | --- |
| 顶层 `artifacts` | solve 结束时采集，复制挂载进 verifier 的同一路径（表形式可写 `destination`） |
| `[environment] docker_image / cpus / memory_mb / gpus / network_mode / env / workdir` | solve Run 的镜像（缺省 `environment/Dockerfile`）、资源、网络、环境变量与工作目录 |
| `[agent] timeout_sec / network_mode` | solve 超时（`orbit bench run --timeout` 覆盖）与网络 |
| `[verifier] environment_mode / timeout_sec / env / network_mode`，`[verifier.environment]` | verify Run；模式、镜像与网络的缺省规则同 Harbor（见 design §7），没有 `tests/Dockerfile` 时复用任务环境并把 `tests/` 挂到 /tests |
| `[solution.env]` | oracle 运行 `solution/solve.sh` 时的环境变量 |
| `[metadata] domain / field / subfield` | 任务标签 |

`orbit bench tasks` 会列出不支持的设置（如 compose 中未实现的键、`allowlist` 网络、`mcp_servers`、`${VAR}` 模板），
这些任务不会运行，以免在不同条件下打分。

verifier 必须把分数写到 `/logs/verifier/reward.txt`（一个数）或 `reward.json`（`reward` 键或唯一键），满分为 1。
`environment/docker-compose.yaml` 中的其他服务作为服务容器与 solve Run 一起启动（就绪后才启动 Agent），`service = "<名>"` 的 artifacts 从该服务采集；服务日志在 solve Run 的 `output/services/<名>/log`。shared 模式（默认）的 verifier 在 solve Run 的同一容器里、方法结束后运行（after 阶段），这类 trial 不能 `bench rescore`。

## 3. 写一个外部适配器

适配器是一个可执行文件（带 shebang，`chmod +x`）。Orbit 以 `<adapter> <op>` 调用它，cwd 为 benchmark 目录，
stdin 是一个 JSON 请求，stdout 必须是一个 JSON 回复；出错时写 stderr 并以非 0 退出。每次调用 120 s 内结束，
不要在适配器里跑实验或打分——那是 solve / verify Run 的事。

| op | 请求中有 | 回复 |
| --- | --- | --- |
| `tasks` | `benchmark: {name, path, config}` | `{"tasks": [{"id", "title", "supported", "reason", "tags"}], "metrics"?: [...]}`；不能跑的任务 `supported: false` 并写原因；`metrics` 见下文 |
| `solve` | + `trial: {id, task, method, seed, options, timeoutMin?, resources?, staging, hostNetwork}` | `{"spec": <Run 描述>, "issues"?: []}` |
| `verify` | + `solve: {run, output}`（`output` 是 solve 的 `$ORBIT_OUTPUT` 宿主路径） | `{"spec": <Run 描述>, "issues"?: []}` |
| `score` | + `verify: {run, output}` | `{"score": 数或 null, "maxScore": 1, "invalid": false, "issues": [], "metrics"?: {"name": 数}}` |

Run 描述就是 `orbit run` 的 RunSpec 字段（`image` 或 `dockerfile`、`resources`、`mounts`、`env`、`network`、`workdir`、
`collect`、`timeoutMin`、`backend: "process"`、`cwd`……），另有两条规则：

- **Agent 交给 Orbit**：`trial.method.agent` 是 `codex` / `claude-code` 时，solve 给 `"agentTask": {"instruction": "..."}`
  而不是 `command`。Orbit 生成对应 CLI 命令并注入 auth、方法 bundle 和网络；适配器不要拼 `codex exec` 之类的参数。
  `oracle` / `empty` 给 `command`（没有参考解时对 oracle 报错即可，trial 会记为 invalid 并写明原因）。
  原生 runner 自己调用 Agent 时可以给 process `command`，Orbit 仍通过 Docker shim 注入 CLI、auth 和 bundle。
- **不要写 Orbit 管的字段**：`name group params project snapshot auth agentBundle agent parentId priority passEnv`。
  benchmark 的 `env` 会加到两个 Run，`--pass-env` 的密钥只给 verify Run。
- **外部 Agent 方法**：`agent: "external"` 必须给 `entrypoint`，可带 `model`、`effort`、非密钥 `config`、
  `passEnv: ["MODEL_KEY"]`，不接受 auth/bundle。适配器解释入口并给 `command`；Orbit 只把方法的 passEnv 注入 solve，
  不生成 CLI 命令。复杂配置用 `--methods-file` JSON 数组。内置 Harbor/ASI 不支持此方法时明确拒绝。
  GUI 评分需要活环境时，应在 runtime 中调用原版 grader 并保存结果，不能把离线证据检查描述为原环境重评。

约定：

- `trial.staging` 是 trial 私有目录，放要挂进 Run 的副本或可写工作区；trial 结束时删除，需要留下的文件用 `collect`
  采集到 solve 输出（`output/collected/<容器路径>`）。挂载点在宿主目录内的，先建好目录，避免 Docker 以 root 创建。
- `verify` 可能对同一个 solve 再调用一次（`orbit bench rescore`，例如修好评分脚本后）：只依赖 `solve.output`
  与 checkout，staging 里需要的东西每次重新准备，不要假设 solve 时写入的 staging 还在。
- benchmark checkout 只读：不要在里面写结果；Python 设 `PYTHONDONTWRITEBYTECODE=1`。
- 分数可信才算 `invalid: false`：评审 / scorer 内部出错、模型不可用导致的 0 分要标 `invalid` 并写 issue；
  "方法没有产出"是方法的结果，应是有效的 0 分。取消、超时、未启动由 Orbit 判定，不用处理。
- 原生 runner 自己起容器时用 `backend: "process"`，容器经过 PATH 中的 `docker`（Orbit shim）才会被标记、限 GPU 与清理。
- `trial.resources` 是提交 job 时解析的任务资源覆盖值（不是完整默认资源）；原生 runner 将其与适配器默认值合并，
  同时设置子容器限制。`trial.timeoutMin` 已按 CLI > 任务资源 > 默认资源解析，只控制 solve；verify 单独设预算。

调试循环：

```bash
orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py -c key=value --pass-env JUDGE_KEY
orbit bench tasks mine                                   # 调用 tasks；登记时已调用过一次
orbit bench run mine -t <task> -m empty -n smoke         # 走一遍 solve → verify → score
orbit bench show <job>                                   # issues 中有适配器的报错
orbit logs <solve 或 verify run>
```

也可以手工喂请求：`echo '{"protocol":1,"op":"tasks","benchmark":{"name":"x","path":"/p","config":{}}}' | ./adapter.py tasks`。
修改适配器后不需要重新登记（除非改了 `config`）。

### 在 trial 页展示什么（`review`，可选）

`score` 回复可以带 `review`，Orbit 存进 trial，Web trial 页按它生成标签：

```json
"review": {
  "files": [
    { "label": "Report", "phase": "solve", "kind": "markdown", "path": "collected/task/report/report.md" },
    { "label": "Test output", "phase": "verify", "kind": "text", "path": "collected/logs/verifier/test-stdout.txt" }
  ],
  "items": [{ "criterion": "…", "type": "image", "weight": 0.45, "score": 5, "maxScore": 100, "reasoning": "…" }],
  "details": { "scorer model": "gpt-5.1", "attempts": "13.95, 16.35" }
}
```

- `path` 相对对应 Run 的 `$ORBIT_OUTPUT`（即请求里的 `solve.output` / `verify.output`），不能以 `/` 开头或含 `..`。
- `kind` 只能选 `markdown`、`image`、`text`、`json`、`table`（CSV / TSV）。样式由 Orbit 决定，不要也不能传 HTML 或 CSS。
  将来新增的 kind，旧版 Orbit 会用 `fallback`（上述五种之一）、再按扩展名、再按纯文本显示，并标注“未知类型”。
- 其他字段不会丢：Details 标签按键值列出。文本过长会截断，条目数有上限（文件 20、items 500、details 50）。
- 不给 `review` 时，trial 页退回通用猜测（solve 中的 Markdown 报告、verify 中的 JSON），Outputs 标签始终可看全部文件。

### 指标（`metrics`，可选）

不声明时只有内置指标 `score`（`100 · score / maxScore`，%），这也是默认主指标。需要更多指标（通过率、成本、与论文的差距……）
时在 `tasks` 回复里声明，在 `score` 回复里给每个 trial 的值：

```json
"metrics": [
  { "name": "score", "label": "Score", "unit": "pts", "reference": 50, "description": "judge total (0-100)" },
  { "name": "matched", "label": "Matched paper", "unit": "%", "range": [0, 100], "primary": true },
  { "name": "judgeSpread", "label": "Judge spread", "unit": "pts", "higherIsBetter": false }
]
```

- `name` 是标识符（`[a-z][a-zA-Z0-9_]*`），唯一；至多 20 个、至多一个 `primary`（主指标：job 列表、CLI、排名默认显示它）。
- `unit` 只用于显示（`%`、`pts`、`$`、`s`……）；`range` 决定格子的热力颜色，`higherIsBetter` 决定颜色方向和“更好 / 更差”；
  `reference`（论文结果、人类基线）在统计卡片和排名条上画参考线。
- 同名声明 `score` 只能改它的标签、单位、说明、参考值和是否 primary，取值和范围固定。
- 所有指标都是均值：每个任务内先对 seed 取均值，再对任务取均值，± 是按任务聚类的 95% CI。比率指标（通过率）
  让每个 trial 报 0 或 100。只有 valid trial 进入均值；trial 没报某个指标时不计入该指标。
- trial 的指标值同时写进 verify Run 的 metrics（`bench/<name>`），Run 详情和 Run 对比可以看到。

内置适配器：harbor 主指标为 `resolved`（reward 为 1 的 trial 比例）并显示平均 Reward；asi 主指标为 `score`，另有 `fullMarks`。

## 4. 任务资源文件

不同任务需要的资源差别很大（有的要 GPU 训练，有的只做表格分析）。不要在适配器里硬编码，也不要每次让 Agent
临时估算：把每个任务的 solve 资源写进一个 JSON 文件，放在 benchmark 仓库里（如 `<benchmark>/orbit/resources.json`，
用 git 管理），登记时指定：

```bash
orbit bench add rcb /path/to/ResearchClawBench --adapter .../adapter.py --resources /path/to/ResearchClawBench/orbit/resources.json
```

```json
{
  "version": 1,
  "default": { "cpus": 4, "memGB": 16, "gpus": 0, "timeoutMin": 240 },
  "tasks": {
    "Material_002": {
      "gpus": 1, "gpuMemGB": 12, "memGB": 32, "timeoutMin": 360,
      "evidence": "3 次运行都在 CUDA 上训练 GNN；内存峰值 21 GB；最长 3.9 h",
      "confidence": "medium"
    }
  }
}
```

| 字段 | 含义 |
| --- | --- |
| `gpus` | GPU 数（整卡独占）。只有确实要在 GPU 上训练 / 推理、CPU 跑不完时才设 1 |
| `gpuMemGB` | 显卡至少要有的显存（按卡的总显存筛选，多种卡型时才有区别） |
| `memGB` | 内存，同时是容器的硬上限；超了会被 OOM 杀掉，宁多勿少 |
| `cpus` | CPU 核数；少了只会慢 |
| `timeoutMin` | solve 超时；`orbit bench run --timeout` 优先 |
| `evidence` / `confidence` / `note` | 给人看的依据，Orbit 忽略 |

- 只覆盖 solve Run；优先级：任务条目 > `default` > 适配器给的值。只写和默认不同的任务、不同的字段。
- 字段名写错、任务 id 不存在都会在登记 / 提交时报错。提交时解析结果存进 job（`orbit bench show` 的任务、Web 矩阵中
  任务名悬停可见），之后改文件只影响新 job，改完不用重新登记。
- Orbit 从不修改这个文件。

**用实测修正**：每个 Run 都会记录实测峰值（`orbit show` 的 `usage`，Web Run 详情的 Measured）。用真实 Agent 方法跑过
之后：

```bash
orbit bench usage <job>...            # 每个任务：峰值 / 申请、最长耗时、OOM、建议、说明
orbit bench usage <job>... --suggest  # 只输出建议改动，资源文件片段格式（带 evidence）
```

建议规则：内存 / 显存 = 峰值 × 1.2 向上取档，OOM 后至少升一档，至少两次运行且余量过半才建议调低；CPU 取峰值档位；
超时 = 最长耗时 × 1.5 取整小时。GPU 数量不给建议（这次没用 GPU 可能只是 Agent 没选择训练）。建议只打印，由人或
其 Agent 合并进资源文件。solve 因内存不足被杀的 trial 记为 invalid（不当作方法的 0 分），调大 `memGB` 后重跑这些任务。

## 5. 接入验收

每个新 benchmark（包括 Harbor 路线的新任务集）都要有这三项证据，写进任务记录：

1. **oracle 满分**：`-m oracle` 在抽样任务上全部 valid 且为满分（没有参考解的 benchmark 省略，并写明）。
2. **空答案零分**：`-m empty` 全部 valid 且为 0。invalid 说明适配器把"没有产出"当成了环境错误，要修。
3. **与原版一致**：对同一批产物运行原版打分（或用原版工具跑同一方法），逐任务比较；差异要能解释（随机性、版本），
   不能解释的视为适配器错误。评审为 LLM 时，同一份产物多次打分的波动本身就要先量出来。

然后再用真实 Agent 方法跑，`orbit bench compare <job...>` 或 Web `/bench/compare` 查看。
