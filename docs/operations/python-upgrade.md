# Python 重构版本的本机升级与回退

适用：Linux、本机单管理员、从旧 Python 版本升级到包含共享执行内核、Projects v6 与租约 v2 的版本。
先完成代码审阅、回归和 PR 合并，再切换部署。本流程不包含 TypeScript 重写，也不重新运行 benchmark。
操作记录与实际验收见 [清理及升级记录](../changes/20260930-cleanup-and-upgrade-c83f21.md)。

## 1. 核对当前服务和状态范围

记录旧代码 SHA、依赖锁、启动命令、端口、镜像以及 `AGENT_INFRA_NODE_STATE` 等路径配置。
通过 `ps`、`ss -ltnp` 和服务管理器确认具体进程身份。不要输出认证令牌或完整环境变量。

需要备份的内容包括：

- Controller/Web 的整个 `--state-dir`：Projects、控制状态、Records 数据库及 blobs、任务快照、
  工作区、归档、进程身份、旧 catalog 和 benchmark 工作台登记信息。
- 工作台指向的各 benchmark 批次目录，包括其原生运行目录与独立 state；只备份 Web 的 state 不够。
- 已登记的科研项目工作区；大型外部只读数据挂载另行记录不可变版本和位置，不声称随 SQLite 一起保存。
- 节点共享租约目录：`${XDG_STATE_HOME:-$HOME/.local/state}/agent-infra-node`，或实际的
  `AGENT_INFRA_NODE_STATE`。首次升级尚不存在时记录这一事实。
- `/tmp/agent-infra-controller-UID/owner.json` 的恢复标记。锁文件本身不是运行状态；恢复前必须停掉持锁进程。

本机当前路径可在 [直接实验说明](direct-experiments.md) 配置。不要把备份或认证文件提交进 Git。

## 2. 停止接收新任务，排空旧执行

暂停 CLI/MCP/批量提交入口，让已有任务完成；需要取消时使用对应 Run/benchmark 的取消命令，
再检查其归档和清理结果。直接杀掉 Agent 或删除数据库租约不能证明容器已经退出。

逐个检查实际状态根：

- `controller/control.sqlite3` 和各批次 `state/benchmarks/control.sqlite3` 中的 command document
  均为 `state=finished`，没有等待提交、隔离或收集中任务。
- 每个 `leases/leases.sqlite3` 中 `SELECT state,COUNT(*) FROM leases GROUP BY state` 只有
  `released`；共享节点库也必须检查。未释放项按其原生 ID 对账，不手工改为 released。
- 对照 `ownership.json` 与 Docker 名称、标签确认本项目容器已经清理；保留其他项目容器。
- 停止旧 Controller、批次 worker 与 Web，确认其进程退出及端口关闭。Web 也可能写 catalog/状态，
  因此不能在它仍运行时把普通文件复制当成一致备份。

如果 host lock 标记为 dirty，但进程已退出且状态已结束，保留该标记，使用原 `--state-dir`
启动新版让现有恢复机制对账；不要删除标记来绕过检查。

## 3. 一致备份并验证可读性

只在上述写入者已停止、租约已排空时执行普通文件归档。在线 SQLite 备份需要使用 SQLite backup API；
复制一个正在写入的 `.sqlite3` 文件会遗漏 WAL 事务，不能代替完整状态备份。

```sh
umask 077
INFRA_BACKUP=/absolute/private/infra-backups/upgrade-YYYYMMDD-HHMMSS
mkdir -p "$INFRA_BACKUP"
chmod 700 "$INFRA_BACKUP"
# 替换为核对后的实际路径；可选不存在的节点账本不传给 tar。
tar -cpf "$INFRA_BACKUP/state.tar" -C / \
  absolute/path/to/personal-state \
  absolute/path/to/benchmark-results \
  absolute/path/to/research-workspace
sha256sum "$INFRA_BACKUP/state.tar" > "$INFRA_BACKUP/state.tar.sha256"
sha256sum --check "$INFRA_BACKUP/state.tar.sha256"
```

同时写一份私有 manifest：旧 revision、备份源绝对路径、启动参数、各库 schema、Run/租约计数、
不存在的可选目录、归档摘要和时间。对归档解出一份临时副本，在副本上执行 SQLite
`PRAGMA integrity_check`；检查每个归档成员的大小/摘要。原始文件和备份都保留，暂不清理旧数据。

## 4. 切换代码与服务

将部署 checkout 快进到已审阅的合并提交，使用锁文件安装及构建：

```sh
uv sync --locked --inexact
pnpm install --frozen-lockfile
pnpm build
```

`--inexact` 保留已经单独安装的适配包；核心依赖仍按锁文件同步。升级前记录这些适配包的版本和
本地源码位置，不把它们当作未知依赖直接卸载。独立 benchmark 运行虚拟环境也要保留。

保留原状态目录与预算，以原服务管理方式重启。原先只有 Web 的部署，可按已授权范围启动 Controller：

```sh
uv run --locked agent-infra controller serve \
  --state-dir /absolute/personal-state --cpu 1 --memory-gib 2 --port 8766
uv run --locked agent-infra web \
  --state-dir /absolute/personal-state --port 8765
```

Web 重启会更换登录令牌；从新进程输出获取登录链接，不把链接写进公开记录。
Projects 在首次写入时升级，不需要修改历史 benchmark 分数或回填旧轨迹。
CLI 的 `run status` 与 Web 历史读取不会启动旧任务。

## 5. 升级后检查

1. 核对服务 PID、命令、代码路径、端口；使用 Controller 健康接口确认 ready。
2. 读取原科研 Run 的事件和产物，以及原 ASI 60 题批次。确认数量、分数、归档摘要没有变化。
3. 在明确范围内提交一次短 CPU 直接命令；检查输出、指标、代码快照、最终状态和租约释放。
   使用独立验收项目，不修改用户的已有研究代码。需要界面比较时顺序运行两次确定性示例。
4. 用浏览器验证登录、项目复盘、指标、旧 execution 深链接和 benchmark 详情；记录真实运行与
   浏览器 fixture 验证的区别。确认只清理本次创建的容器。

## 6. 回退

先停止新版提交和写入，完成或取消其任务并确认清理。将升级后的整个状态目录另行保留，
避免覆盖升级后产生的结果。随后切换到备份 manifest 中的旧 revision，按旧锁文件恢复依赖和 Web 构建，
把已校验的备份恢复到原路径，恢复旧启动参数后验证历史读取。

旧节点库原本不存在时，应在所有新版任务结束后把新建节点账本移到回退保留目录；不能留着新库又
启动旧调度形成两套分配。不要在活跃进程旁替换 SQLite 文件或 host lock。
`pre-python-refactor-20260929` 只保存代码；旧程序不认识 Projects v6，单独 checkout 标签不足以回退。
