# 进化判定核心（E2）

E2 提供纯内存判定接口，供后续 E3 的 daemon、策略文件与 CLI 接入使用。当前可在仓库内调用
`bench/gate.ts` 的 `gate(parentRevision, childRevision, policy, evidence)`；统计函数通过已有
`@zjunlp/orbit/metrics` 导出，Web 可复用。此包尚未提供 `orbit bench gate` 或判定记录 API。

## 输入与证据

`GatePolicy` 使用进化方案中的字段：`version: 1`、`alpha`（默认 0.05）、`spending: inverse-square`、
`min_paired_tasks`（默认 30）、`min_coverage`（默认 0.9）、`change: bundle-only`、`gate`、`guard`、
`final` 与 `cost`。每个任务集给出稳定 benchmark 身份、任务文件名和原始 UTF-8 字节的 SHA-256。
身份依次取登记标签、适配器声明、E1 冻结清单；都没有时使用登记名。
守护集 `margin` 默认 5，单位与指标相同；默认 `score` 是满分百分比，因此为 5 个百分点。

另外可冻结 `metric`（默认 score）、`pass_value`（缺省用指标范围的最优端点）和
`max_invalid_increase`（默认 0.05）。最后一项是子版本不可用样本率相对父版本允许增加的绝对比例，
包括 invalid、unknown、pending 和有效性虽有效但未记录指标的样本；超限属于前提不足。
没有指标范围且未指定 pass_value 时，不生成通过/失败任务名单。
`alpha` 支持 1e-12 至 0.25，配对任务数至少为 2；文件读取和 YAML 解析属于 E3。

`GateEvidence` 由调用方提供，包含：

- `jobs`：所选版本、全部祖先和已有候选评测的作业元数据。
- `reports`：明确指定的不可变报告修订；不从当前 Trial 或 Run 状态读取分数。
- `taskSets`：`{ file, content }` 内容快照，校验其原始文件哈希。
- `selections`：每个集合的父/子报告引用 `{ job, revision, method }`。集合名为 `gate`、`guard:0`、
  `guard:1` 等；终测按 Agent 分开，例如 `final:0:codex`。缺少或冲突的引用不自动择优。

调用方必须提供完整的相关历史；核心无法证明未提供的历史不存在。输入应满足共享契约，核心进一步检查
元数据摘要与语义一致性。输出不修改输入，也不读文件、数据库、环境变量或当前时钟。

新作业必须保存 E1 的 `taskSet` 和 `taskFile.sha256`，与策略内容快照一致。报告的 planDigest、
指标、聚合器、官方规则及所选配置的完整样本矩阵必须匹配作业。配置修订 basis 摘要也会重新核对。
基础项必须已知且除 bundle 摘要外一致，包括 Agent、模型、思考强度、auth 类型、CLI 版本、benchmark
版本/运行条件、资源预算、样本计划和检查点设置。dirty 来源或 approximate 配置不给出可比结论。

## 判定

先按相同 sample ID 配对双方都有效且有指标值的样本，再在每个 task 内平均，最后对任务均值的配对差
计算标准误。不会把一个任务的多个 seed 当作多个独立任务，也不会把父 seed 1 和子 seed 2 配成一对。
指标方向统一为“正值表示子版本更好”，同时保留原指标的父/子值。

`lowerBound` / `upperBound` 使用任务级配对差的 Student-t 单侧区间，`n-1` 自由度；少于两个任务或
缺少标准误时返回 null。原 `diff.ci` 仍是既有显示用 95% 正态区间，判定以 `checks.lower/upper`
及当前消耗的 alpha 为准。二值任务均值处于指标范围两个端点时，额外记录精确 McNemar 的单侧与双侧
p 值作为对照；多 seed 均值不是二值时不伪造二值检验。McNemar 不替代主配对区间。

- 准入集下界严格大于 0，才确认提升；上界严格小于 0，才确认退步；其余为证据不足。
- 每个守护集下界严格大于 `-margin` 才通过；上界严格小于 `-margin` 才拒绝；跨过边界时为证据不足。
- 完整成本比值不得超过墙钟和 token 上限，默认均为 1.5。父成本为零、子成本为正会失败；两者均为零按相同成本处理。

前提检查不通过时，整体为 `insufficient`。前提齐全后，必需检查中任一确定失败则 `reject`；全部通过
才 `accept`，其他情况仍为 `insufficient`。等级依次为 `in-domain`、存在并通过守护集的 `cross-domain`，
以及额外终测包含第二种 Agent 且全部通过的 `transferable`。终测检查不影响原有准入决定，只影响等级；
终测 Agent 自己的血缘也参与泄漏剔除。

子版本及祖先的 `informedBy` 引用按 benchmark 身份和任务 ID 从准入/守护/终测集中剔除；未知引用、
缺失祖先、环或冲突血缘保留明确的不足原因。剔除后的集合决定覆盖率分母，原始数量和剔除来源也写入输出。
`regressions` 列出原始指标上父版本通过而子版本失败的任务。

第 k 轮使用 `alpha * 6 / (pi² * k²)`。轮次由同一准入文件哈希、同一根血缘下已形成报告的不同子版本
推导，包含兄弟候选，避免分支重置预算；按首次作业提交时间及作业 ID 排序。原始父版本不算一轮，
同一版本的重评分/补建报告不重计。没有额外账本。调用方应预先固定每个候选的证据，不能借重评分择优。

输出包含三值决定、等级、逐项原因、任务退步列表、消耗的轮次/alpha、规范化策略摘要、报告引用、
任务文件/任务集摘要与剔除来源，便于后续保存和复核。

## 成本快照与兼容性

新报告的每个配置可带 `costs`：逐个 solve Run 保存任务归属、归属是否完整、执行墙钟秒数和原生 token
计数。共享批次去重，失败/先前重试也计入；缺失的 Run 保留 null，不能从列表中消失。
墙钟为 `endedAt - startedAt`，要求终态、清理完成且时间有效；不包含排队和清理等待。token 使用
`input + output`，缓存和 reasoning 已包含在总量中，不再次相加，也不估算价格。

报告 builder 复制 token 值；当前 Run 后续补记不会改写已有报告。成本变化可生成新报告修订，旧修订保留。
旧报告没有逐 Run 成本时，或存在缺失 token/时间、未知批次归属、共享 Run 跨越被剔除的任务，成本项为
`not_checked`，不会被当成通过。没有新增成本账本，现有 daemon 写报告及 client/CLI/Web 读取路径不变。

## 验证范围

测试覆盖冻结证据、不可比条件、泄漏闭包、覆盖率、不同 seed、成本缺失/去重、守护集三值语义和终测等级。
数值与独立 SciPy 参考交叉核验；固定种子的合成二值配对模拟检查零差异的接受率、300 个任务下的提升
检出率，以及 12 个独立轮次的累计接受率。它们是开发验证，不是实际 benchmark 上进化有效的证据。
配对 t 推断有分布/近似假设；alpha 消耗也要求每轮检验有效。独立合成轮次的结果不证明任意自适应反复
使用固定准入集都能控制错误率。真实 A/A、破坏性与泄漏校准属于 E6。

统计依据：[NIST 配对观测](https://itl.nist.gov/div898/handbook/prc/section3/prc311.htm)、
[statsmodels 精确 McNemar](https://www.statsmodels.org/stable/generated/statsmodels.stats.contingency_tables.mcnemar.html)、
[NIST 不完全 beta 函数](https://dlmf.nist.gov/8.17)。
