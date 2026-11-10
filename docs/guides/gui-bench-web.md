# GUI evaluation in Web

运行 `orbit web --open`，进入 **Evaluations**。先由维护者准备并登记环境与策略；Web 不安装 BrowserGym 或自动实现模型策略。
BrowserGym 适配器覆盖固定版本注册的 125 个 MiniWoB++ 任务；详见[准备指南](../../examples/bench-adapters/browsergym/README.md)。

## Create an evaluation

选择 **New evaluation**，或在已有评测中选择 **Copy and create**：

1. **Environment & tasks**：选择已登记的环境和支持的任务。观察方式、动作空间、步数上限等预设条件只读。
2. **Configurations**：设置运行器、模型、思考强度和可选提示词 / skills 包，选择策略，复制已有评测配置，或导入配置 JSON。BrowserGym 声明支持 external、empty 和已注册 CLI Agent；密钥应由 daemon 环境提供，这里只填写变量名。
3. **Review & start**：检查任务 × 配置 × 重复次数、名称和超时。点击 **Start evaluation** 后进入详情。

登记成功不表示浏览器或模型连接已经检查。复制使用当前登记，页面提示其与来源配置的差异；新 job 固定登记配置，但不会冻结路径下的策略代码或远端模型。
**New evaluation from these tasks** 复制筛选后的任务，以及原评测的全部配置和重复次数；不是只重跑特定 seed。

## Reuse evaluation configurations

侧栏 **Configurations** 打开 **Evaluation configurations**，查看已运行过的配置、内容版本和相同条件下的结果。
页面从历史评测按配置名称聚合；改变模型、思考强度或配置包会产生新配置版本，不表示方法进化。
Trial 的 **Adjust configuration** 复制当前配置和任务选择，供调整后发起新评测。
独立 Method 概念尚未设计；导入文件与 CLI 继续使用现有 `methods` / `--method` 名称。

## Review results

详情提供 **List / Matrix**、任务搜索、配置和 seed 筛选。对于声明二元成绩的适配器，**Task not completed** 表示有效零分；**Evaluation issues** 表示无效、未知或包含问题的评测。标量 benchmark 保留原分数，不推断成功阈值。
每个配置的均值先对任务内的有效重复实验平均，再对任务等权平均；无效、未知和未完成 trial 不当作零分。

进入 Trial 的 **Trajectory**：左侧选择步骤，中间查看 **Before / After**，右侧显示动作和反馈。
初始观察为 step 0；第 k 个动作连接截图 k−1 和截图 k。支持左右键、进度条、**Copy step link**、**100% / Fit** 和原图；输入控件获得焦点时不抢占快捷键。
只加载当前截图，步骤列表窗口化；JSON 预览上限为 2 MiB。缺图、截断列表或格式不支持时有明确提示，原始文件与 Markdown 仍可访问。
坐标点击/移动以圆点叠加在截图上，拖拽显示起止位置与连线；输入文本与动作错误显示在图下。叠加使用原图像素坐标，缩放时同步缩放；无法识别的原版动作仍保留原文，不猜测坐标。

CLI 桥记录动作调用 id；右侧 **Agent at this step** 仅按返回结果中的精确 id 和 step 显示关联的 thinking/tool_call/tool_result，不把相邻工具结果归入同一步。
未记录 id、会话缺失或旧 external 轨迹时明确显示无关联，仍可打开完整 Agent session。初始帧和结束流程的 noop 没有伪造的会话对齐。
模型每步时延和费用只有实际记录后才能展示，当前 BrowserGym 不采集这些字段。

BrowserGym 的 **Recheck evidence** 只验证保存的奖励、轨迹和哈希；不重新执行 Agent、不回放浏览器。重查过程中保留历史证据入口，结果历史与当前核验状态分开显示。

## Embodied episodes

原生具身任务从 [具身快速开始](embodied-quickstart.md#3-在-web-回看-trial) 进入 Trial。

独立的 MP4、WebM 和 Ogg 视频产物可在 Trial 的文件页播放，预览上限为 64 MiB。超限文件可下载。

adapter 可在 `review.files` 声明 `kind: "episode"`、`fallback: "json"`。索引为
`EpisodeTrajectory` 版本 1（`packages/orbit/src/contracts/trajectory.ts`）：`kind`、`goal`、
`actionNames`、`proprioNames`、`cameras`、`samples` 和 `chunks`。媒体路径相对索引所属 Run 的输出根目录。具身 verifier 可以通过 `mediaPhase: "solve"` 引用同一 Trial 的 Solve 产物。
索引预览上限 2 MiB，高频原始数组和视频仍保留为产物，不进入数据库。

- `samples` 按严格递增的秒时间戳排列，包含动作/本体状态数组、reward、terminated/truncated，以及可选 late/stall。
  数组维度必须与 channel names 一致。
- 每路 camera 选择时间戳图片列表或一个视频（可带 offsetSec 与 timeMap）；移动统一时间轴会同步选择各路画面。当前文件 API 无视频 MIME/Range 支持，Web 对 MP4/WebM/Ogg 提供每个 episode 合计最多 64 MiB 的本地预览（按视频相机数量均分预算）；更大视频提示下载，不在内存中无限加载。
- action chunks 记录起止秒与可选标签；点击边界可跳转。动作/关节曲线使用 uPlot，悬停可选择对应时间。
- producer/trust 与视频 live/render 来源如实显示，缺失时标为未记录。

RoboTwin Trial 的 **Episode timeline** 可以拖动到任意控制步，按关节或夹爪查看目标动作和实际状态，并跳转到动作批次查看推理耗时。
画面取自动作前，关节状态和奖励取自动作后，时间轴按录像帧率排列。新运行保存头部与左右腕部三路录像，历史运行可点 **Recheck evidence** 从已保存的轨迹生成时间轴，回看当时录下的相机。
LIBERO 复用 **Episode timeline**，展示已录制的外部视角、末端执行器位姿、夹爪状态、动作和奖励。时间轴从第一条策略动作开始，达到控制步上限的试验会标记为 **Truncated**。

EFE MetaWorld+ standard/2.1 的 Harbor trial 会在评分后自动生成 `orbit-trajectory.json`：原生 journal 调用边界、已执行动作曲线、最终 reward 和 render 视频。
**Agent at this time** 显示按调用时间关联的会话；完整度标注会话完整、只有环境或记录截断。原版 sidecar 没有保存 proprioception 时不显示身体状态曲线。
导入失败会显示 issue，分数仍由原版 verifier 决定。索引和媒体都是保存产物的复盘视图，不控制仿真、不恢复状态。

CLI GUI 由共享服务承载，BrowserGym 使用原高层动作字符串，CUA-Lite MiniWoB 使用自己的 canonical JSON tool call；权限和时间限制在 Conditions 中显示。
`agentTask.tools` 声明的 MCP 由 Orbit 自动接入支持的 Agent；Details 的 `mcpToolsUsed` 只列会话中真正调用过的 MCP 工具。

## Compare configurations

Evaluations 中选择评测后点击 **Compare**，选择 **Baseline** 和 **Compare with**，按改善、退步或缺少配对结果筛选任务。
条件区显示保存的版本、配置、任务集和预算差异；旧记录缺失字段标记为 **Not recorded**。任务筛选不改变整体统计，配对差仍使用共享指标函数。
点击任务分数进入对应配置的 trial 列表，再选择 seed 查看轨迹。

页面保持单用户 daemon 的访问方式；实时画面、环境恢复和多用户权限不属于该功能。
