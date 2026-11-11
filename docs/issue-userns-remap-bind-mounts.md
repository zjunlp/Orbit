# Issue：Docker daemon 启用 `userns-remap` 时，所有 Run 写 `$ORBIT_OUTPUT` / `$ORBIT_METRICS` 全部失败（bind mount 不可写）

**项目**：Orbit（`@zjunlp/orbit`，v0.1.0，commit `2393da6`）
**环境**：Ubuntu 22.04（内核 5.4.250），Docker 24.0.9，daemon 以 userns-remap 启动，数据目录在 GPFS 挂载上，单机
**日期**：2026-10-08
**报告者环境**：daemon 以宿主 root 运行；Orbit 数据目录在 GPFS 上（`/home/orange-ice/data/orbit`，经 `orbit config data` 设置）

---

## 摘要

在任何一个以**用户命名空间重映射**（`userns-remap`）启动的 Docker daemon 上，所有写
`$ORBIT_OUTPUT` 或 `$ORBIT_METRICS` 的 Run 都会在启动后立刻失败：

```
$ orbit run --image python:3.12-slim -n hello -- python -c '...写指标...'
...
PermissionError: [Errno 13] Permission denied: '/orbit/metrics.jsonl'
```

Run 在实验第一行有效输出之前就 exit 1。**产物收集和指标收集——Run 记录的核心价值——在这类宿主机上静默退化为"什么都收不到"**。日志、退出码、资源租约、Web 界面全部照常工作，这让故障很容易被误诊为用户代码的 bug（我们一开始就被这样误导了）。

## 根因

