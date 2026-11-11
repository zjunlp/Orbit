# 多节点

模型与规则见 [design §8](../design.md#8-多节点r4)。

前提：每台机器装好 Orbit、Docker（GPU 机器需 NVIDIA 容器运行时），`orbit doctor` 通过；
**主节点能连到 worker 的一个端口**（单向即可，不需要互相 SSH 或共享存储；推荐 Tailscale，或内网、SSH 隧道）。
集群协议是明文 HTTP，不要暴露到公网。

## 1. 加入 worker

在 worker 上（例：Tailscale 地址 `100.64.0.12`）：

```bash
orbit node expose --listen 100.64.0.12:7718   # 记住设置，daemon 重启后自动恢复监听
orbit node token                              # 打印 cluster token（只给主节点用），复制它
```

worker 开着防火墙时，只对主节点放行该端口，例如 ufw：
`sudo ufw allow from <主节点 IP> to any port 7718 proto tcp`。在主节点上检查：
`curl -s -o /dev/null -w "%{http_code}\n" http://100.64.0.12:7718/cluster/v1/info` 返回 `401` 即网络已通
（超时多半是防火墙丢包）。

在主节点（Agent 所在机器）上：

```bash
orbit node add http://100.64.0.12:7718   # 提示输入 token：粘贴（不回显）后回车
orbit node ls           # online，显示 GPU 数、租约、排队
orbit resources         # 本机 + 每个 worker 的 GPU 与队列
```

token 不走命令行参数。脚本里可以用管道（`ssh gpu2 orbit node token | orbit node add <url> --token-stdin`）
或 `--token-env VAR`。`orbit node token --rotate` 使旧 token 失效，
之后需在主节点重新 `node add`。`orbit node expose --off` 停止监听。

## 2. 数据与凭据

数据集在各节点分别登记，名字相同、路径各自本地：

```bash
orbit data add imagenet /data/imagenet        # 在每台有这份数据的机器上执行
orbit run -d imagenet --gpus 1 -- python train.py      # 挂载到 /data/imagenet（只读）
orbit run -d weights:/models:rw -- ...                 # 指定目标与读写
```

需要 Agent 凭据（`--auth`）的 Run 只放到有同名 auth profile 且装有对应 CLI 的节点，排队原因会写明。
`passEnv` 的变量取自 worker daemon 的环境，放置时不检查，需自行保证各节点一致。

## 3. 放置规则

- 先本机，再按名字顺序的在线 worker；都放不下时排队，`orbit ps` / Web 显示每个节点的原因。
- `--node <name>` 钉住节点。process 后端、`-m` 宿主路径 mount、`--no-snapshot` 的项目只在提交节点运行。
- 代码快照按内容哈希上传一次，之后同样内容的 Run 不再上传。
- 远端 Run 的日志、指标、事件回传主节点（`orbit logs/show`、Web 照常可用）；产物留在 worker，
  Web Artifacts 与 `files/*` 经主节点代理读取，worker 离线时暂不可读。
- `orbit cancel` 转发到 worker；worker 暂时不可达时，取消会在其恢复后送达。

## 4. 故障

| 现象 | 处理 |
| --- | --- |
| `node ls` 显示 offline | 查 worker daemon 是否在运行、`orbit node expose` 是否 listening、网络与端口 |
| 远端 Run 停在 starting，原因 `queued on <node>` | worker 本机资源不够，正在它自己的队列里 |
| worker 永久下线 | `orbit node rm <name>`；其上未结束的 Run 记为 `lost` |
| `bundle exceeds 2048 MiB` | 快照过大：把数据和权重移出仓库，改用 `orbit data` |

bundle 缓存（`~/.orbit/cache/bundles`）不会自动清理；确认没有运行中的 Run 后可以手动删除。

## 5. 同机仿真（开发用）

一台机器上用两个 daemon 模拟两节点，GPU 分开：

```bash
ORBIT_HOME=/tmp/w ORBIT_PORT=7741 ORBIT_NODE=w1 ORBIT_GPUS=2,3 orbit daemon &
ORBIT_HOME=/tmp/p ORBIT_PORT=7740 ORBIT_NODE=p0 ORBIT_GPUS=0,1 orbit daemon &
ORBIT_HOME=/tmp/w ORBIT_PORT=7741 orbit node expose --listen 127.0.0.1:7742
ORBIT_HOME=/tmp/w ORBIT_PORT=7741 orbit node token | ORBIT_HOME=/tmp/p ORBIT_PORT=7740 orbit node add http://127.0.0.1:7742 --token-stdin
```

仿真共用同一个 Docker 与文件系统，不能代替两台真实机器的验证（网络、时钟、不同路径、不同 Docker）。
