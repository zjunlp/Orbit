# Orbit GUI / computer-use 类别接入报告

> 历史调研说明（2026-11-09）：本文的类别、编号与界面建议保留调研时点语义，不再定义当前产品分类。
> 公开分类采用 [design §9.17 六维 v1](../../design.md#917-benchmark-六维分类-v12026-11-09)，每个维度有独立受控取值；
> C1–C7 仅保留为历史接入原型或兼容信息。来源、原始观察及验证限制保持不变；当前状态见 [status](../../status.md)。

核查对象：`{orbit,BrowserGym,AgentLab,cua,cua-lite,OSWorld-V2,MobileWorld,gym-anything}`。核查方式：只读源码、配置、任务样例与版本信息；没有启动容器、VM、AVD，没有调用被测模型或 judge，没有重新执行校准。本文只创建本报告，不修改上述仓库。

**结论与建议：采用一个在线 GUI 交互大类 `gui-interaction`，配 browser / desktop / mobile 平台子配置；live-web 是叠加的环境可变性子配置。另将静态 GUI grounding 放入 `visual-grounding`，离线轨迹下一动作预测放入离线预测类。** 不按 BrowserGym、CUA-Lite、Cua Bench 等 harness 名字建大类，也不按网页、桌面、手机界面的外观划分执行协议。分类依据是“被测对象收到什么、何时返回什么、能改变什么状态、评分依赖什么”。此为本文设计建议，尚未实现。

这个建议的代码依据是：BrowserGym 有 `reset/step` 与任务 `validate`；OSWorld 是观测→动作循环后单独 `evaluate`；MobileWorld 是截图及工具结果→`JSONAction`→task scorer；CUA-Lite 已把不同平台接到同一种工具调用封装。静态 ScreenSpot-Pro 则只读取图片、判断点击是否落在标注框内，始终单步终止。这些是实质交互差异。[B-core]、[B-task]、[O-env]、[M-loop]、[L-base]、[G-screen]

**一、证据口径与版本**

正文的短引用都指向文末列出的本地文件与行号。`已核实`仅指静态代码路径已读，不代表真实部署可运行；仅在 README、设计文档、旧调研笔记中出现、没有沿代码验证的内容标为 **未核实**。`推断`是根据已引用代码作出的工程判断；所有端到端确定性、成绩对齐、账号可用性、性能数值在本次均为**未核实**。后文“建议”“应”“必须”均为拟议规范，不是现有功能声明。

只读 `git rev-parse HEAD` 的结果如下；行号针对这些 checkout 的当前文件。Orbit 读取时已有 1 条 `git status --porcelain` 记录，其余七个源码仓库状态为空；不把已有改动归为本次工作，也不把文档中的历史实验写成本次实测。

| 仓库 | 本次读取的 HEAD |
| --- | --- |
| [Orbit](orbit/.git/refs/heads/main:1) | `b52345c980d7d6b647308613c5f94dc539a04705` |
| [BrowserGym](BrowserGym/.git/refs/heads/main:1) | `27a90ce815098f43414e93491e06907af468e45b` |
| [AgentLab](AgentLab/.git/refs/heads/main:1) | `8488c564eea0525aaff5dea189bb03a9b529546e` |
| [cua](cua/.git/refs/heads/main:1) | `2829e00b180dfb08ca5ff4cbd7c95e0a14ad3409` |
| [cua-lite](cua-lite/.git/refs/heads/main:1) | `2af69268c0573f4c12aac391cc03125e6d5c7974` |
| [OSWorld-V2](OSWorld-V2/.git/refs/heads/main:1) | `d9953673daf55381237e058fd9388cc2d74c5538` |
| [MobileWorld](MobileWorld/.git/refs/heads/main:1) | `a026188705f4a494a12d14ddab3786a23fd2c537` |
| [gym-anything](gym-anything/.git/packed-refs:2) | `d444c61372f7858fe7d83e63a781cc86c4f4dfc0` |

Orbit 的 [AGENTS.md][R-rules] 要求 daemon 是唯一状态写者、执行/有效性/清理分离、清理确认后释放租约。现有代码确有三个独立 outcome 字段及封闭 failure 集合。[R-contract] 文档 §9 的“先接 hub”路线与用户本次要求不同：本文建议保留基础设施和原生语义，改为**每个 benchmark 直接登记在类别下**；L0/L1/L2 是实现接入的方式，不是 benchmark 类别。[R-design9]、[R-tiers]

旧调研笔记用于定位文件，未作为代码核实的替代：它们分别位于 [BrowserGym/AgentLab 笔记][N-browser]、[Cua 笔记][N-cua]、[OSWorld 笔记][N-os]、[MobileWorld 笔记][N-mobile]、[Gym-Anything 笔记][N-gym]、[CUA-Lite 笔记][N-lite]。例如当前 CUA-Lite 的 `BackendFamily` 是 `PURE/REMOTE/DEDICATED/SINGLETON`，并明确说明已经退休 server warm-pool task reuse；不能从 `EnvServerPoolable` 这个类名推导“当前存在通用暖池”。[L-services]

**二、benchmark / suite 清单与交互差异**

以下表格按具体 suite 列出。相同名字的不同包装路径在单元格内区分；“本地有适配代码”不等于本地拥有完整上游任务、数据和 scorer。表中的上限是**指定本地实现的默认/配置值**，不是统一官方预算。BrowserGym 的 benchmark 配置自己也注明 action set 默认值主要用于固定公平比较条件。[B-config]

记号：`S`=screenshot；`AX`=accessibility tree；`DOM`=页面结构；`SoM`=带标记截图及其 ID 映射。BrowserGym 公共观测含 S、DOM、AX、元素属性，但 agent 可只取其中一部分；AgentLab 的 SoM 是额外保存/预处理的视图，不能认为每个 benchmark 都原生给 SoM。[B-core]、[A-loop] `C`=CUA-Lite canonical nested tool calls，`function.arguments` 必须是对象，其 computer/mobile 参数语义与平台有关；不是任意 Python/adb shell 的同义词。[L-base]、[L-calls]

表中“可控”表示存在种子/重置/固定资产机制；**不表示已经证明确定性**。“漂移”是存在 live 服务、实时时钟或模型 judge 时的代码支持推断。

| Benchmark / 本地入口 | 平台、环境与 reset | 观测 → action | Episode 上限（本地路径） | Scoring 来源 | 网络 / 账号 | 确定性与证据边界 |
| --- | --- | --- | --- | --- | --- | --- |
| **MiniWoB++**；BrowserGym，另有 Cua / CUA-Lite 包装 | browser；Playwright + `MINIWOB_URL` 静态页面；加载任务后 `Math.seedrandom`、`core.startEpisodeReal()`，无需 VM。Docker 是可选承载层 | BrowserGym S/DOM/AX → `coord` 鼠标键盘或 `bid` 元素动作；Lite 改为 C | BrowserGym benchmark 配置默认 10 步；task 的 `episode_max_time` 默认 1,000,000 ms（1000s）；Orbit 包装另默认 20 步，须固定所用入口 | BrowserGym 读取页面 `WOB_RAW_REWARD_GLOBAL`，转成 `float(raw>0)`，另读 `DONE_GLOBAL` | 页面可本地托管；本地页面路径无任务账号登录；模型网络另计 | 初始化可播种，时间限制/浏览器事件仍影响结果；强确定性未核实。[B-mini]、[B-config]、[B-actions]、[R-bg] |
| **WebArena**；BrowserGym | browser；独立 browser context 连接一组网站后端；task setup 负责登录和导航，`teardown` 是空操作；完整后端 reset 在 benchmark preparation 的 `full_reset()`，未配置 reset URL 可跳过 | S/DOM/AX → BrowserGym 高层元素或坐标动作；最终 assistant 消息作为 STOP answer | BrowserGym 默认 30 步 | 调上游 `evaluator_router`，传页面与最终答案；本地 wrapper 对部分 `AssertionError` 转 0。上游全部 scorer 内部未核实 | 必须可达部署的网站，setup 使用网站账号；是否需要公网/外部 judge 取决具体任务和上游 scorer，全部依赖未核实 | browser reset 不覆盖共享 DB；共享状态可能污染并发/顺序。依据任务依赖图和 full reset 代码，不能承诺每任务独立。[B-wa]、[B-prep]、[A-deps] |
| **WebArena Verified**；BrowserGym | 与上述后端机制关联；有独立 task/evaluator 类型、任务 revision；不能用名字代替版本身份 | 同公共观测/action；可要求最终消息满足 answer schema | 30 步，hard 子集也是 30 | 独立 `WebArenaVerifiedEvaluator`；所有上游评分细则未核实 | 逐站登录；可配置额外 HTTP headers；准备路径调用 full reset | 保留与 WebArena 不同的任务/评分版本；是否与原版逐任务一致未核实。[B-wav]、[B-config]、[B-prep] |
| **VisualWebArena**；BrowserGym | browser + 网站后端；`require_reset` 时对 classifieds 发 reset 请求，另有全站 preparation reset；其他站点不能据此假定每任务已复位 | S/DOM/AX，任务目标还可含图片 → 高层/坐标动作 | 30 步 | 导入原生 evaluator 与 captioning function；caption 模型/权重是评分环境的一部分 | 网站、登录、classifieds reset token；具体图片/模型下载与运行网络必须逐任务核对 | 有局部 reset，不等于所有后端独立；视觉模型也进入复现指纹。[B-vwa]、[B-prep]、[B-config] |
| **WorkArena / WorkArena++ L1/L2/L3**；BrowserGym/AgentLab 入口 | browser；ServiceNow 平台来自仓库说明，**未核实**外部 `browsergym.workarena` 的 setup/teardown、服务部署和账号细节；本地 curriculum 代码确实调用该外部模块 | 公共 BrowserGym 观测与 `workarena` / `workarena++` action subsets；实际任务特例未核实 | 配置 L1=15，L2=50，L3=50 | 原生 task validation 的内部规则未核实，不能统称 LLM judge | 账号、实例复位/隔离要求未核实；直接接入前必须补齐依赖源码 | 本地存在接入入口而非完整实现证据。[B-config]、[B-work]、[B-readme] |
| **AssistantBench**；BrowserGym | browser / live web；每次从 `https://google.com` 开始；teardown 不复位互联网 | S/DOM/AX → 浏览器动作；`send_msg_to_user` 的最终答案 | 30 步 | `question_scorer` 解析 number / JSON / string / string-list，再选 evaluator；本地路径是答案评分，不能描述为仅看末帧的 VLM judge | 搜索/目标网站网络；代码此入口未提供统一网站登录流程，具体账号要求未核实 | 网站内容可漂移，gold 与评分代码可固定；测试集 gold 可用性需逐 split 核对。[B-ab]、[B-abscore]、[B-config] |
| **WebVoyager — live 路径**；Cua task adapter | browser / live web；bench-web 容器或 VM 中 Chromium；fresh sandbox + `POST /reset {url}` | 可见浏览器截图 → cua-driver 鼠标键盘；答案在 `session.final_answer` | Cua runner 可覆盖 max_steps，agent 默认各异，例如 CuaAgent 100、Gemini 50；此路径没有可据以声称的统一官方步数 | wrapper 调 WebVoyager judge helper；默认 `gpt-4.1`（环境变量可覆盖）、temperature=0、seed=42；取 agent 保存的截图加最终截图，至多 3 张 | guest egress + judge API key；网站账号规则未在此 adapter 统一实现 | 固定数据 commit/SHA 不冻结网站；judge 与截图选取也构成协议版本，官方逐项等价未核实。[C-wv]、[C-web]、[C-budgets]、[C-gemini]、[C-judge] |
| **WebHarbor-WebVoyager 镜像路径**；CUA-Lite | browser；共享服务容器内新建 Selenium session；说明与任务元数据标识 WebHarbor mirrors。**不得冒充上一行的 live 条件** | S，支持 coordinate / SoM 配置 → C 与扩展 browser tools | task metadata 的 `max_steps`，缺省 15；可覆盖 | `_evaluate` 调 VLM；无回答返回 `reward=None` / skipped；Orbit 当前明确把此情况转为 valid 0，属于已登记 deviation；无 SUCCESS/NOT SUCCESS 的 malformed verdict 在原 wrapper 也被转成 0 | 镜像网站服务与 judge 网络；镜像全部资产/部署可用性未核实 | 网页镜像降低部分漂移（推断），不消除模型 judge 波动；作为具名镜像 benchmark 或显式 deviation 登记。[L-wv]、[L-wvscore]、[L-wvserver]、[R-lite-score]、[R-lite] |
| **Online-Mind2Web**；Cua / CUA-Lite | browser / live web；Lite `new_context` + 页面 goto，Cua fresh sandbox；只能复位客户端 | S → 坐标/C；答案、action history、截图给 evaluator | Lite 默认 30；Cua 用选定 agent budget；server 单独的回退值不能当评测配置 | WebJudge：关键点、逐图证据、最终 verdict；两条包装有 `o4-mini` 默认路径，Cua 支持环境变量覆盖；Lite 明确传播逐图 judge 调用错误 | live egress + judge key；Cua 数据下载标注 gated HF，运行时授权可用性未核实；网站账号逐任务未核实 | 固定 dataset revision 不冻结网页；Cua 共享 LiveWebAdapter 只取最后至多 3 图，不能未经对齐就称与原生完整轨迹评价相同。[C-om]、[C-web]、[C-judge]、[L-om]、[L-omserver] |
| **WebGym**；Cua / CUA-Lite | browser / web；Lite 是 OmniBoxes HTTP client，服务容器内 Redis/master/node/Chromium pool；是否全量网站为 live/镜像、状态隔离边界未核实 | Lite S → 坐标 C，goto/back 为显式 opt-in | Lite difficulty 1–3:15、4–6:25、7–8:35 | 本地 evaluator patch 使用 OpenAI judge，最终 reward 要求 criterion B 且全部 criterion A；含 fallback 路径须保留日志 | judge 网络；网站、登录需求随 task，未全量核实 | 共享浏览器池不等于共享网站后端可并行；reset 范围与原生全量对齐未核实。[L-webgym]、[L-webgymcfg]、[L-webjudge] |

| Benchmark / 本地入口 | 平台、环境与 reset | 观测 → action | Episode 上限（本地路径） | Scoring 来源 | 网络 / 账号 | 确定性与证据边界 |
| --- | --- | --- | --- | --- | --- | --- |
| **OSWorld / OSWorld-Verified**；AgentLab、Cua、CUA-Lite | desktop；AgentLab 导入外部 DesktopEnv；Lite `osworld` 用 Ubuntu qcow2 VM-in-Docker；Cua Verified 同时提供 VM 与 container 变体，明确标记 systemd/音频等任务的容器保真度降级 | AgentLab S/AX → computer actions 或 pyautogui；其 SoM helper 调用被注释，不能视为默认可用；Cua 默认 cua-driver，native mode 才走 server `/execute` | Lite `osworld`=30；其 `lite.osworld` 容器路径=15；AgentLab 默认 50、Cua 由选定 agent/实验配置决定 | 原生任务 evaluator；Cua proxy 对接上游 DesktopEnv；本次未核实所有 OSWorld 原版任务评分器 | 资产下载；Cua 注明 GDrive OAuth 任务、部分 guest egress，但全部任务依赖未核实 | VM、容器、任务版本/Verified split 不可混合；Cua 的容器“full/degraded”是代码启发式标记，不是本次性能等价实测。[A-os]、[C-os]、[L-oscfg]、[L-liteoscfg] |
| **OSWorld-V2 / 本地 V2.1 release** | desktop；DesktopEnv provider，可用 Docker 承载 qcow2 VM；setup 前标脏。Docker `save_state` 不支持、`revert_to_snapshot` 只 stop，后续重新创建容器并只读挂基盘；其他 provider 不可据此一概而论 | S、可选 AX/terminal；action 为 `computer_13` 或 Python command（pyautogui / Claude / Gemini 模式） | 原生 Claude Python runner 默认 15；Lite osworld_2 配置 200 且说明对应 V2.0 路径；**不能把 200 写成 V2.1 固有上限** | 原生 `BaseTask.evaluate` 或 getter+metric；可返回 scalar/dict，runner 保存 result.txt/result.json；step 中 reward 初始为 0，不能累加它代替最终分数 | 资产/任务数据与网站；本地 release manifest 固定 code/tasks/assets/web/image。是否本机获得 gated 资源、所有任务 judge/login 需求未核实 | snapshot 支持依 provider；reset 的 `seed` 参数不是任务已播种的证明；Orbit adapter 明确 seed 只作身份记录。[O-env]、[O-docker]、[O-loop]、[O-cli]、[O-release]、[L-os2cfg]、[R-os] |
| **Windows Agent Arena (WAA)**；Cua / CUA-Lite | Windows desktop；Lite 本地 QEMU/KVM、只读基盘+每次新 overlay；ready snapshot 匹配时恢复，否则 cold boot；再调用 `/reset` 设置 task | Lite S → computer C；bridge 接 WAA evaluator；原生全部 AX/SoM 选择未核实 | Lite 默认 15 | `/evaluate` 返回原生 reward；Cua 本地含 evaluator/getters/metrics 的适配实现 | Windows image/ISO/任务资产；各任务网站账号未全量核实 | snapshot 与基盘匹配受检；Lite 还屏蔽某些 empty 即满分的 variant，所以是筛选协议，不等于未经筛选的全部 WAA。[L-waa]、[L-waaqemu]、[L-waacfg]、[C-waa] |
| **AndroidWorld**；CUA-Lite | mobile；AVD/emulator-in-container，KVM；task initialize/tear_down；支持快照复位，但配置 `max_resets_per_container=0` 默认每次重建容器 | 默认 S/任务文字 → mobile C，翻译成 AndroidWorld JSONAction；可显式启用 `a11y:pixel/norm` 观测文字；swipe/system button 的部分路径直走 adb | 未覆盖时 `int(10 * task.complexity)`；eval 注册固定 seed 派生任务参数 | 原生 `is_successful()`；wrapper 只在 agent 终止时采纳分数，步数截断强制 0，evaluator 抛异常也 catch 后记 0；上游各 task scorer 内部未核实 | 本地模拟器/应用；初装资产、模型服务网络另计；逐任务账号需求未核实 | task 参数可播种；快照之外的进程/adb 状态是另一个复位层；实际重放确定性未核实。[L-aw]、[L-awstep]、[L-awcfg] |
| **AndroidLab**；CUA-Lite | mobile；Docker 中 AVD，Quick Boot `default_boot`；可 reload snapshot，默认 K=0 每次重建；每次 root/clock/GPS setup，重新实例化 judge | 默认 S → mobile C → adb；可配置 a11y tree/list 文字；compressed XML 同时是 judge 输入，纯视觉条件不能默认将其发给 agent | wrapper 默认 25，可按 eval config 覆盖 | 原生 task/judge 的 `judge(compressed_xml,line)`，取 `complete` 为 1/0；**judge 这个名字不证明是 LLM** | 包装说明为离线 apps，但全量上游实现与账号要求未核实；安装资产、agent 网络另计 | 快照+固定设备配置提高可控性（推断）；judge 状态按 episode 重新创建。[L-al]、[L-alserver]、[L-alcfg] |
| **MobileWorld**；原生仓库及两种 Orbit/Lite 包装 | mobile；Android emulator + 应用后端；`BaseTask.initialize_task` 恢复 `init_state`、刷新 task 状态/日期、清理后端再运行 task hook | 原生 agent 收 screenshot、tool_call、ask_user_response → JSONAction；部分任务允许 MCP 或用户交互，不是纯 tap/swipe | 原生 CLI 接受 `--max-round`，本地参数声明未给固定 default；Lite=50。实际预算须读取生效配置，不能引用 README 命令当强制上限 | `is_successful` 的设备/DB/文件检查；例：alarm 走 adb、发邮件检查后端。还存在模型化 user simulator；不能把 user simulator 和 scorer 混为一项 | self-hosted 应用后端；Chrome/Maps 等含 live/time 依赖；用户模拟器 key、任务工具账号单独列出 | 三层复位：设备、后端、Python task 对象。Lite 不注册 agent-mcp，user-interaction 另打排除标记；Orbit 当前也不支持 user/MCP/live web/map，故“有原始目录”不等于全量支持。[M-task]、[M-loop]、[M-score1]、[M-score2]、[M-cli]、[L-mw]、[L-mwcfg]、[R-mobile] |
| **MobileGym**；CUA-Lite | mobile 外观、**browser-based Android-like simulator**；共享 container 内 browser pool/Vite UI；不是 AVD | S/文字 → mobile C；text/grounded 模式不同，含回答路径 | task manifest 或 difficulty；grounded 模式额外 +15，覆盖值也经过该模式规则 | container 内 setup/step/evaluate，描述为 state-diff judge；各个上游判分函数未核实 | 本地模拟 apps；不据此断言全部任务不需网络/账号，未核实 | 代码可见 seed/任务元数据入口；全量确定性仍未核实。应按 simulator 的真实隔离能力登记资源。[L-mgym] |
| **Cua tasks: basic** | desktop 承载的网页小组件；本地 `Task` variants + bench-web image；setup hook，fresh sandbox | DesktopSession screenshot → 鼠标键盘/driver；自定义 agent 可以有额外权限，必须声明 | Cua agent/runner 配置；Lite 包装默认 30 | 例 click-button：读取 page 的 submitted 状态，返回列表 reward；有 solve hook 作 oracle | 示例用本地组件，没有外站登录；其他 task 逐项核对 | variant 是样本维度；Python/NumPy seed 不能替代 variant。registry 固定 taskset commit，仍需固定 image。[C-reg]、[C-basic]、[C-episode]、[L-cuacfg] |
| **Cua tasks: kicad** | desktop 应用；独立 registry taskset，setup/solve/evaluate hooks | DesktopSession GUI；具体任务权限/观测特例未全量核实 | Lite 包装默认 200；Cua 本身为选定 agent budget | 应用产物/task evaluate；全套 netlist/评分代码未逐项核实；Orbit adapter 明确 KiCad 校准不足 | 应用/依赖与 task 资产；登录/网络逐任务未核实 | 不能用 basic 的校准覆盖 KiCad。[C-reg]、[L-cuacfg]、[R-cua] |
| **Cua tasks: workflows** | desktop 多应用流程；独立 registry taskset | DesktopSession GUI；具体工作流未逐项核实 | Lite 包装默认 100；原生 agent 可覆盖 | task evaluate，不能统一假定 binary 或某种 judge；全套评分器未核实 | 应用/资产/外部服务依任务，未全量核实 | taskset、variant、应用版本是身份的一部分。[C-reg]、[C-episode]、[L-cuacfg] |
| **CUAWorld（gym-anything 所带任务集合）** | desktop/mobile 等按 `EnvSpec` 与 runner；本地有 Docker、QEMU、AVD 等 runner 选择。reset hooks，可用 pre_start/post_start/post_task 缓存；QEMU savevm 能力按 runner 判断 | 主要 screen 观测 → mouse/keyboard 等结构化动作；也有 CLI gateway；并非所有任务只准 GUI | 例 basic_formulas 声明 10 步/120s；`run_single` 实际步数取 CLI > task > 50，且强制 `timeout_sec=86400`，故该入口并不执行 task 的 120s | program / image_match / multi / vlm_checklist；program 本身也可调用 VLM。`reward_type` 为 sparse→0/1，partial/rubric→0–100，continuous→0–1，dense→当前 shaping reward | EnvSpec 网络 + task 依赖；VLM verifier 需模型服务；全部环境账号/许可需求未核实 | 缓存层级决定哪些 setup 被跳过，post_task 必须绑定任务；固定 runner/spec/score mode，不能统一按 reward≥1 判断通过。[Y-env]、[Y-score]、[Y-runners]、[Y-single]、[Y-example] |

还有以下仓库中可见的入口，必须保留在盘点中，但不能据“被 import/在 README 出现”写成完整实现已核实：

| 套件/入口 | 平台、环境/reset、观测/action、限额、评分与依赖的核实结果 | 类别处理建议 |
| --- | --- | --- |
| **WebLINX** | BrowserGym README 标明 static；默认配置 `max_steps=1`、动作 subset `weblinx`；数据载入、reset、完整评分实现与运行网络/账号**未核实**。[B-readme]、[B-config] | 离线轨迹/动作预测，不能当在线 browser rollout 计入覆盖 |
| **OpenApps** | README 有外部 `OpenAppsLauncher` 入口；实际环境、reset、AX/DOM/SoM、动作、评分、预算、账号全部**未核实**。[B-readme] | 待查外部源码后再登记具体 benchmark |
| **TimeWarp** | 有默认 benchmark、30 步/action subset；外部任务实现的环境、reset、评分、网络和确定性**未核实**。[B-config] | 不能仅凭名称判断是 live web 还是固定环境 |
| **KNOWS** | 有默认 benchmark、120 步；action subset 明确 Google Workspace canvas 需要鼠标/插入文本；README 声称 Google account + Cloud service account，账号要求属于文档信息，**未核实**外部代码。[B-config]、[B-actions]、[B-readme] | 候选 browser+remote/account 配置，实际 reset/scorer 未核实 |
| **OSWorld-G** | CUA-Lite 本地实现：静态截图+指令，一次坐标预测对 bbox/polygon，refusal 任务用 `report_infeasible`；无需运行 desktop VM；素材获取后评分不依赖 live 站点，端到端数据可用性未核实。[G-os] | `visual-grounding`；refusal 和 grounding 子集分开报，不能冒充 OSWorld 完整任务 |
| **ScreenSpot-Pro** | CUA-Lite 本地实现：读图片，一步 click，像素 bbox 映射后判框内；可选 distance reward shaping；`terminated=True`；下载后的静态评分无任务账号。[G-screen] | `visual-grounding`，binary 与 shaping 是不同评分配置 |
| **CUA-Lite 的 lite.osworld / lite.scalecua / lite.cuagym / lite.cuaworld、captcha、demo** | 仓库另有这些注册/实现目录；例如 lite.osworld 与 VM osworld 的默认预算不同。其全部任务、生成/训练 split、评分和原版等价**未核实**；不能把训练任务或 demo 自动计为独立评测 benchmark。[L-doc]、[L-liteoscfg] | 对明确具有独立任务与评分协议的集合单独登记；训练集、sandbox、example 分别标注用途 |
| **Cua sandbox / open-ended** | 文档描述 `reward=None`，并有独立 sandbox 实现；未核实所有 runtime。[L-doc] | 交互环境，不凭一次工具调用产生 benchmark 分数 |
| **GAIA（AgentLab）** | 本地 `benchmarks/gaia.py` 存在；完整多工具实现本次未核实，不将其全体列为 GUI benchmark。[A-gaia] | 若子任务允许 browser，只是其工具配置，仍需按完整被测契约分类 |

**三、被测对象与 harness 如何驱动它**

“VLM model”“带记忆/prompt/parser 的 VLM agent”“可执行 policy 服务”“CLI Agent”不是同一层级。建议 Method 身份固定模型、prompt、图像预处理、历史截断、parser、重试与工具权限。只写模型名会把 harness 差异藏进分数。此建议来自下列不同驱动路径，而不是假设存在一种通用官方 agent。

| Harness / 路径 | 被测对象的实际接口与循环归属 | 对 Orbit 的含义 |
| --- | --- | --- |
| BrowserGym + AgentLab | `StepInfo.from_reset` 调 `env.reset(seed)`；`agent.get_action(obs.copy())` 返回 action/agent_info；随后 `env.step`。`ExpArgs` 内循环，保存 step pickle、截图及可选 SoM；reward/terminated/truncated 来自环境。[A-loop] | 可以用原生 AgentLab agent 或外部实现该接口的 agent；导入一个受固定预算控制的 episode，不把 AgentLab Study 的第二套全局队列当 Orbit 状态源 |
| CUA-Lite | `agent.sample(env)` 负责 reset、预测、转换 tool calls、env.step、累加 episode_return 和终止；直接 env 和 remote client 都实现 LiteBaseEnv。[L-loop]、[L-base] | 外部 policy 可直接驱动 reset/step，也可用现有 agent.sample；必须保留 action batch 与预算口径。`external` 在 Orbit 中不自动等于已实现通用 GPU `policy` 服务 |
| Cua Bench 普通 agent | `run_episode` 执行 setup，调用 `agent.perform_task(description,session,logging_dir,tracer)`；agent 自己跑模型/工具循环；再调用独立 evaluate hook。`success` 与 `reward` 是不同字段。[C-episode] | 同一 benchmark 可以比较不同 agent 实现，但要固定 DesktopSession 允许的操作面；保存 task 原始评价，不能把 AgentResult 的“成功执行”当任务通过 |
| Cua Bench `--agent harness` | `HarnessAgent` 经 sandbox agents API 运行 Claude Code/Codex 等 CLI，CLI 在任务 sandbox 内，获得它的 MCP 工具；还有独立 turn timeout。[C-harness] | 这是已有 CLI 路径，但它与普通 host-side agent 的权限边界不同；尤其不能自动声称 task sandbox 里的评分证据对该 CLI 防篡改 |
| OSWorld-V2 | 原生 `run_single_example` 调 `agent.predict(instruction,obs)`，执行返回动作，保存截图/`traj.jsonl`，最终 `env.evaluate`；还存在多阶段任务分支。[O-loop] | 只包一 episode；Python/pyautogui 能力作为显式 action profile。Orbit 当前 adapter 只接单阶段任务，不代表 native 多阶段全部已支持。[R-osrun] |
| [MobileWorld](MobileWorld/.git/refs/heads/main:1) | `BaseAgent.initialize` / `predict(observation)` / `done`；runner 输入截图、tool/user response；执行 JSONAction 或 MCP tool，结束后 get_task_score/tear_down。[M-agent]、[M-loop] | GUI-only、ask-user、MCP-assisted 必须分协议条件；环境中的用户模型要独立登记与计费，不是被测 agent 本身 |
| gym-anything | 常规 agent `init` / `step(obs,action_outputs)` 返回 action groups；run_single 调 env.step。CLI autonomous agent 则自己通过 HTTP action gateway 驱动环境，host 外层 step loop 迭代零次；截图请求不消耗 action budget。[Y-agent]、[Y-single]、[Y-cli] | 两者可归在线 GUI，但 method transport/权限/预算计数必须明确；不需为 CLI 再造一个不同 GUI 大类 |
| Orbit `orbit-computer` bridge | CLI Agent 在 main，GUI 环境在 service；MCP/CLI 接 `/spec /observe /act /finish`；service 控制预算、执行、action-id 去重、证据采集；目前 backend action 仍是字符串，BrowserGym 高层语言与 Lite JSON 透传各自保留。[R-bridge]、[R-wire] | 此为类别共享桥的起点；尚不是覆盖所有 GUI benchmark 的统一 canonical schema，也不应把所有外部 runner 的证据说成都已签名 |

**按被测对象而非领域分类的边界**：CLI Agent 只是通过工具逐步点击、读取下一屏，仍是 GUI 交互；若任务要求它提交一段程序，再由隔离 evaluator 运行程序，那是“程序产物→执行/验证”的契约。用户给定的 EFE 对比应遵循同一规则：EFE coding-agent 路径不能与原生机器人 observation→action policy 混类。Orbit §9 确实区分了这两者，但 EFE 各上游任务源码不在本次 GUI 核查范围，35 套件等规模在本文**未核实**，不作为本报告独立发现。[R-design9]

**四、现有 Orbit 接入能证明什么**

| 现有代码/记录 | 已核实代码行为 | 本次不能据此宣称的能力 |
| --- | --- | --- |
| BrowserGym adapter | catalog 是 MiniWoB；methods 为 external/empty/cli，CLI requires gui；明确拒绝通用 oracle / GPU policy；`coord` 与 `bid` 为条件。[R-bg] | BrowserGym 所有 WebArena/WorkArena 套件都已被 Orbit 接入 |
| CUA-Lite adapter | 只有 MiniWoB 与显式 reviewed web episodes；CLI_TASKS 是 6 项名单；WebVoyager / Online-Mind2Web CLI 明确拒绝；web terminal judge 延迟到 after，judge key 不给 policy。[R-lite]、[R-judge] | 一次接 hub 就得到全部桌面/移动/live-web 套件；有 wrapper 即等价原生官方 |
| Cua Bench adapter | methods external/empty/oracle；basic 等任务枚举；KiCad 等不满足条件时列 unsupported；读取原始 reward/ATIF。[R-cua] | Cua 所有 taskset、所有 OS/runtime 都已经校准 |
| MobileWorld adapter | 原 catalog 类保留但 user/MCP/live web/map 等标 unsupported；process backend 调一项 `mw eval`，限制内部重试，跟踪设备容器；seed 只作 trial 身份。[R-mobile]、[R-mobilerun] | 完整 MobileWorld 或原生 seed 控制已完成；已有统一 CLI bridge |
| OSWorld-V2 adapter | release/task hash 校验；external/empty；single native episode；拦截 evaluator 吞异常产生的结果；process backend 的 VM 容器有所有权检查。[R-os]、[R-osrun] | 多阶段、所有外部网站/judge 条件已支持；KVM 真实校准通过 |
| catalog 的校准列 | 文档记载 BrowserGym MiniWoB empty、部分 Claude，以及 Cua basic 的 empty/oracle；MobileWorld/OSWorld 标记 KVM 校准未运行。[R-catalog] | 本次没有重跑，所有历史校准事实均属**未核实（文档记录，非本次实测）**；也不等于官方成绩对齐 |

现有共享服务有值得保留的证据基础，也有清晰边界：

- `adapter.py` 实际在 host staging 生成 Ed25519 私钥，只有 service 挂载 staging；main 只挂工具脚本。不是“私钥由 service 内部生成”。公钥保存在 solve Run 的 service env，核验从该可信记录读取，不能接受 agent 随证据提交的新公钥。[R-wire]
- service 写初始帧和动作后帧、原始 action/reward/flags、`trajectory.jsonl`，hash 覆盖 plan、轨迹、review 和全部截图；签名覆盖含这些 hash 的 result.json。是**签名清单绑定截图/动作**，不是每张截图独立签名，也不是现有逐事件 hash chain。[R-bridge]、[R-evidence]
- `/act` 的同 ID 同 action 返回缓存、同 ID 不同 action 为 409；缓存位于 `Bridge.calls` 内存。**未核实/不可声称跨 service 重启的 exactly-once**；连接断开后在同一活进程中重发可复用缓存。[R-bridge]
- `evidence.validate` 明确只验证保存的 live reward；不是重放浏览器，也不是重新执行原始 scorer。其格式目前限制 BrowserGym/Lite MiniWoB 与 binary reward，不能直接覆盖任意 GUI 评分尺度。[R-evidence]
- Native MobileWorld/OSWorld 等 runtime 在自身进程产出结果/hash；不能由这些 hash 推导与受测进程隔离的 producer authenticity。需要明确 threat model 或迁入可信 service；此为基于文件写入路径的推断。[R-osrun]、[R-mobilerun]

**五、拟议类别规范：`gui-interaction/1`**

以下全部为**设计建议，未实现**；应在现有 Run、adapter、resource lease、records、review 机制上实现，不新增全局调度器或 daemon 内的模型推理循环。现有 adapter 协议已有 `tasks/solve/verify/score`、review、capabilities；当前 `policy` 只是保留名，不能把拟议 external policy 支持写成已可运行。[R-adapter]、[R-method]

**5.1 类别边界与直接接入单位**

类别定义：被测主体在一项有目标、有限预算的交互 episode 中，反复接受环境给出的可见观测，提交 GUI 动作或终止/答案；环境状态变化与成功判定由可信 provider/verifier 负责。任务可需要答案，也可只检查最终状态；这不改变在线交互类别。截图上预测一个点、但从未执行动作和产生下一状态的任务归 grounding。

| 维度 | 必填取值/规则（建议） | 原因与代码依据 |
| --- | --- | --- |
| `category` | `gui-interaction` | BrowserGym、OSWorld、MobileWorld 都是闭环控制，差别可由以下维度表达。[B-core]、[O-loop]、[M-loop] |
| `platform` | `browser / desktop / mobile`，可有声明的多 surface | 区分窗口、浏览器 tab、Android system button 等能力；不能把 MobileGym 自动映射为 KVM。[L-doc]、[L-mgym] |
| `world_mode` | `fixture / mirrored-web / live-web / mixed` | WebVoyager 两路径、AssistantBench 搜索、MobileWorld live Maps 等必须区别。[C-wv]、[L-wv]、[B-ab]、[M-task] |
| `interaction_profile` | `visual-coordinate / element-tree / native-code / assisted-tools`；允许组合但需新指纹 | AX/DOM 元素 ID 和原生 Python 可执行能力影响可见信息与可行动作；不能只归一化坐标后当公平等价。[B-actions]、[O-env]、[M-loop] |
| `method_transport` | `native-agent / external-policy / cli-tool-bridge` | 是如何驱动被测主体，不是不同 benchmark 类别。[A-loop]、[L-loop]、[R-bridge] |
| `environment_components[]` | 每个组件独立说明 dedicated/pooled/singleton/remote、状态范围与重置方法 | 一个 browser 可以独占，但连接共享 DB；一台手机快照之外还有应用后端。[B-prep]、[M-task] |
| `scoring` | 原生 scorer 的入口、版本、输入证据、range、primary metric、judge 依赖 | OSWorld 最终 evaluator 与 step reward 不同；Gym-Anything reward 尺度也不统一。[O-env]、[Y-env] |

**不建议把 browser/desktop/mobile/live-web 切成四个并列大类。** 平台只是同一 GUI 动作/观测契约的扩展；live-web 与平台正交，desktop 浏览器、mobile Maps 都可访问 live 服务。真正需要隔离的是权限、环境所有权、reset/scoring/网络条件。单一类别必须强制校验这些子配置，不能变成不加约束的万能 `native` wrapper。

每条 catalog 应直接指向 benchmark 的任务来源与 scorer。例如 `webarena@revision`、`visualwebarena@revision`、`osworld-verified@revision`、`osworld-v2.1`、`mobileworld@revision`、`cua-bench-basic@revision`、`cuaworld@revision`。BrowserGym/AgentLab 可以作为实现依赖：调用其 Playwright 环境/日志库，不必先把任务转换为“CUA-Lite task”，也不通过 `cua → browsergym → upstream` 的嵌套身份给它计数。若实际选择 WebHarbor 镜像、Cua OSWorld 容器降级版，必须把该包装协议作为独立 benchmark/revision 或具名 deviation；禁止沿用未改动原版的成绩标签。[C-os]、[C-wv]、[L-wv]

直接接入允许的 benchmark 专用代码仅负责：枚举原 task、task 初始化、原生动作 lowering、收集官方 scorer 所需状态、调用原生 scorer、解析官方指标、声明校准样例。共享类别库负责运行边界、操作预算、证据、签名、资源和失败映射。无法无损映射的能力应在 admission 阶段拒绝，不静默删任务工具、扩大网络或改 evaluator。

**5.2 被测主体输入与输出**

启动时向 subject 提供固定的 `TaskSpec`、`CapabilitySpec`、初始 `Observation`。subject 不接触 scorer 源码/答案/数据库管理接口，除非原 benchmark 的公开协议明确允许；允许则进入 `native-code` 或相应高权限 profile。环境/评分所需凭据与 subject 模型凭据分开。

建议的 canonical 表层（不是替换所有原生协议的新网络服务器）：

```json
{
  "protocol": "gui-interaction/1",
  "episode_id": "opaque",
  "observation_id": "obs-0007",
  "sequence": 7,
  "task": {"id": "upstream-id", "instruction": "..."},
  "surfaces": [{
    "id": "screen-0", "kind": "browser",
    "image": {"ref": "media/0007.png", "sha256": "...", "width": 1280, "height": 720},
    "coordinate_space": "norm1000",
    "transform": {"source_width": 1280, "source_height": 720, "crop": null, "rotation": 0}
  }],
  "accessibility": null,
  "dom": null,
  "element_map": null,
  "feedback": [{"action_id": "a-0006", "status": "executed", "error": null}],
  "budget": {"decisions_remaining": 23, "native_steps_remaining": 23},
  "episode": {"terminated": false, "truncated": false}
}
```

媒体路径对 subject 应解析为受控读取能力/图片字节，对 archive 则为相对路径；不能把 host 文件路径暴露为可任意读取的工具。`task` 可只在初始帧给出；隐含任务/分阶段目标按原生协议显式记录。AX/DOM/SoM 缺失写 null，并用 capabilities 说明是禁止、后端不支持、还是提取失败；不能把提取失败当“页面无元素”。

subject 返回一组 canonical tool calls 或 `finish`，推荐沿用 CUA-Lite 已有 nested function-call 外形与 computer/mobile 名称，其 `arguments` 是对象而非 JSON 字符串。[L-calls] Orbit 增加 episode、observation 与 action ID 的关联封装；下面 `actions` 批处理 payload 是拟议例子，不声称已经符合所有现有 backend schema：

```json
{
  "episode_id": "opaque",
  "based_on_observation": "obs-0007",
  "action_id": "a-0007",
  "calls": [{
    "id": "tool-0007",
    "type": "function",
    "function": {
      "name": "computer",
      "arguments": {"actions": [{"action": "click", "coordinate": [500, 300]}]}
    }
  }]
}
```

具体 action 子配置：

| 动作族 | 规范（建议） |
| --- | --- |
| computer 基础 | click（button/count）、mouse_move、drag（点列/时长）、scroll（方向/量/目标）、key（规范 key chord）、type（Unicode）、wait、screenshot；只广告后端真正支持的操作 |
| mobile 扩展 | tap、long_press、swipe（起终点/时长）、system_button、open_app；app 枚举来自任务允许集；adb 是后端 lowering，不自动赋予 subject 任意 `adb shell` |
| browser 扩展 | goto/back/forward/tab 等按 benchmark 原生许可启用；goto 不应偷偷给纯坐标 baseline 增加导航捷径 |
| element-tree | click/fill/select/scroll 等引用**当前 observation 内命名空间的 element ID**；保存 ID→节点/bbox 映射；stale ID 返回可观察的动作错误，不重新定位到别的元素 |
| native-code | 原样保留 BrowserGym 高层字符串、OSWorld Python command 等：`native_action {language,payload,sha256}`；记录成功执行的原始串和解析结果；无法精确转换时禁止声称等价 canonical click |
| 结束与辅助 | `finish {answer?,status?}` 表示主体停止/回答，不能直接赋 success=1；ask_user/MCP 只在任务允许时广告，记录对话/工具输入输出与各自预算 |

坐标与动作语义的强制规则：

1. 截图原图、subject 实际看到的缩放/裁剪图、SoM 派生图分别保存 digest 与 transform。默认规范坐标为 `[0,1000]`（CUA-Lite 已有 inclusive 0..1000 常量与校验，可复用其思路。[L-geometry]），lowering 记下实际像素、viewport、DPI/缩放、rotation、window/tab ID；边缘取整/越界策略固定。已有 native pixel/归一化不同约定需保留版本，不能以统一公式改写原基准。
2. 一次 model decision、一个 tool call、一个 native env.step、一个 primitive click 不一定相等。四个计数分别记，明确原 benchmark budget 单位；禁止把十个 primitive 塞进一个“step”绕过原限制。若上游本就允许 action batch，保留其规则。
3. 动作 ack 要区分 `rejected / accepted / executing / executed / failed / outcome_unknown`。同 action ID+相同 payload 可查询/去重；同 ID+不同 payload 拒绝。远程超时后只查状态，不能盲目重放非幂等点击/提交；没有持久化 receipts 时 terminate 当前 attempt，保留 `outcome_unknown`，新 attempt 必须 reset。
4. `observe` 的截图也必须由可信 provider 产生。它是否消费 budget、每分钟上限、是否推进仿真/页面时钟需固定；不能靠无限免费截图获得额外计算时间。
5. 原生 reward 可用于记录但不必给 subject。是否提供中途 success signal 必须忠实于上游；隐藏 evaluator、最终 answer match、在线 reward 是不同反馈条件。

这些约束对应实际差异：BrowserGym 有 bid/coord 两套动作；OSWorld 可以执行任意 Python command；MobileWorld 有工具/用户交互；Gym-Anything 的 CLI gateway 把观察与状态动作的计数分开。[B-actions]、[O-env]、[M-loop]、[Y-cli]

**5.3 环境所有权、生命周期与 dirty/reset**

所有权以**组件**为单位；一项 trial 可能同时租 dedicated browser、singleton website DB、remote account 和 judge endpoint。共享 immutable 静态文件服务器不需要因为“singleton”就串行全部 episode；共享可写数据库/账户才需要冲突锁。此区分是针对 WebArena 共享状态与 MiniWoB 静态页面的设计推断。[B-mini]、[B-prep]、[A-deps]

| Ownership class | 取得/释放规则（建议） | 适合的例子与必须证明的 reset |
| --- | --- | --- |
| `dedicated` | 整个 trial 独占 instance；新建前记入 daemon；完成后销毁，确认 VM/容器/端口/临时卷消失才释放租约 | 新 browser context、新 OSWorld VM/overlay、新 AVD；仍需核对外部 DB/账号是否另有共享状态 |
| `pooled` | 独占 checkout，不允许同一实例两个活跃 writer；return 后先 reset+health+状态验收，成功才 ready；失败 quarantined | 可复位 VM/AVD/browser；清理 cookie/cache/downloads、磁盘/DB、时间与 task Python globals；指定最大复用次数和基盘版本 |
| `singleton` | 共享服务本体与独占 mutable namespace 分开计费；`shared_state_key` 产生冲突组，reset 也持锁；跨 daemon/跨机器的同一远程后端必须有同一锁权威 | WebArena 网站/账号、ServiceNow 实例；未知依赖时整套串行。只按 task dependency 排序不证明两个独立 job 可并行 |
| `remote` | 不宣称 Orbit 能销毁外部世界；只租 endpoint/session/account，验证身份、健康、配额和 reset receipt；release 关闭会话/归还账户 | live 网站、托管 VM/服务；无法 rewind 的状态标为不可逆/部分 reset，不能重置浏览器后宣称 pristine |

拟议状态流：`reserved → creating/checkout → ready → dirty(setup 开始前) → running → stopping → scoring/finalizing → evidence-sealed → resetting/destroying → ready/released`。任一 reset、清理验证失败进入 `quarantined`，并保持容量占用直到查明。这里是 **instance 状态**，必须由现有 daemon 管理并关联 Run；不能让 Python runner 另建全局资源账本。当前 Orbit pooled/singleton 实例账本在设计中仍属后置工作，不冒充已实现。[R-lifecycle]

关键规则：

- setup 开始即 dirty，失败也 reset；不能“还没 act 就当干净”。OSWorld 已采用该顺序。[O-env]
- reset 必须声明覆盖层次：客户端 context、设备/磁盘、共享网站 DB、task 对象、账号/session、实时时钟、工具服务器。MobileWorld 的 `reset_task_state()`、快照和后端清理给出了三个独立层面的代码证据。[M-task]
- pooled reset 通过“命令 exit=0”不够，应验证 snapshot/image ID、控制服务健康、登录态、初始数据 sentinel 和基准初始截图。视觉完全一致只可作辅助，不能替代 DB 状态验收。
- 浏览器复用还需隔离 service workers、storage、cookies、下载目录、profile、扩展和 tab；浏览器 context 隔离能力须由所选后端证明，不能只清空页面。
- cancel/timeout 先停止 subject 发动作，确认没有在途动作，再按原协议 finalize/scoring、封存证据，然后 reset/销毁；评分必须读取动作结束时那份状态，不能从 reset 后的环境取分。
- setup/agent/单步 watchdog/scorer/render/cleanup 各有独立 deadline。动作预算耗尽与基础设施 watchdog 超时不可混称 timeout。采集或评分尚未完成，不能提前归还 mutable 环境给下个 trial。
- daemon 重启后按 resource ID、label、lease 与实际实例对账；查询失败保留租约；失去已执行动作的 receipt 不猜测完成状态。不要用“重启 Python loop”冒充 episode 恢复。

**5.4 资源与能力准入**

建议在类别清单中分角色声明 `subject / gui / website / device / scorer / monitor`；一次原子准入所需 CPU、RAM、GPU、shm、磁盘空间、设备、端口、后端容量、模型并发与账号配额。初始使用一个 trial 一个 episode，原生 runner 内部并发固定为 1；若将来使用 slots，先租齐预算再启动。不得让 Ray/BatchRunner/env-server 在 Orbit 预算外扩容。[R-design9]、[C-batch]

| 子配置 | 必查资源/能力（建议） | 可见代码依据 |
| --- | --- | --- |
| browser fixture | browser 版本、headless/display、font/locale、RAM/shm、静态资源；带网站还要计 DB/service CPU/RAM/磁盘 | BrowserGym 创建 browser/task；GUI service 已单列 2 CPU/4GB/1GB shm，这只是当前实现值，**不是本报告推荐的通用配额**。[B-core]、[R-wire] |
| desktop VM | host 架构、虚拟化能力、KVM 权限、qcow2/overlay 空间、图形栈、guest 分辨率；VM 内存与容器进程内存共同预算 | OSWorld Docker provider、WAA QEMU；前者无 KVM 可降级软件模拟，后者本地路径明确要求 KVM。类别应固定是否准许降级。[O-docker]、[L-waaqemu] |
| mobile AVD | Android SDK/AVD/API level、KVM、adb namespace/端口、snapshot、应用后端资源；是否要求 privileged 显式声明 | MobileWorld 与 Lite mobile wrappers；设备能力不能只写“Android”。[M-task]、[L-aw]、[L-al]、[L-mw] |
| live-web / remote | egress/DNS/proxy、endpoint health、并发/速率限制、账号 lease、时区/地理位置、采集流量预算 | live WebVoyager/Online-Mind2Web；BrowserGym WebArena 设置 geolocation。[C-wv]、[C-om]、[B-wa] |
| local VLM / judge | 独立模型服务 GPU/显存与权重；若只调用远程模型，不凭“VLM”给 GUI VM 固定分配 GPU | VisualWebArena captioning 与 native judge 的调用入口；本次未实测具体硬件需求。[B-vwa]、[L-om] |

每个 benchmark 必须给资源证据与置信度；缺少实测时标估算/未核实，校准后更新。当前 `FailureKind` 的完整封闭集合为 `infra, agent_install, env_start, env_step, reset_failed, policy_start, policy_act, server_unreachable, call_watchdog, resume_failed, scorer_error, judge_unavailable, model_unavailable, budget_exceeded`；比旧 §9 枚举更完整，实现应以 contracts 代码为准。[R-contract]

**5.5 Scoring、judge 与 trial validity**

每个 benchmark 提交 `scoring_source = online-env / final-state / saved-evidence / answer-match`，再说明 scorer 是否使用模型。`saved-evidence` 并不自动等于无模型；`program` 也不自动等于确定性检查，Gym-Anything 会把 query_vlm 注入 program verifier。[Y-score]

建议把三个操作写清楚：

| 操作 | 读什么 / 产出什么 | 能否宣称重评 |
| --- | --- | --- |
| `verify_evidence` | 已保存的签名、hash、原始 verdict、步数与边界 → 完整性结果 | 只能说证据复核；BrowserGym 当前正是此类。[R-evidence] |
| `rescore_evidence` | 原始 scorer 所需的完整不可变输入 → 新 verdict/revision | 可以；必须记录 scorer/judge 版本与新请求，保留旧 verdict |
| `reevaluate_state` | 冻结的最终 guest/DB snapshot 或尚未释放的环境 → 原生 state scorer | 可以，但重建到初始状态后 replay 不等价；缺少完整最终状态时不得开放 |

LLM/VLM judge manifest 必填：provider/model 的可固定版本或实际返回标识、prompt/parser digest、温度/seed（支持时）、输入帧清单及采样策略、答案/action-history、最大 token、超时、重试条件/上限、响应 schema、最终 raw response 与 token usage。temperature=0 不构成已证明确定性；未固定模型后端的复现限制应写入结果。

judge 与 subject 的模型凭据/网络隔离；judge 只读封存的证据或可信 final state，不能接受 subject 自写的“成功截图/日志”作为唯一来源。多阶段/工具增强任务另记录 user simulator/tool server 的版本与故障，它们是环境依赖，不应被漏计为免费的 oracle。

有效性规则（建议；failure 只使用现有封闭集合，细节放 issues/结构化阶段信息）：

| 事件 | evaluation / failure | 分数与重试原则 |
| --- | --- | --- |
| 被测主体合法运行但做错、未完成、给错答案、显式放弃 | `valid`，不填基础设施 failure | 由原生 scorer 给 0 或 partial；不能为提高成绩重试 |
| 原定步数或 agent 执行预算耗尽，最终 scorer 正常 | 通常 `valid`，`episode.truncated=true` | 保留原生得分；不要把正常 task horizon 当 `budget_exceeded` 基础设施故障 |
| subject 返回无效动作但环境能按协议拒绝并继续 | 记录 action_error，继续或按规则结束；正常评分可 `valid` | 与 actuator/server crash 区分；格式差是能力失败，不应自动排除所有失败样本 |
| 镜像/VM/AVD 启动、reset、后端失联、动作执行基础设施失败 | `invalid` + `env_start / reset_failed / server_unreachable / env_step` | 保存部分轨迹，确认 cleanup/reset 后才可按预先公布策略重试 |
| policy 进程无法启动、runner/model 调用机制崩溃 | `invalid` + `policy_start / policy_act`；模型认证/配额/不可达用 `model_unavailable` | 应有可信进程/SDK证据，不能只根据 agent 文本“服务不可用”分类 |
| OOM 或准入预算不满足导致受测程序被系统杀死 | `invalid` + `budget_exceeded`（与现有 classifier 对齐） | 分数可保留供审计，valid-only 不计入。[R-classify] |
| watchdog 到时，动作是否执行未知；无法安全恢复 receipt | `invalid` + `call_watchdog`；恢复机制明确失败时 `resume_failed` | 禁止重复执行旧动作；不是免费额外 episode |
| judge 认证、429、网络或服务不可用 | `invalid` + `judge_unavailable` | 不写 0；限额内重试同一封存输入，最终失败保留缺项 |
| judge 返回无法解析/不满足 schema，scorer 异常、输入缺失、签名错误 | `invalid` + `scorer_error` | malformed verdict 与合法“不成功”分开；保留 raw response/错误 |
| native scorer catch 异常后给 0 | 保存 `official_raw=0`，若可信日志证明异常则 `invalid` | 不覆盖原始值，也不把它当正常失败。WebArena、OSWorld、Gym-Anything、Lite AndroidWorld 有相关异常转 0 路径；WebHarbor-WebVoyager 则有 malformed verdict 转 0 路径，均须保留错误原文。[B-wa]、[O-env]、[Y-score]、[L-awstep]、[L-wvscore] |
| run cancelled/lost，无法判定最终状态 | `unknown`，遵循现有 Orbit 判定 | 不补造失败 verdict；可用证据仍保存。[R-classify] |
| scoring 已完成但 cleanup 失败 | 保留已证明的有效性；独立 `cleanup=failed` | 不允许下一 trial 复用脏实例；若发现污染发生在本 episode 之前，则另行撤销有效性并形成报告修订 |

当前 Orbit 的 `Outcome` 三态结构、closed failure、episode 已能承载上述大部分结果；但 action receipt、细粒度 judge manifest、污染追溯和 instance quarantine 是新增设计，不是已实现的全部功能。[R-contract]、[R-lifecycle]

**5.6 可信证据与 trajectory/review**

建议可信 GUI service/monitor 是截图、动作 receipts、状态摘要与时间戳的 producer；subject session 是另一 producer。每份 artifact 标 `producer / trust / source / sha256`，视频另标 live capture 或 derived render。Hash 证明文件一致性，签名绑定 producer；签名不证明 scorer 逻辑正确，也不能防止与被测主体同权限的 verifier 被篡改。

从现有 Ed25519 result-manifest 设计扩展（不破坏旧证据核验）：

- daemon 在 launch 时固定 episode identity、task/config digest 和公钥；private key 只给可信 service，subject 永远不能替换 trust anchor。
- 签名清单绑定所有初始/动作前后截图、**subject 实际看到的图**、AX/DOM/SoM 映射、原始和 lowered action、receipts、budget、终止原因、官方 verdict、judge inputs/outputs、reset/cleanup 证明。仅签截图不足以防止替换动作或将别的任务录像拼过来。
- 为中途崩溃保留可核验前缀，可选 append-only sequence/hash chain 与周期签名 checkpoint；当前 Bridge 的内存去重不能满足跨重启 receipt 恢复，需要显式新增持久化机制。[R-bridge]
- 截图缺失是否令 score invalid 取决 scorer 必需证据：VLM judge 必需帧缺失应 invalid；若 trusted final-state scorer 的全部证明仍完整，展示视频缺失可保留 valid、标 review incomplete。不能让可选视频导出失败抹掉真实成绩；也不能让“trace 可选”掩盖 judge 输入缺失。[C-episode]
- Native runner 导入的 session/轨迹应保留原文并标来源；未跨信任边界采集的 hash 不能冒充 service signature。需要执行不可信 CLI/native code 时，scorer/control 服务与其 filesystem、进程和密钥必须隔离。

建议文件布局：

```text
trial/
  identity.json                 # task/variant/release/config/attempt identity
  lifecycle.jsonl               # lease, ready, dirty, reset, health, cleanup
  trajectory/events.jsonl       # sequence, episode, action/observation/tool ids
  trajectory/media/             # originals + subject views + overlay derivatives
  trajectory/observations/      # AX/DOM/SoM mappings when permitted
  trajectory/index.json         # read-only review index
  native/                       # untouched native logs/results/ATIF/traj
  scoring/input-manifest.json
  scoring/native-result.json
  scoring/judge-attempts.jsonl
  evidence-manifest.json
  evidence-signature.json
```

trajectory 每个事件记录 `schema_version,trial_id,attempt_id,episode_id,sequence,wall_time,monotonic_offset,producer,kind,observation_id,action_id,tool_call_id,payload_ref,sha256`。初始帧是 step 0；每个动作有 requested/accepted/executed 与 observation-after，保留原生 step ID。若平台在一次 batch 中只截图一次，则中间图明确 absent，不能生成看似真实的插值帧。

Web 统一展示：目标/协议条件、初始屏、每步截图和坐标/drag overlay、AX/DOM 标签、native action、执行错误、预算、终止原因、官方 scorer 说明、validity/cleanup、证据信任等级；agent session 按 action/tool ID 对齐，只有时间对齐时注明 approximate。登录输入在 UI 脱敏，原始敏感证据若保留则受访问控制；保留脱敏与原图 hash 的关系，避免修改了图却继续使用旧签名。

现有 `GuiTrajectory` 可作为简化 read model：step 0 无动作、后续动作后截图；扩展类型 `GuiTrace/GuiStepContext` 提供 `actionId` 与时间以对齐 session。[R-traj]、[R-traj-context] 完整新证据不应被压成只能容纳 screenshot/reward 的数组。ATIF 是 agent 轨迹交换格式，不能替代 GUI backend 的 reset/执行/评分证据。视频、实时 VNC 和历史轨迹是不同功能，不能把历史视频称为可交互 replay。[R-traj]、[R-evidence]

**5.7 校准与保真度验收**

校准按 **benchmark × revision × interaction_profile × provider/reset_mode × scorer** 执行，不按“hub 已跑过”批准全家族。推荐每个接入提交下列可复查包：

| 校准层 | 必须提供的证据（建议） |
| --- | --- |
| 枚举/身份 | 与上游任务清单逐项比对、task digest、未支持任务及原因、variant/split；不得把 suite 占位行算 episode |
| 环境与 reset | 初始状态验收；同 seed fresh/fresh、fresh/pooled 对比；故意污染后的 reset；setup 中断、取消、超时后下一任务不继承状态；外部账号/DB 一起检查 |
| 动作/观测 | 点击四角/边界、缩放/DPI/旋转、拖拽/滚动/Unicode/键位、多 tab、stale element ID、batch 预算；同 action ID 重试与回包丢失；原始/转换动作一致 |
| 正负评分 | empty、已知错误产物、已知成功脚本/oracle/原生 reference trajectory；每项有 task 定义的期望值或区间；没有通用 oracle 则写 absent，不能伪造 |
| judge | 固定正负和边界样例、人工复查样本、同输入多次 verdict 分布、解析错误/429/超时；严格区分 judge 不可用与否定结果；不对新 judge 直接继承旧校准 |
| 原生对齐 | 同任务、相同初始状态/预算/观测动作权限/模型配置，分别走原生入口和类别入口；比较官方最终 score、结束条件、关键 state/evidence，明确偏差 |
| 真主体 | 至少一个真实 VLM/native agent 与计划支持的 CLI bridge 跑完整 episode；若只测脚本，标记“脚本校准”，不宣传真实 agent 支持 |
| 资源与 cleanup | 实测峰值、超时/取消/daemon 重启，确认 VM/AVD/服务/卷/账号 lease 回收；未知或失败不得归还 pooled 实例 |
| 重评分 | 证据复核重跑应稳定；模型重评分记录新 revision 及合理波动；无法保存 final state 的 state scorer 明确不支持独立重评 |

现有 `orbit bench calibrate` 检查 empty 最低分、oracle 最高分、不同 seed 一致和 evidence rescore；这些是实用默认，但不是所有 GUI 任务的普适数学性质。[R-calibrate] WAA wrapper 甚至有“初始状态即成功”的任务屏蔽表。[L-waa] 因此建议：empty 不是 0 时先检查原任务是否允许 vacuous success；若是，登记原生期望，不能为通过校准私自改 scorer。带随机初始化任务应检查“固定同一 seed 的重复”和“多个 seed 的分布”，不能要求不同 seed 一定同分；live-web/VLM judge 也不应以严格逐次相等作为唯一校准标准。

保真度建议使用清晰标签 `source-only / environment-calibrated / native-parity / real-subject / maintained`，避免与实现接入层 L0/L1/L2 混淆。每条带最近验证时间、任务样本、版本指纹和 deviations；文档声明、fixture 测试、真实环境校准必须分开。

**5.8 聚合与报告修订**

建议逻辑样本身份为 `benchmark_revision × task × variant × initial_state/seed × repetition`，method 是比较维度，attempt 是基础设施重试维度。seed 不被原生实现消费时写 `seed_effect=identity_only`，不要将重复运行说成不同随机初始状态；当前 MobileWorld/OSWorld adapter 已明确该边界。[R-mobile]、[R-os]

同时输出两条口径：

1. **Native/official 口径**：原始分数、任务成功阈值、官方 denominator、missing/error/pass@k 选择策略。未核实官方聚合时只能称 `native-score summary`，不能猜一个 mean 后叫 official。既有 `OfficialRule` 只支持 errors exclude/fail、unit sample/task、failValue/metric；更复杂官方规则须增加有版本的聚合实现，不能硬塞。[R-contract]
2. **Orbit valid-only 口径**：仅 valid 样本先任务内 seed/repetition 平均，再任务间平均；任务聚类 95% CI；方法对比使用共同有效任务的 paired difference。此规则已有代码，可复用；同时报告计划/完成/valid/invalid/unknown/missing、各 failure 数、coverage 和 `partial`。[R-metrics]

不对不同 benchmark 的原始 reward 做总平均，不把 Cua 的 evaluation list、Gym-Anything 0–100 rubric 与 MiniWoB 0/1 直接相加。任务数不等、variant 数不等时由 benchmark 规定权重，不让数量较多的 wrapper variants 隐性加权。多个 batch 的结果按样本重算，禁止 mean-of-batch-means。

同条件的 infra retry 只能替换无效 attempt；有效 0 分不允许挑优覆盖。独立重复用于成功概率/pass@k，应预先固定次数并全部保留。报告每次重评、补跑、合并都追加 immutable revision，引用采用的 attempt/verdict 与 plan digest。Orbit 代码已实现带 `planDigest`、逐样本 entry 与 counts 的 report，以及内容变化时递增 revision、保留旧 revision；文档中更完整的 explicit attempt/retry 计数仍属后续工作，不能把两者混为一项。[R-report]、[R-report-write]、[R-results]

对于 live-web，同时间窗口随机交错/配对安排方法，报告 URL/网站版本线索、时间段、地区、账户、judge版本和失效率；跨日比较明确非同一环境分布。对同一 task 的多次 judge 请求不是新的 agent 样本，不能用于扩大样本量/缩小 CI。

**六、边界场景的具体处理**

| 场景 | 接入决定与证据要求（建议） |
| --- | --- |
| LLM/VLM judge 接口失败 | 有效性 invalid，区分不可用与 parser/scorer 错误；保存 request/response、retry次数、证据 digest。仅对同一输入做有限 infra 重试；不重跑 agent 以谋取更好 verdict |
| Judge 合法给 NOT SUCCESS | valid 0；不能因 judge 也是 LLM 就一律判 invalid。质量/偏差用校准与独立复核衡量 |
| Judge 看最后几张图漏掉成功步骤 | 忠实保存该 benchmark 原生帧选取规则，并在类别内显式配置；若改为全轨迹是新评分 revision。Cua LiveWebAdapter 的“三张图”限制是具体可核实例子。[C-web] |
| live 网站改版、404、广告/弹窗、CAPTCHA | preflight 与执行时证据共同判断。原协议把正常网页挑战算任务难度时按 valid 失败；本次应有的任务入口/账号/后端损坏则 invalid。不要一遇困难就判 env failure，也不私自绕过登录或验证码；修复/mirror 后另记协议版本 |
| 网站无可控 reset | 标 `remote + live-web + reset_scope=client_only`；只保证 browser/session 清理。预先选定可复用账户/只读任务或单次账户；对外部写状态不可证明回滚时不加入 pooled 可复用集合 |
| WebArena 等共享后端并发 | 先独占整个 `shared_state_key` 从 reset 到评分采集完成；想提并发时用多套独立后端，或经核实的 namespace/conflict graph。AgentLab 代码说明 Ray/sequential 才正确遵守其依赖图；不能把任意 executor 的并发默认当隔离证明。[A-launch]、[A-deps] |
| 每 trial browser 都独立但使用同一网站账号 | account 也是共享可写资源；cookies 分离不能隔离同一服务器账户的数据。租约同时包含 profile、账号与后端数据 namespace |
| task 需要登录 | 明确初始应为 logged-in、要求 subject 自己登录、还是按任务初始化导入 storage state；记录角色/权限和脱敏账号标识，凭据只给获准的登录工具/环境。缺凭据在 admission 阶段列 unsupported；已登记账号过期记 reset/env_start，登录操作本来就是题目时做错可有效 0 |
| MobileWorld ask_user / MCP | 作为 `assisted-tools` 条件，保存用户模型/工具服务器版本、调用预算、结果与错误；GUI-only 的过滤清单不可当全 MobileWorld。Lite 明确排除了 agent-mcp 并给 user-interaction 打标。[L-mw] |
| OSWorld Docker 与 VM 替换 | 固定 provider/image/服务能力；Cua 容器降级项不能使用 VM 原版 parity 名称。OSWorld Docker 不支持 save_state，不能因此承诺任意中途恢复。[C-os]、[O-docker] |
| arbitrary pyautogui/Python/terminal 与坐标点击比较 | 记录权限差异并分 profile 报告；原生代码中的循环、等待、多点击、文件/进程访问不能“抽取一个点击”后宣称只给 GUI 权限 |
| seed 固定但结果变动 | 保存 seed 是否被消费、系统时间、随机库/模型配置、网络、截图时序；对未被控制的因素标未核实。相同整数 seed 不是确定性证明 |
| 退出前未 score / cleanup 失败 | 保存完整度与原始末态；score 必需证据不足则 invalid；仅 cleanup 失败则保留已证明的 score、隔离资源；Run 成功退出本身不是任务成功 |

**七、每个具体 benchmark 应交付的最小接入包**

以下清单是可评审的建议格式，不是新增一个中间 hub：

```yaml
category: gui-interaction/1
benchmark:
  id: <upstream-benchmark>
  revision: <task-and-scorer-revision>
  task_catalog: <native-file-or-enumerator>
  supported_filter: <explicit-or-none>
  deviations: []
profiles:
  platform: browser
  world_mode: fixture
  interaction: visual-coordinate
  method_transports: [native-agent, cli-tool-bridge]
subject_contract:
  observations: [screenshot]
  actions: <declared-canonical-schema-and-native-lowering-version>
  budget: <native-step-unit-plus-time-and-tool-limits>
environment:
  components: <roles, ownership, shared_state_keys, immutable-images>
  resources: <cpu, ram, gpu, devices, disk, shm, service-slots>
  lifecycle: <create, health, mark-dirty, setup, finalize, reset, destroy>
  reset_assertions: <native-state-checks>
  network_and_accounts: <phase-scoped-dependencies>
scoring:
  entrypoint: <original-scorer>
  source: final-state
  metrics: <native-names-ranges-and-success-rule>
  judge: <none-or-pinned-judge-manifest>
  rescore: <evidence-check | evidence-regrade | state-regrade | none>
  aggregation: <verified-native-rule-and-orbit-view>
evidence:
  required: <observations-actions-receipts-final-state-judge-inputs>
  producer: trusted-service
  signature: Ed25519-manifest
  trajectory_importer: <native-format-to-review-index>
calibration:
  positive: <oracle-script-native-reference-or-absent>
  negative: <expected-scores-or-ranges>
  reset_and_failure_cases: <explicit-cases>
  native_parity: <artifact-references-or-not_run>
```

评审时应能回答：一个 task 从哪份原始定义来；主体看到的内容和权限是否改变；原生预算怎样计数；谁拥有每个可写状态；reset 到底复位了什么；评分在何时对哪份状态计算；judge 的错误有没有被吞掉；证据由谁产生且是否可篡改；同一次 episode 能否复核/重评；哪些样本进入分母。任何一项没有代码/校准依据，填写 **未核实** 或 unsupported，不能用某个 hub 的总体支持矩阵填空。

**八、本次验证结果**

静态代码和配置核查：已完成；115 个本地引用锚点及版本链接的文件存在性、行号范围检查 `passed`；15 个 Markdown 表格列数、2 个 JSON 示例解析检查 `passed`。八个源码仓库的 HEAD 与工作区状态均与读取时一致，未修改任何仓库。这些机械检查不等价于运行被引用代码。运行真实环境、模型/judge、上游测试套件、原生/Orbit 成绩对照：`not_run`，本任务要求只读调研且未请求运行实验。本文给出的是可核查的源码结论与类别规范建议，所有真实运行能力仍以具体接入的独立校准记录为准。

**九、本地源码索引**

路径均相对于 `` 展示，链接为绝对路径；行号是进入相关实现的起点，同一文件中的其他具体函数已在正文点名。文档条目只支撑“设计/记录写了什么”，不替代实现或运行证明。

| 引用 | 本地文件与入口行 |
| --- | --- |
| A-deps | [AgentLab/src/agentlab/experiments/study.py:66][A-deps] |
| A-gaia | [AgentLab/src/agentlab/benchmarks/gaia.py:1][A-gaia] |
| A-launch | [AgentLab/src/agentlab/experiments/launch_exp.py:19][A-launch] |
| A-loop | [AgentLab/src/agentlab/experiments/loop.py:201][A-loop] |
| A-os | [AgentLab/src/agentlab/benchmarks/osworld.py:598][A-os] |
| B-ab | [BrowserGym/browsergym/assistantbench/src/browsergym/assistantbench/task.py:90][B-ab] |
| B-abscore | [BrowserGym/browsergym/assistantbench/src/browsergym/assistantbench/evaluation/evaluator.py:102][B-abscore] |
| B-actions | [BrowserGym/browsergym/core/src/browsergym/core/action/highlevel.py:48][B-actions] |
| B-config | [BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/configs.py:369][B-config] |
| B-core | [BrowserGym/browsergym/core/src/browsergym/core/env.py:184][B-core] |
| B-mini | [BrowserGym/browsergym/miniwob/src/browsergym/miniwob/base.py:23][B-mini] |
| B-prep | [BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/utils.py:139][B-prep] |
| B-readme | [BrowserGym/README.md:39][B-readme] |
| B-task | [BrowserGym/browsergym/core/src/browsergym/core/task.py:18][B-task] |
| B-vwa | [BrowserGym/browsergym/visualwebarena/src/browsergym/visualwebarena/task.py:165][B-vwa] |
| B-wa | [BrowserGym/browsergym/webarena/src/browsergym/webarena/task.py:90][B-wa] |
| B-wav | [BrowserGym/browsergym/webarena_verified/src/browsergym/webarena_verified/task.py:13][B-wav] |
| B-work | [BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/utils.py:17][B-work] |
| C-basic | [cua/libs/cua-bench/datasets/cua-bench-basic/click-button/main.py:41][C-basic] |
| C-batch | [cua/libs/cua-bench/cua_bench/runner/batch_runner.py:198][C-batch] |
| C-budgets | [cua/libs/cua-bench/cua_bench/agents/cua_agent.py:48][C-budgets] |
| C-episode | [cua/libs/cua-bench/cua_bench/runner/episode.py:132][C-episode] |
| C-gemini | [cua/libs/cua-bench/cua_bench/agents/gemini.py:24][C-gemini] |
| C-harness | [cua/libs/cua-bench/cua_bench/agents/harness_agent.py:1][C-harness] |
| C-judge | [cua/libs/cua-bench/cua_bench/adapters/judges.py:34][C-judge] |
| C-om | [cua/libs/cua-bench/tasks/online_mind2web/main.py:28][C-om] |
| C-os | [cua/libs/cua-bench/tasks/osworld/main.py:1][C-os] |
| C-reg | [cua/libs/cua-bench/cua_bench/registry.json:1][C-reg] |
| C-waa | [cua/libs/cua-bench/tasks/winarena_adapter/evaluator.py:1][C-waa] |
| C-web | [cua/libs/cua-bench/cua_bench/adapters/web.py:67][C-web] |
| C-wv | [cua/libs/cua-bench/tasks/webvoyager/main.py:29][C-wv] |
| G-os | [cua-lite/lite/gym/envs/osworld_g/main.py:1][G-os] |
| G-screen | [cua-lite/lite/gym/envs/screenspot_pro/main.py:253][G-screen] |
| L-al | [cua-lite/lite/gym/envs/androidlab/main.py:770][L-al] |
| L-alcfg | [cua-lite/lite/gym/envs/androidlab/configs/default.yaml:8][L-alcfg] |
| L-alserver | [cua-lite/lite/gym/envs/androidlab/docker/server.py:488][L-alserver] |
| L-aw | [cua-lite/lite/gym/envs/androidworld/main.py:890][L-aw] |
| L-awcfg | [cua-lite/lite/gym/envs/androidworld/configs/default.yaml:30][L-awcfg] |
| L-awstep | [cua-lite/lite/gym/envs/androidworld/main.py:1280][L-awstep] |
| L-base | [cua-lite/lite/gym/base.py:181][L-base] |
| L-calls | [cua-lite/lite/core/tools/calls.py:40][L-calls] |
| L-cuacfg | [cua-lite/lite/gym/envs/cua/bench/configs/default.yaml:28][L-cuacfg] |
| L-doc | [cua-lite/docs/envs.md:131][L-doc] |
| L-geometry | [cua-lite/lite/core/tools/action_space/geometry.py:23][L-geometry] |
| L-liteoscfg | [cua-lite/lite/gym/envs/lite/osworld/configs/default.yaml:11][L-liteoscfg] |
| L-loop | [cua-lite/lite/agents/core/agent/base.py:494][L-loop] |
| L-mgym | [cua-lite/lite/gym/envs/mobilegym/main.py:474][L-mgym] |
| L-mw | [cua-lite/lite/gym/envs/mobileworld/main.py:18][L-mw] |
| L-mwcfg | [cua-lite/lite/gym/envs/mobileworld/configs/default.yaml:36][L-mwcfg] |
| L-om | [cua-lite/lite/gym/envs/online_mind2web/main.py:822][L-om] |
| L-omserver | [cua-lite/lite/gym/envs/online_mind2web/docker/server.py:1010][L-omserver] |
| L-os2cfg | [cua-lite/lite/gym/envs/osworld_2/configs/default.yaml:27][L-os2cfg] |
| L-oscfg | [cua-lite/lite/gym/envs/osworld/configs/default.yaml:26][L-oscfg] |
| L-services | [cua-lite/lite/gym/services.py:1][L-services] |
| L-waa | [cua-lite/lite/gym/envs/waa/main.py:135][L-waa] |
| L-waacfg | [cua-lite/lite/gym/envs/waa/configs/default.yaml:24][L-waacfg] |
| L-waaqemu | [cua-lite/lite/gym/envs/waa/qemu.py:119][L-waaqemu] |
| L-webgym | [cua-lite/lite/gym/envs/webgym/main.py:1][L-webgym] |
| L-webgymcfg | [cua-lite/lite/gym/envs/webgym/configs/default.yaml:29][L-webgymcfg] |
| L-webjudge | [cua-lite/lite/gym/envs/webgym/docker/patches/evaluator.py:157][L-webjudge] |
| L-wv | [cua-lite/lite/gym/envs/webharbor/webvoyager/main.py:577][L-wv] |
| L-wvscore | [cua-lite/lite/gym/envs/webharbor/webvoyager/main.py:748][L-wvscore] |
| L-wvserver | [cua-lite/lite/gym/envs/webharbor/webvoyager/docker/server.py:1][L-wvserver] |
| M-agent | [MobileWorld/src/mobile_world/agents/base.py:15][M-agent] |
| M-cli | [MobileWorld/src/mobile_world/core/subcommands/eval.py:197][M-cli] |
| M-loop | [MobileWorld/src/mobile_world/core/runner.py:28][M-loop] |
| M-score1 | [MobileWorld/src/mobile_world/tasks/definitions/native/set_alarm.py:25][M-score1] |
| M-score2 | [MobileWorld/src/mobile_world/tasks/definitions/gmail/send_interview_email.py:56][M-score2] |
| M-task | [MobileWorld/src/mobile_world/tasks/base.py:100][M-task] |
| N-browser | [orbit/docs/research/gui-bench/02-browsergym-agentlab.md:1][N-browser] |
| N-cua | [orbit/docs/research/gui-bench/01-cua-bench.md:1][N-cua] |
| N-gym | [orbit/docs/research/gui-bench/04-gym-anything.md:1][N-gym] |
| N-lite | [orbit/docs/research/gui-bench/06-cua-lite.md:1][N-lite] |
| N-mobile | [orbit/docs/research/gui-bench/05-mobileworld.md:1][N-mobile] |
| N-os | [orbit/docs/research/gui-bench/03-osworld-v2.md:1][N-os] |
| O-cli | [OSWorld-V2/scripts/python/run_multienv_claude.py:62][O-cli] |
| O-docker | [OSWorld-V2/desktop_env/providers/docker/provider.py:127][O-docker] |
| O-env | [OSWorld-V2/desktop_env/desktop_env.py:306][O-env] |
| O-loop | [OSWorld-V2/lib_run_single.py:955][O-loop] |
| O-release | [OSWorld-V2/benchmark_releases/osworld-v2.1.json:1][O-release] |
| R-adapter | [orbit/packages/orbit/src/contracts/adapter.ts:32][R-adapter] |
| R-bg | [orbit/examples/bench-adapters/browsergym/adapter.py:78][R-bg] |
| R-bridge | [orbit/examples/tools/orbit-gui-service/service.py:17][R-bridge] |
| R-calibrate | [orbit/packages/orbit/src/cli/calibrate.ts:47][R-calibrate] |
| R-catalog | [orbit/docs/catalog.md:1][R-catalog] |
| R-classify | [orbit/packages/orbit/src/bench/classify.ts:68][R-classify] |
| R-contract | [orbit/packages/orbit/src/contracts/bench.ts:330][R-contract] |
| R-cua | [orbit/examples/bench-adapters/cua-bench/adapter.py:60][R-cua] |
| R-design9 | [orbit/docs/design.md:736][R-design9] |
| R-evidence | [orbit/examples/tools/orbit-gui-service/evidence.py:54][R-evidence] |
| R-judge | [orbit/examples/bench-adapters/cua-lite/judge.py:15][R-judge] |
| R-lifecycle | [orbit/docs/design.md:843][R-lifecycle] |
| R-lite | [orbit/examples/bench-adapters/cua-lite/adapter.py:23][R-lite] |
| R-lite-score | [orbit/examples/bench-adapters/cua-lite/evidence.py:108][R-lite-score] |
| R-method | [orbit/packages/orbit/src/contracts/bench.ts:126][R-method] |
| R-metrics | [orbit/packages/orbit/src/contracts/metrics.ts:93][R-metrics] |
| R-mobile | [orbit/examples/bench-adapters/mobileworld/adapter.py:103][R-mobile] |
| R-mobilerun | [orbit/examples/bench-adapters/mobileworld/runtime.py:24][R-mobilerun] |
| R-os | [orbit/examples/bench-adapters/osworld-v2/adapter.py:129][R-os] |
| R-osrun | [orbit/examples/bench-adapters/osworld-v2/runtime.py:127][R-osrun] |
| R-report | [orbit/packages/orbit/src/bench/summary.ts:134][R-report] |
| R-report-write | [orbit/packages/orbit/src/bench/service.ts:695][R-report-write] |
| R-results | [orbit/docs/design.md:895][R-results] |
| R-rules | [orbit/AGENTS.md:24][R-rules] |
| R-tiers | [orbit/docs/design.md:979][R-tiers] |
| R-traj | [orbit/packages/orbit/src/contracts/bench.ts:239][R-traj] |
| R-traj-context | [orbit/packages/orbit/src/contracts/trajectory.ts:18][R-traj-context] |
| R-wire | [orbit/examples/tools/orbit-gui-service/adapter.py:36][R-wire] |
| Y-agent | [gym-anything/agents/agents/base.py:23][Y-agent] |
| Y-cli | [gym-anything/agents/shared/cli_harness.py:1][Y-cli] |
| Y-env | [gym-anything/src/gym_anything/env.py:167][Y-env] |
| Y-example | [gym-anything/benchmarks/cua_world/environments/libreoffice_calc_env/tasks/basic_formulas/task.json:1][Y-example] |
| Y-runners | [gym-anything/src/gym_anything/runtime/runners/registry.py:84][Y-runners] |
| Y-score | [gym-anything/src/gym_anything/verification/runner.py:33][Y-score] |
| Y-single | [gym-anything/agents/evaluation/run_single.py:366][Y-single] |

[A-deps]: AgentLab/src/agentlab/experiments/study.py:66
[A-gaia]: AgentLab/src/agentlab/benchmarks/gaia.py:1
[A-launch]: AgentLab/src/agentlab/experiments/launch_exp.py:19
[A-loop]: AgentLab/src/agentlab/experiments/loop.py:201
[A-os]: AgentLab/src/agentlab/benchmarks/osworld.py:598
[B-ab]: BrowserGym/browsergym/assistantbench/src/browsergym/assistantbench/task.py:90
[B-abscore]: BrowserGym/browsergym/assistantbench/src/browsergym/assistantbench/evaluation/evaluator.py:102
[B-actions]: BrowserGym/browsergym/core/src/browsergym/core/action/highlevel.py:48
[B-config]: BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/configs.py:369
[B-core]: BrowserGym/browsergym/core/src/browsergym/core/env.py:184
[B-mini]: BrowserGym/browsergym/miniwob/src/browsergym/miniwob/base.py:23
[B-prep]: BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/utils.py:139
[B-readme]: BrowserGym/README.md:39
[B-task]: BrowserGym/browsergym/core/src/browsergym/core/task.py:18
[B-vwa]: BrowserGym/browsergym/visualwebarena/src/browsergym/visualwebarena/task.py:165
[B-wa]: BrowserGym/browsergym/webarena/src/browsergym/webarena/task.py:90
[B-wav]: BrowserGym/browsergym/webarena_verified/src/browsergym/webarena_verified/task.py:13
[B-work]: BrowserGym/browsergym/experiments/src/browsergym/experiments/benchmark/utils.py:17
[C-basic]: cua/libs/cua-bench/datasets/cua-bench-basic/click-button/main.py:41
[C-batch]: cua/libs/cua-bench/cua_bench/runner/batch_runner.py:198
[C-budgets]: cua/libs/cua-bench/cua_bench/agents/cua_agent.py:48
[C-episode]: cua/libs/cua-bench/cua_bench/runner/episode.py:132
[C-gemini]: cua/libs/cua-bench/cua_bench/agents/gemini.py:24
[C-harness]: cua/libs/cua-bench/cua_bench/agents/harness_agent.py:1
[C-judge]: cua/libs/cua-bench/cua_bench/adapters/judges.py:34
[C-om]: cua/libs/cua-bench/tasks/online_mind2web/main.py:28
[C-os]: cua/libs/cua-bench/tasks/osworld/main.py:1
[C-reg]: cua/libs/cua-bench/cua_bench/registry.json:1
[C-waa]: cua/libs/cua-bench/tasks/winarena_adapter/evaluator.py:1
[C-web]: cua/libs/cua-bench/cua_bench/adapters/web.py:67
[C-wv]: cua/libs/cua-bench/tasks/webvoyager/main.py:29
[G-os]: cua-lite/lite/gym/envs/osworld_g/main.py:1
[G-screen]: cua-lite/lite/gym/envs/screenspot_pro/main.py:253
[L-al]: cua-lite/lite/gym/envs/androidlab/main.py:770
[L-alcfg]: cua-lite/lite/gym/envs/androidlab/configs/default.yaml:8
[L-alserver]: cua-lite/lite/gym/envs/androidlab/docker/server.py:488
[L-aw]: cua-lite/lite/gym/envs/androidworld/main.py:890
[L-awcfg]: cua-lite/lite/gym/envs/androidworld/configs/default.yaml:30
[L-awstep]: cua-lite/lite/gym/envs/androidworld/main.py:1280
[L-base]: cua-lite/lite/gym/base.py:181
[L-calls]: cua-lite/lite/core/tools/calls.py:40
[L-cuacfg]: cua-lite/lite/gym/envs/cua/bench/configs/default.yaml:28
[L-doc]: cua-lite/docs/envs.md:131
[L-geometry]: cua-lite/lite/core/tools/action_space/geometry.py:23
[L-liteoscfg]: cua-lite/lite/gym/envs/lite/osworld/configs/default.yaml:11
[L-loop]: cua-lite/lite/agents/core/agent/base.py:494
[L-mgym]: cua-lite/lite/gym/envs/mobilegym/main.py:474
[L-mw]: cua-lite/lite/gym/envs/mobileworld/main.py:18
[L-mwcfg]: cua-lite/lite/gym/envs/mobileworld/configs/default.yaml:36
[L-om]: cua-lite/lite/gym/envs/online_mind2web/main.py:822
[L-omserver]: cua-lite/lite/gym/envs/online_mind2web/docker/server.py:1010
[L-os2cfg]: cua-lite/lite/gym/envs/osworld_2/configs/default.yaml:27
[L-oscfg]: cua-lite/lite/gym/envs/osworld/configs/default.yaml:26
[L-services]: cua-lite/lite/gym/services.py:1
[L-waa]: cua-lite/lite/gym/envs/waa/main.py:135
[L-waacfg]: cua-lite/lite/gym/envs/waa/configs/default.yaml:24
[L-waaqemu]: cua-lite/lite/gym/envs/waa/qemu.py:119
[L-webgym]: cua-lite/lite/gym/envs/webgym/main.py:1
[L-webgymcfg]: cua-lite/lite/gym/envs/webgym/configs/default.yaml:29
[L-webjudge]: cua-lite/lite/gym/envs/webgym/docker/patches/evaluator.py:157
[L-wv]: cua-lite/lite/gym/envs/webharbor/webvoyager/main.py:577
[L-wvscore]: cua-lite/lite/gym/envs/webharbor/webvoyager/main.py:748
[L-wvserver]: cua-lite/lite/gym/envs/webharbor/webvoyager/docker/server.py:1
[M-agent]: MobileWorld/src/mobile_world/agents/base.py:15
[M-cli]: MobileWorld/src/mobile_world/core/subcommands/eval.py:197
[M-loop]: MobileWorld/src/mobile_world/core/runner.py:28
[M-score1]: MobileWorld/src/mobile_world/tasks/definitions/native/set_alarm.py:25
[M-score2]: MobileWorld/src/mobile_world/tasks/definitions/gmail/send_interview_email.py:56
[M-task]: MobileWorld/src/mobile_world/tasks/base.py:100
[N-browser]: orbit/docs/research/gui-bench/02-browsergym-agentlab.md:1
[N-cua]: orbit/docs/research/gui-bench/01-cua-bench.md:1
[N-gym]: orbit/docs/research/gui-bench/04-gym-anything.md:1
[N-lite]: orbit/docs/research/gui-bench/06-cua-lite.md:1
[N-mobile]: orbit/docs/research/gui-bench/05-mobileworld.md:1
[N-os]: orbit/docs/research/gui-bench/03-osworld-v2.md:1
[O-cli]: OSWorld-V2/scripts/python/run_multienv_claude.py:62
[O-docker]: OSWorld-V2/desktop_env/providers/docker/provider.py:127
[O-env]: OSWorld-V2/desktop_env/desktop_env.py:306
[O-loop]: OSWorld-V2/lib_run_single.py:955
[O-release]: OSWorld-V2/benchmark_releases/osworld-v2.1.json:1
[R-adapter]: orbit/packages/orbit/src/contracts/adapter.ts:32
[R-bg]: orbit/examples/bench-adapters/browsergym/adapter.py:78
[R-bridge]: orbit/examples/tools/orbit-gui-service/service.py:17
[R-calibrate]: orbit/packages/orbit/src/cli/calibrate.ts:47
[R-catalog]: orbit/docs/catalog.md:1
[R-classify]: orbit/packages/orbit/src/bench/classify.ts:68
[R-contract]: orbit/packages/orbit/src/contracts/bench.ts:330
[R-cua]: orbit/examples/bench-adapters/cua-bench/adapter.py:60
[R-design9]: orbit/docs/design.md:736
[R-evidence]: orbit/examples/tools/orbit-gui-service/evidence.py:54
[R-judge]: orbit/examples/bench-adapters/cua-lite/judge.py:15
[R-lifecycle]: orbit/docs/design.md:843
[R-lite]: orbit/examples/bench-adapters/cua-lite/adapter.py:23
[R-lite-score]: orbit/examples/bench-adapters/cua-lite/evidence.py:108
[R-method]: orbit/packages/orbit/src/contracts/bench.ts:126
[R-metrics]: orbit/packages/orbit/src/contracts/metrics.ts:93
[R-mobile]: orbit/examples/bench-adapters/mobileworld/adapter.py:103
[R-mobilerun]: orbit/examples/bench-adapters/mobileworld/runtime.py:24
[R-os]: orbit/examples/bench-adapters/osworld-v2/adapter.py:129
[R-osrun]: orbit/examples/bench-adapters/osworld-v2/runtime.py:127
[R-report]: orbit/packages/orbit/src/bench/summary.ts:134
[R-report-write]: orbit/packages/orbit/src/bench/service.ts:695
[R-results]: orbit/docs/design.md:895
[R-rules]: orbit/AGENTS.md:24
[R-tiers]: orbit/docs/design.md:979
[R-traj]: orbit/packages/orbit/src/contracts/bench.ts:239
[R-traj-context]: orbit/packages/orbit/src/contracts/trajectory.ts:18
[R-wire]: orbit/examples/tools/orbit-gui-service/adapter.py:36
[Y-agent]: gym-anything/agents/agents/base.py:23
[Y-cli]: gym-anything/agents/shared/cli_harness.py:1
[Y-env]: gym-anything/src/gym_anything/env.py:167
[Y-example]: gym-anything/benchmarks/cua_world/environments/libreoffice_calc_env/tasks/basic_formulas/task.json:1
[Y-runners]: gym-anything/src/gym_anything/runtime/runners/registry.py:84
[Y-score]: gym-anything/src/gym_anything/verification/runner.py:33
[Y-single]: gym-anything/agents/evaluation/run_single.py:366
