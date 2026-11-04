# BrowserGym / MiniWoB

每个 trial 运行一个 BrowserGym episode，复用 Orbit 的 Run、资源租约、Trial 和产物页面。external/empty 在一个 CPU 容器中执行；CLI Agent 使用 main + 私有 gui 服务。
使用 `browsergym-miniwob==0.14.3` 和官方推荐的 MiniWoB commit
`7fd85d71a4b60325c6585396ec4f48377d049838`，不修改任务、视口或奖励函数。

支持 `browsergym-miniwob` 0.14.3 注册的全部 125 个 MiniWoB++ 任务（清单固定在 `miniwob_tasks.json`，由该版本的
`ALL_MINIWOB_TASKS` 生成，不是手写）；checkout 中存在但未注册的 HTML 显示为 unsupported。

需要已部署网站且共享后端状态的 BrowserGym 套件（WebArena、WebArena Verified、VisualWebArena、WorkArena、
AssistantBench）登记时用 `-c suite=<name>` 会被明确拒绝：任务之间会通过共享网站相互影响，而 Orbit 还没有共享后端的
独占调度（design §9.6 第 5 条）。不在改变条件的情况下运行它们。
方法支持 `external`、`empty` 和任意已注册的 CLI Agent（`cli` 能力声明）；没有参考 oracle。CLI 的可用性还取决于镜像的安装工具链、模型连接与 Agent 的图片读取能力。

## 准备与校准

宿主需要 Python 3、Git、Docker，以及支持 Ed25519 的 OpenSSL（CLI 证据签名使用；本次验证 OpenSSL 3）。BrowserGym、Chromium 及其依赖安装在镜像内。
使用包含 `external` Method 的新版 Orbit CLI/daemon；源码 checkout 可用 `pnpm orbit` 代替下文的 `orbit`，
已有旧 daemon 需要正常重启后使用新契约。
在 Orbit 仓库根目录运行；数据和结果放在源码仓库外：

```bash
ORBIT_GUI_ADAPTER="$(pwd)/examples/bench-adapters/browsergym"
ORBIT_MINIWOB_DIR=/path/to/new/miniwob-plusplus
git clone https://github.com/Farama-Foundation/miniwob-plusplus.git "$ORBIT_MINIWOB_DIR"
git -C "$ORBIT_MINIWOB_DIR" checkout --detach 7fd85d71a4b60325c6585396ec4f48377d049838
docker build -t orbit-browsergym:0.14.3 "$ORBIT_GUI_ADAPTER"

orbit bench add miniwob "$ORBIT_MINIWOB_DIR" \
  --adapter "$ORBIT_GUI_ADAPTER/adapter.py" \
  --resources "$ORBIT_GUI_ADAPTER/resources.json"
orbit bench tasks miniwob
orbit bench run miniwob -m empty -n gui-empty
```

默认是截图观察、坐标动作（`actionSet=coord`）、20 步、5 分钟、2 CPU / 4 GiB / 0 GPU。
`resources.json` 是初始预算，真实方法运行后可通过 `orbit bench usage` 调整。
任务数据通过只读 `file://` 加载；empty 和证据验证无需网络。
网络下载缓慢时，镜像构建可用 `--build-arg PIP_INDEX_URL=<公开镜像地址>`。

单独登记 accessibility/bid 条件，运行自带的 **脚本校准策略**。它只识别 click-test 的按钮，
不是通用 GUI Agent，也不冒充参考 oracle：

```bash
orbit bench add miniwob-calibration "$ORBIT_MINIWOB_DIR" \
  --adapter "$ORBIT_GUI_ADAPTER/adapter.py" \
  --resources "$ORBIT_GUI_ADAPTER/resources.json" \
  -c actionSet=bid -c agentDir="$ORBIT_GUI_ADAPTER"
orbit bench run miniwob-calibration -t miniwob.click-test -m empty \
  -m scripted=external,entrypoint=calibration_policy:make_agent -n gui-calibration
orbit bench show <job>
```

## 接入自己的 Agent

将 Python 模块放进一个独立目录，在登记时设置 `-c agentDir=/absolute/path/to/policy`；
它只读挂载到 `/agent` 并加入 `PYTHONPATH`。额外模型 SDK 通过派生镜像安装，登记时用 `-c image=<image>`。
也可以把模块直接安装进镜像，不设 `agentDir`。

方法文件是 JSON 数组；其中 `config` 和 `model` 随 job 保存，**不能放密钥**：

```json
[
  {
    "name": "vision-agent",
    "agent": "external",
    "entrypoint": "my_policy:make_agent",
    "model": "your-model",
    "config": { "temperature": "0" },
    "passEnv": ["MODEL_API_KEY"]
  }
]
```