1. Orbit 把 run 目录 `<dataDir>/runs/<id>/orbit` bind mount 到容器的 `/orbit`（rw）用于收集指标/产物
   （[`packages/orbit/src/runs/service.ts:1339`](../packages/orbit/src/runs/service.ts#L1339)）。
   这些目录是 **daemon** 在提交时用普通 `mkdirSync` 创建的，属主是 daemon 自己的 uid:gid
   （[`service.ts:280-283`](../packages/orbit/src/runs/service.ts#L280-L283)）。
2. Orbit 默认给容器传 `--user <daemon uid>:<daemon gid>`，取自 `userInfo()`
   （[`service.ts:1362-1366`](../packages/orbit/src/runs/service.ts#L1362-L1366)）——文档化的意图是"以
   daemon 用户运行，产物文件归你所有"（README："默认以宿主用户的 uid:gid 运行，产物文件归你所有"）。
3. 但在 userns-remap 下，重映射**叠加在**任何 `--user` 之上：容器里的 uid 0 / 任何 uid 都被解析为
   daemon 的 **remap 池在宿主上的 uid**（本机：165536——`default` remap 条目，可通过 `docker inspect` /
   `/proc/<pid>/uid_map` 看到），而**不是** daemon 用户的真实 uid。daemon 建的 run 目录属主是真实 uid，
   remap 出来的容器 uid 对它们没有任何写权限：对 `/orbit/*` 的每次写入都返回 EACCES。
   容器内看挂载进来的宿主路径全部显示为 `nobody:nogroup`——这是该情况的标志性特征。
4. `--root` 救不了（remap 对 root 照样生效），`--user 0:0` 也救不了（uid 0 在宿主上映射到 remap 基点
   uid，同样不拥有这些目录）。

## 最小复现（不需要 Orbit）

```
$ docker info | grep -i userns      # -> SecurityOptions 里出现 "userns"，确认是 remap daemon
$ mkdir -p /data/runs/demo && touch /data/runs/demo/metrics.jsonl   # 属主为 daemon 用户
$ docker run --rm -v /data/runs/demo:/x --user 0:0 python:3.12-slim \
    sh -c 'id; ls -ld /x; touch /x/f'
uid=0(root) gid=0(root)
drwxr-xr-x 2 nobody nogroup 4096 /x      # <- 宿主属主的目录显示为 nobody:nogroup
touch: cannot touch '/x/f': Permission denied
```

用 Orbit 本身复现：

```
$ orbit config data /home/orange-ice/data/orbit
$ orbit run --image python:3.12-slim -n hello -- python -c \
    'import os; open(os.environ["ORBIT_METRICS"],"a").write("{}")'
# -> state: failed, reason: exit code 1，日志里是 /orbit/metrics.jsonl 的 PermissionError
```

这类宿主机上的每个 Run 行为完全一致；队列/租约/Web 界面都毫无异常。

## 影响（为什么要紧）

- **产物与指标收集全坏**——用户命令只要不写 `$ORBIT_OUTPUT` / `$ORBIT_METRICS`，Run 才能"成功"。
- 失败方式**安静且局部**：日志、退出码、资源记账、会话关联、Web 全都正常，用户看到的是一个看起来
  正常的失败 Run 加一段 Python traceback，而不是一个基础设施问题。多用户 GPU 服务器上 userns-remap
  是常见的加固选择，这是现实的部署环境，不是刁钻场景。
- `orbit doctor` 在这类机器上**全绿**（没有任何检查去验证"容器 uid 能否真的写入 bind mount 的 run
  目录"），所以问题直到第一个 Run 才暴露。

## 修复建议（任选其一或组合）

1. **检测并报告**——最便宜、收益最大的修法：在 `orbit doctor`（和/或 `orbit run` 的 preflight）里，
   从所选镜像起一个一次性容器，向数据目录下 bind mount 的临时目录写一个探针文件——与 `orbit auth test`
   对凭据的做法完全同构。写失败就报告：*"Docker daemon 使用了用户命名空间重映射，Run 的输出无法写入。
   解决办法：X / Y / Z。"* 这能把静默的局部失败变成可操作的提示。
2. **建目录时设 ACL**——在 `submit()`/准备阶段，`mkdirSync` 之后，若检测到 remap 则再执行
   `setfacl -m u:<remap-uid>:rwx,d:u:<remap-uid>:rwx <dir>`。remap uid 可以每节点发现一次（起一个一次性
   容器读 `/proc/<pid>/uid_map`，或读 daemon 的 remap 配置），然后缓存在资源探测里。默认 ACL（`d:`）让
   daemon 今后创建的子目录自动继承写权限——这一点很关键，因为 run 目录树是 daemon（而不是容器）在
   提交时创建的。
   - 报告者已在受影响的宿主机上端到端验证：
     ```
     setfacl -m u:165536:rwx,d:u:165536:rwx /home/orange-ice/data/orbit
     setfacl -R -m u:165536:rwx,d:u:165536:rwx /home/orange-ice/data/orbit/runs
     # -> 下一个写指标+产物的 `orbit run`：succeeded；产物落到宿主，属主 165536
     ```
   - 注意：需要文件系统的 ACL 支持（GPFS/ext4 都没问题）；且 remap uid 必须实际探测，不能假设
     （见下面第 5 节 `/etc/subuid` 的坑）。
3. **换采集通道**——Run 结束后从容器文件系统收集指标/产物（如 `docker cp` 或 exec 尾读），而不是
   bind mount 一个 daemon 属主目录做实时写。这能完全绕开 remap，代价是 Web 失去实时指标流（以及指标
   的 `orbit logs` 式实时尾随）——这也是方案 2 更可取的原因。

给方案 1/2 的提醒：remap uid **不能**只从 `/etc/subuid` 推导（本机 daemon 实际用的 remap profile 是
`default` 而非 daemon 用户自己的条目——`/etc/subuid` 里写的是用户池 100000，实际映射基点是 165536）。
唯一可靠的来源是探针容器的 `/proc/self/uid_map`（一行：`0 <base> <count>`），便宜且可随现有的节点资源
探测一起缓存。

## 当前用户侧的手动规避

```bash
# 探测 remap uid
docker run --rm --user 0:0 python:3.12-slim cat /proc/self/uid_map   # -> "0  165536  65536"
# 给它 orbit 数据目录的写权限（默认 ACL 覆盖 daemon 今后建的 run 目录）
setfacl -m u:<remap-uid>:rwx,d:u:<remap-uid>:rwx <dataDir>
setfacl -R -m u:<remap-uid>:rwx,d:u:<remap-uid>:rwx <dataDir>/runs
# 重启 daemon（或直接让新 Run 用继承的 ACL）后重跑
```

## 其他观察（较小、相关）

- 排查中还发现：本环境的*前台* `docker run` 输出会被某些沙箱化的 shell 吞掉（stdout 到 /dev/null），
  所以如果 CLI 失败路径里有一条"容器到底有没有真的写过 `$ORBIT_METRICS`"的检查，真实原因会早得多
  就打出来。不是 Orbit 的 bug，但对 doctor 在受限宿主机上的 docker 检查设计有参考价值。
- 本机的 `orbit run --root` 同样写不进挂载（remap 对 root 也生效）。README 里"--root 以 root 运行"
  是用户在这种情况下的自然尝试，但它无效；doctor/preflight 的报错信息覆盖这一情况，能替下一个用户
  省一小时。
