# GUI evaluation in Web

运行 `orbit web --open`，进入 **Bench**。先由维护者准备并登记环境与策略；Web 不安装 BrowserGym 或自动实现模型策略。
目前 BrowserGym 适配器只覆盖五个 MiniWoB 接入校准任务；详见[准备指南](../../examples/bench-adapters/browsergym/README.md)。

## Create an evaluation

选择 **New evaluation**，或在已有评测中选择 **Copy and create**：

1. **Environment & tasks**：选择已登记的环境和支持的任务。观察方式、动作空间、步数上限等预设条件只读。
2. **Methods**：配置方法，复制已有评测的方法，或导入方法 JSON。BrowserGym 声明只支持 external 和 empty；密钥应由 daemon 环境提供，这里只填写变量名。
3. **Review & start**：检查任务 × 方法 × 重复次数、名称和超时。点击 **Start evaluation** 后进入详情。

登记成功不表示浏览器或模型连接已经检查。复制使用当前登记，页面提示其与来源配置的差异；新 job 固定登记配置，但不会冻结路径下的策略代码或远端模型。
**New evaluation from these tasks** 复制筛选后的任务，以及原评测的全部方法和重复次数；不是只重跑特定 seed。

## Review results

详情提供 **List / Matrix**、任务搜索、方法和 seed 筛选。对于声明二元成绩的适配器，**Task not completed** 表示有效零分；**Evaluation issues** 表示无效、未知或包含问题的评测。标量 benchmark 保留原分数，不推断成功阈值。
方法均值先对任务内的有效重复实验平均，再对任务等权平均；无效、未知和未完成 trial 不当作零分。

进入 Trial 的 **Trajectory**：左侧选择步骤，中间查看 **Before / After**，右侧显示动作和反馈。
初始观察为 step 0；第 k 个动作连接截图 k−1 和截图 k。支持左右键、进度条、**Copy step link**、**100% / Fit** 和原图；输入控件获得焦点时不抢占快捷键。
只加载当前截图，步骤列表窗口化；JSON 预览上限为 2 MiB。缺图、截断列表或格式不支持时有明确提示，原始文件与 Markdown 仍可访问。
旧 GUI 记录继续以 Markdown 展示；模型对话、每步时延和费用只有实际记录后才能展示，当前 BrowserGym 不采集这些字段。

BrowserGym 的 **Recheck evidence** 只验证保存的奖励、轨迹和哈希；不重新执行 Agent、不回放浏览器。重查过程中保留历史证据入口，结果历史与当前核验状态分开显示。

## Compare methods

Bench 中选择评测后点击 **Compare**，选择 **Baseline** 和 **Compare with**，按改善、退步或缺少配对结果筛选任务。
条件区显示保存的版本、配置、任务集和预算差异；旧记录缺失字段标记为 **Not recorded**。任务筛选不改变整体统计，配对差仍使用共享指标函数。
点击任务分数进入对应方法的 trial 列表，再选择 seed 查看轨迹。

页面保持单用户 daemon 的访问方式；实时画面、环境恢复和多用户权限不属于该功能。