`orbit bench run <benchmark> --methods-file /path/to/methods.json` 提交。
密钥必须在启动 Orbit daemon 时已存在于它的环境中；只给 solve Run，缺少声明变量时本适配器报 invalid。
benchmark 的 `--pass-env` 是 verifier 专用，不能代替方法的 `passEnv`。
已有 daemon 不会自动继承新终端里导出的变量；按正常流程重启后生效。

模块公开 `make_agent(context)`，返回有 `get_action(observation)` 的对象：

```python
def make_agent(context):
    # context: method (model/effort/config), seed, action_set, action_description
    return MyPolicy(context)

class MyPolicy:
    def __init__(self, context):
        self.context = context

    def get_action(self, observation):
        # Call your model with the observation and the supplied action description.
        # Return one BrowserGym action, e.g. "mouse_click(120, 90)" / "keyboard_type('text')".
        # Return None to stop; optionally implement close() to release model resources.
        raise NotImplementedError("Connect your policy here")
```

观察包含 `screenshot`（RGB NumPy 数组）、`goal`、`last_action`、`last_action_error`。
`actionSet=bid` 额外提供 `axtree_txt`，动作可用 `click('bid')` / `fill('bid', 'text')`。
两种观察条件要分开报告。策略只接收这些观察，不接收 environment、奖励或 grader info。
动作通过 BrowserGym `HighLevelActionSet(strict=True, multiaction=False)` 执行；不接收任意 Python 动作。
策略是可信研究代码，与环境在同一进程；这不是防恶意策略读取任务源码或改写评分的安全边界。

`model` / `effort` / `config` 的含义由策略负责，Orbit 不自动连接模型。
本阶段不支持 GPU 策略、桌面 VM、Android或浏览器状态恢复。CLI 桥使用独立环境服务，external Python 策略仍在同一进程。

## CLI Agent 与 orbit-computer

重新构建本文 Dockerfile 后登记镜像；旧镜像仍能运行 external/empty，但没有自动 MCP 配置入口。
镜像固定已验证的 `playwright==1.44.0`、`mcp==1.6.0` 与 `pydantic==2.10.6`；较新的 Pydantic 移除了该 MCP 版本使用的内部接口。

```bash
orbit bench run miniwob -t miniwob.click-test -t miniwob.click-button \
  -m assistant=claude-code,auth=<existing-profile> -n gui-cli
```

CLI 路径使用同一 BrowserGym 镜像：main 获得只读工具，`gui` 服务获得只读任务 HTML 与固定 plan。
服务只加入 Run 私有的 internal 网络；main 同时可访问模型网络。auth profile 必须使用容器网络，
`hostNetwork=true` 会被明确拒绝。若模型代理只监听宿主回环地址，应先准备可从容器访问的模型连接。
主容器预算来自任务资源；gui 另申请 2 CPU / 4 GiB，计入同一租约。

Agent 的固定说明要求先 `spec`，再 `observe` 读取由原版 reset 根据 seed 产生的 goal；不提前猜测或改写 goal。
动作完全沿用 `/spec` 中 BrowserGym 原版高层字符串。`coord` 只提供截图，`bid` 另提供 accessibility tree，
两种条件仍需分开登记和报告。

```bash
orbit-computer spec
orbit-computer observe
orbit-computer act "click('12')" --id action-1
orbit-computer finish
# MCP stdio，暴露 spec / observe / act / finish 四个工具
python /tools/orbit-computer.py mcp
```

观察和动作返回 Agent 可读取的本地截图文件。act 自动生成 id，也可显式指定；响应丢失后先 observe/status，
只可用原 id 重取同一个动作的结果。相同 id 携带不同动作会被拒绝，步数用尽/环境终止/finish 后不接受新动作。
镜像入口只在 CLI 环境中向 Codex/Claude 的 Run 专用 home 追加 `orbit-computer` MCP 配置，保留已有认证配置；
已有同名 MCP 配置不会被覆盖。其他 CLI 使用命令行工具。

评分证据只保存在 gui 服务中，Agent 无任务源码或服务证据挂载。Agent 退出后，现有 service hook 调用 finish，
再由 Orbit 收集到 `services/gui/evidence/`；取消时服务处理 SIGTERM 尽力完成同一收尾。
finish 与原来的主动停止一致：未结束时调用一次原版 noop 获得最终 reward，不授予额外步数。
服务硬崩溃、强制 SIGKILL 或不可中断的环境调用仍可能没有完整证据；证据缺失为 invalid，不能恢复原 episode。

