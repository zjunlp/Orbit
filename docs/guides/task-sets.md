# 划分并冻结评测任务集

先划分进化集、准入集和终测集，再使用冻结的任务文件提交作业：

```sh
orbit bench split <benchmark> --evolve 0.6 --gate 0.2 --final 0.2 --seed 42 --stratify suite --out /path/new-split
orbit bench run <benchmark> --tasks-file /path/new-split/evolve.txt -m <configuration>
orbit bench run <benchmark> --tasks-file /path/new-split/gate.txt -m <configuration>
```

比例是 0–1 之间的小数，三者之和必须为 1；种子是非负整数。只划分当前适配器列出的 supported 任务，
unsupported 数量记入清单。`--stratify suite` 使用任务的 `suite` 标签，没有标签时沿用 coverage 的任务 ID
前缀规则。省略该选项时，对全部支持任务统一划分。

算法用种子与任务 ID 的 SHA-256 排序，不依赖适配器列举顺序或平台随机数实现。先用最大余数法确定
三个集合的总任务数，再按 suite 分配配额并调整余数以满足这些总数；小套件不保证每个集合都有任务。
相同种子、支持任务及 suite、比例和 benchmark 元数据产生相同文件和清单。允许比例为零；小任务集也可能
取整出空集合，空文件不能用于提交作业。

`--out` 是 **daemon 主机上**的新目录，其父目录必须存在，目标目录必须不存在，且位于 Orbit home/data
之外。daemon 在私有临时目录写完后发布，不覆盖已有文件。新文件为 0600，目录为 0700。

```text
new-split/
  evolve.txt
  gate.txt
  final.txt
  split.json
```

`split.json` 记录算法版本、benchmark 登记名、身份与声明版本、可用 Git commit/dirty 标记、执行设置摘要、
种子、比例、分层方式、支持任务清单摘要，以及每个任务文件的 SHA-256、任务数和任务集摘要。
不记录输出目录或生成时刻，因此可以直接比较两次生成的内容。任务集摘要沿用配置视图的算法：去重排序后
计算规范 JSON 的 SHA-256 前 12 位；任务文件哈希使用完整 SHA-256，覆盖原始 UTF-8 字节和换行。
未声明的版本和非 Git 来源保留为 null；dirty 标记不等于冻结了完整源码、数据、镜像标签或模型权重。

## 用任务文件提交

`--tasks-file` 与 `-t/--task` 互斥。文件是 UTF-8，每行一个完整任务 ID；支持 BOM 和 CRLF，忽略空行、
去除行首尾空白，拒绝空选择和重复 ID，不把 `#` 当注释。任务文件限 8 MiB；清单限 1 MiB；读取只接受
普通文件并在分配内存前检查大小。样本计划仍需与所选任务一致，不能借任务文件选入计划外任务。

CLI 在本机读取文件并把内容快照交给 daemon。旁边存在 `split.json` 时，必须使用它声明的文件名并匹配
原始文件哈希；daemon 再核对内容哈希、任务集摘要、任务数、benchmark 身份/版本/设置及当前支持任务清单，
并按清单的种子、比例与分层重新计算划分，核对三个集合的文件摘要。
改变文件、换行、选择或冻结清单后若不一致，作业和 trial 都不会创建。保留文件与其清单在同一目录，
不要通过修改旧清单改变数据切分；需要调整时生成一个新目录。

也可使用没有相邻清单的普通任务文件；它会记录文件哈希和所选任务摘要，但没有 split 来源绑定。
复制到另一台机器使用时，应保留清单；如果 benchmark 登记、路径或执行设置不同，需要在目标环境重新
生成切分并核对任务集，不把相同任务 ID 当作相同环境的证明。

每个新作业保存 `taskSet`，无论任务来自文件、`-t`、样本计划还是默认全部支持任务。文件提交还保存
`taskFile` 的哈希和可选冻结清单，不保存原始文件内容或客户端路径。任务文件仍归用户管理，不新增
“任务集”登记、数据库实体或状态机。删除用户文件不会改变已提交作业的选择和来源记录。

通过任务文件提交的作业不能在归并时追加新任务；原任务矩阵内的重试归并仍可进行。普通作业追加任务时
更新任务集摘要。旧作业保持兼容，不在读取时重写；配置视图优先使用已保存的摘要，旧作业沿用原计算方式。

API 为 `POST /api/v1/benchmarks/:name/split`；`POST /api/v1/bench/jobs` 可带 `tasksFile` 内容快照及预期
`taskSet`。预期摘要不匹配时拒绝。现有 typed client 和 Web API helper 使用相同契约；此包没有增加
Web 划分界面，也不实现后续 E2/E3 的准入判定。
