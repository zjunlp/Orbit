# BrowserGym / MiniWoB

第一阶段接入：一个 CPU Docker 容器运行一个 BrowserGym episode，复用 Orbit 的 Run、资源租约、Trial 和产物页面。
使用 `browsergym-miniwob==0.14.3` 和官方推荐的 MiniWoB commit
`7fd85d71a4b60325c6585396ec4f48377d049838`，不修改任务、视口或奖励函数。

支持 `miniwob.click-test`、`miniwob.click-test-2`、`miniwob.click-button`、`miniwob.enter-text`、
`miniwob.click-checkboxes`；其他 HTML 任务显示为 unsupported。这是接入与校准子集，不代表完整 MiniWoB 榜单成绩。
方法支持 `external` 和 `empty`；没有参考 oracle，不支持 Codex/Claude CLI 直接操作这个环境。

## 准备与校准

宿主只需 Python 3、Git 和 Docker。BrowserGym、Chromium 及其依赖安装在镜像内。
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
本阶段不支持 GPU 策略、桌面 VM、Android、浏览器状态恢复或跨进程策略 RPC。

## 评分与复盘

- 每步 `env.step()` 在浏览器仍存活时调用原版 MiniWoB validator；分数为 BrowserGym 的
  `float(RAW_REWARD_GLOBAL > 0)`，Orbit 按任务等权汇总成功率。
- 停止、步数耗尽、任务完成是正常 episode 结束；empty 做一次 noop 后停止，得到原版零奖励。
  策略/模型异常、浏览器异常、缺失或不完整证据为 invalid；取消为 unknown。
  外层 Run 超时若未留下完整终态证据，也记为 invalid，不从最后一张截图推断分数。
- solve 保存 `plan.json`、`result.json`、`trajectory.jsonl`、`trajectory.md` 和 `screenshots/*.png`。
  Web Trial 页面直接显示截图与动作；无需新的播放器。
- verify 在独立、无网络的容器里检查记录完整性、奖励一致性与文件哈希；`bench rescore` 只重新检查这些保存的证据。
  **它不会重新运行原环境、回放动作或重新评分网页状态**。重新评估策略需要新 job。
- 固定依赖和任务版本写入 plan；Run 记录镜像 ID。保留自己的策略源码版本/镜像，避免运行期间修改挂载目录。

## 开发验证

```bash
python3 -B -m unittest discover -s examples/bench-adapters/browsergym
ORBIT_BROWSERGYM_E2E=1 ORBIT_MINIWOB_PATH="$ORBIT_MINIWOB_DIR" \
  pnpm --filter @zjunlp/orbit exec vitest run test/browsergym.docker.test.ts
pnpm verify
```

Python 单测使用明确的文件 fixture，不代表浏览器验证。
可选 Docker 测试通过临时 Orbit daemon 检查五个任务的 empty、click-test 脚本成功、
模型异常、凭据阶段隔离、截图、保存证据重查与取消后的清理；不调用付费模型。

上游：[BrowserGym MiniWoB](https://github.com/ServiceNow/BrowserGym/tree/main/browsergym/miniwob) ·
[固定 MiniWoB 源码](https://github.com/Farama-Foundation/miniwob-plusplus/tree/7fd85d71a4b60325c6585396ec4f48377d049838)。