每个 CLI trial 使用临时 Ed25519 密钥签署 `result.json` 及其中的证据哈希。私钥只在 gui 专用 staging 中，
不进入 Agent 挂载或产物；公钥保存在 daemon 的 solve Run 服务声明中。verify/score 只信该公钥，
缺失或错误签名固定为 invalid / scorer_error。即使 Agent 预建收集目录并伪造自洽哈希，也不能获得有效分数。
`bench rescore` 不需要已清理的 staging 或私钥。签名只保护本适配器的证据来源，未改变全局服务收集器。

## 评分与复盘

- 每步 `env.step()` 在浏览器仍存活时调用原版 MiniWoB validator；分数为 BrowserGym 的
  `float(RAW_REWARD_GLOBAL > 0)`，Orbit 按任务等权汇总成功率。
- 停止、步数耗尽、任务完成是正常 episode 结束；empty 做一次 noop 后停止，得到原版零奖励。
  external 策略明确抛出的模型异常、浏览器异常、缺失或不完整证据为 invalid；取消为 unknown。
  CLI 模型故障仍依赖 Orbit 核心识别：某些未识别的认证/连接失败可能留下完整的正常结束证据；不能仅凭没有动作把合法方法失败改判 invalid。
  外层 Run 超时若未留下完整终态证据，也记为 invalid，不从最后一张截图推断分数。
- solve 保存 `plan.json`、`result.json`、`trajectory.jsonl`、`trajectory-review.json`、`trajectory.md` 和 `screenshots/*.png`。
  Web Trial 的 Trajectory 支持步骤导航、动作前后画面、坐标/拖拽叠加、输入文本与动作错误；CLI 动作 id 可对齐同次调用的 Agent 会话。Markdown 保留用于旧版或降级查看。结构化视图与原始 JSONL 一起核验。
- verify 在独立、无网络的容器里检查记录完整性、奖励一致性、文件哈希及 CLI 服务签名；`bench rescore` 只重新检查这些保存的证据。
  **它不会重新运行原环境、回放动作或重新评分网页状态**。重新评估策略需要新 job。
- Web 的 **New evaluation** 可选择已登记环境与任务，配置 external/empty/已注册 CLI 方法并提交；`actionSet`、`maxSteps` 是只读环境预设。新 job 固定登记配置，复制新评测时提示当前登记的变化。见 [Web 指南](../../../docs/guides/gui-bench-web.md)。
- 固定依赖和任务版本写入 plan；Run 记录镜像 ID。保留自己的策略源码版本/镜像，避免运行期间修改挂载目录。

## 开发验证

```bash
python3 -B -m unittest discover -s examples/bench-adapters/browsergym
ORBIT_BROWSERGYM_E2E=1 ORBIT_MINIWOB_PATH="$ORBIT_MINIWOB_DIR" \
  pnpm --filter @zjunlp/orbit exec vitest run test/browsergym.docker.test.ts
ORBIT_BROWSERGYM_BRIDGE_E2E=1 ORBIT_MINIWOB_PATH="$ORBIT_MINIWOB_DIR" \
  pnpm --filter @zjunlp/orbit exec vitest run test/browsergym-bridge.docker.test.ts
# 使用现有 profile；也可用 ORBIT_BROWSERGYM_CLAUDE_SETTINGS 指向已有 Claude relay 设置。
ORBIT_BROWSERGYM_CLI_E2E=1 ORBIT_MINIWOB_PATH="$ORBIT_MINIWOB_DIR" \
  ORBIT_BROWSERGYM_AUTH_SOURCE=/path/to/existing/auth.json ORBIT_BROWSERGYM_AUTH_PROFILE=<name> \
  pnpm --filter @zjunlp/orbit exec vitest run test/browsergym-cli.docker.test.ts
pnpm verify
```

Python 单测使用明确的文件 fixture，不代表浏览器验证。
全量 empty 校准：125 个任务在临时 Orbit daemon 中全部得到有效 0 分（见 `docs/tasks/20261104-p3-browsergym-efe.md`）。
可选 Docker 测试通过临时 Orbit daemon 检查五个任务的 empty、click-test 脚本成功、
模型异常、凭据阶段隔离、截图、保存证据重查与取消后的清理。bridge 套件另查 MCP 四工具、幂等动作、补 finish 与伪造证据拒绝；两者不调用模型。CLI 套件使用真实模型运行五个任务，并在 staging 清理后重评。

上游：[BrowserGym MiniWoB](https://github.com/ServiceNow/BrowserGym/tree/main/browsergym/miniwob) ·
[固定 MiniWoB 源码](https://github.com/Farama-Foundation/miniwob-plusplus/tree/7fd85d71a4b60325c6585396ec4f48377d049838)。
