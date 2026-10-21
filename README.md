<p align="center">
  <img src="assets/orbit-logo.png" alt="Orbit" width="480">
</p>

<h1 align="center">Orbit: Learn and Evolve in Any Environment.</h1>

<p align="center">Give agents a place to experiment — and experience to learn from.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zjunlp/orbit"><img src="https://img.shields.io/npm/v/%40zjunlp%2Forbit" alt="npm version"></a>
  <a href="LICENSE"><img src="docs/assets/license-mit.svg" alt="License: MIT"></a>
  <a href="docs/status.md"><img src="docs/assets/status-development.svg" alt="Status: Early development"></a>
</p>

<p align="center"><a href="#quickstart">Quickstart</a> · <a href="#agent-integration">Agents</a> · <a href="#benchmarks">Benchmarks</a> · <a href="#documentation">Documentation</a> · <a href="#roadmap">Roadmap</a> · <a href="https://github.com/zjunlp/Orbit/actions/workflows/ci.yml">CI</a></p>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

---

**Orbit is experiment infrastructure for agents.** Our vision is to let agents run experiments
across environments — from code, training and evaluation in the digital world to simulation and
embodied experiments in the physical world. By collecting trajectories and analyzing actions,
outcomes and failures, agents can refine their methods and capabilities over time.
**Every experiment should become experience for the next.**

Today, Orbit gives agents such as Codex and Claude Code Docker execution, GPU / CPU / memory
scheduling, and records of code, logs, metrics, outputs and agent sessions. The agent plans,
analyzes and iterates; Orbit provides execution and evidence. Embodied device support and
automated trajectory learning are future directions; see the [roadmap](#roadmap).

<p align="center"><strong>Run → Capture trajectories → Analyze → Improve → Run again</strong></p>

<a id="features"></a>

## ✨ Why Orbit

| Capability | What it gives you |
| --- | --- |
| 🧪 **Reproducible execution** | Docker isolation, code snapshots and resource limits for experiments you can inspect. [Runs & sweeps](#usage) |
| ⚙️ **Shared resource scheduling** | GPU, CPU and memory leases that account for external use, with clear queue reasons. [Multiple machines](#several-machines) |
| 🧭 **Trajectories for review** | Agent sessions alongside code diffs, logs, metrics, artifacts and notes to inform the next iteration. [Web UI](#web-ui) |
| 🤖 **Your existing agents** | Shared skills for Codex, Claude Code, dsh and pi; in-container agents for Codex / Claude Code. [Agent integration](#agent-integration) |
| 📊 **Verifiable evaluation** | Task × method × seed jobs with execution and score validity tracked separately; Harbor, ASI and external adapters. [Benchmarks](#benchmarks) |
| 📱 **Progress wherever you are** | Local Web review, Feishu cards and read-only queries, plus DingTalk, WeCom, Slack and webhooks. [Notifications](#notifications) |

<a id="quickstart"></a>

## 🚀 Quickstart

<a id="requirements"></a>

**Prerequisites:** Linux, Node.js 24.18+ (24.x), Git and Docker usable by your user without `sudo`.
GPU experiments also need NVIDIA drivers and the NVIDIA Container Toolkit or CDI. CPU experiments need no GPU.

<a id="installation"></a>

### 1. Install Orbit

Install the [npm package](https://www.npmjs.com/package/@zjunlp/orbit):

```bash
npm install -g @zjunlp/orbit
orbit doctor
```

The package includes the CLI, daemon, Web UI and shared skills. No source checkout or build is needed.
To try Orbit without a global installation, use `npx -y @zjunlp/orbit@latest doctor`.

<details>
<summary><strong>Update Orbit</strong></summary>

```bash
npm install -g @zjunlp/orbit@latest
orbit daemon --stop
orbit doctor
```

Stopping the old daemon lets the next command start the updated version; running containers are reattached.

</details>

<details>
<summary><strong>Build and install from source</strong></summary>

Requires pnpm 10. Use this to install changes that are not yet on npm:

```bash
git clone https://github.com/zjunlp/Orbit.git
cd Orbit
corepack enable
pnpm install --frozen-lockfile
pnpm pack:release
orbit_version=$(node -p 'require("./packages/orbit/package.json").version')
npm install -g "./dist/zjunlp-orbit-${orbit_version}.tgz"
orbit doctor
```

`pack:release` builds the CLI, daemon, Web UI and shared skills. To run from source or contribute, see [Development](#development).

</details>

<a id="first-use"></a>

### 2. Run your first experiment

```bash
cd ~/my-project                 # your Git repository
orbit resources                 # available resources and the queue
orbit run --image python:3.12-slim --cpus 1 --mem 1 -n hello -w -- python -c 'print("hello from orbit")'
orbit ps -a                     # inspect run records
orbit web --open                # review in your browser
```

Orbit options go before `--`; the experiment command goes after it. By default, it runs in `/workspace`
on a snapshot of your Git repository, including uncommitted, non-ignored files. The first command
that needs the daemon starts it automatically on `127.0.0.1:7717`, or a free port if occupied.
State lives in `~/.orbit`; large artifacts can use a [separate data directory](#configuration).

### 3. Put your agent to work

Once the skills below are installed, ask your agent:

> Use Orbit to run this experiment. Check resources, try several seeds, compare metrics and failures, and attach conclusions to each run.

<a id="agent-integration"></a>

## 🤖 Agent integration

Install your agent CLI, then choose its host plugin:

```bash
# Choose your agent
orbit plugin install claude
orbit plugin install codex
orbit plugin install dsh --profile headless
orbit plugin install pi
```

Restart the agent to load `orbit` for experiment execution and review, and `orbit-bench` for benchmark adapters, resources and validation.

| Agent | Host skills | In-container execution & session capture |
| --- | --- | --- |
| Codex / Claude Code | ✅ | ✅ |
| dsh / pi | ✅ | Not yet implemented |

See the [plugin guide](plugin/README.md) for local and npm installation, updates and removal.
dsh requires pnpm and an explicit profile with its skills service. Agents need network access to the local daemon; MCP is not implemented yet.

<details>
<summary><strong>In-container agents and credentials</strong></summary>

A run can execute Codex or Claude Code inside its container (for agent experiments and benchmarks).
Orbit mounts the CLI installed on the host and injects credentials from a profile:

```bash
orbit auth add codex --harness codex --kind login     # `codex login --device-auth` in a private home
orbit auth add gpt --harness codex --kind api-key --key-env OPENAI_API_KEY
orbit auth add claude --harness claude-code --kind login --key-stdin    # paste a `claude setup-token` token
orbit auth add relay --harness claude-code --kind relay --base-url https://relay.example --key-env RELAY_KEY
orbit auth add claude --harness claude-code --kind relay --from-env    # take key, URL, models from env / Claude settings
orbit auth list
orbit auth test claude          # a real small run: the agent must answer
orbit run --auth claude --image python:3.12-slim -- claude -p --dangerously-skip-permissions "…"
```

Secrets are read from stdin, an environment variable or a file, never from arguments. Profiles are
stored in `~/.orbit/auth.json` (mode 0600) and secret values are redacted from run logs. Use
`--host-network` on a profile when the agent must reach a proxy on `127.0.0.1`.

</details>

<a id="usage"></a>

## 🧪 Run and review

```bash
orbit run --image pytorch/pytorch:latest --gpus 1 --mem 32 -n baseline -- python train.py
orbit sweep --image python:3.12-slim --gpus 1 -g lr -p lr=1e-4,3e-4 -p seed=1,2,3 \
  -- python train.py --lr {lr} --seed {seed}
orbit wait -g lr
orbit show <id>
orbit logs <id> -f
orbit note <id> "Compare this run with the baseline before choosing the next configuration."
```

`{key}` expands to each parameter value; the sweep above submits six runs, queued as resources allow. Most commands accept `--json` for agents and scripts.

<details>
<summary><strong>Full run reference: paths, resources, sweeps and record management</strong></summary>

### Inside a run

| Path / variable | Meaning |
| --- | --- |
| `/workspace` | Writable copy of your code (the original repository is untouched) |
| `$ORBIT_OUTPUT` (`/orbit/output`) | Put results here; they are kept and shown in the Web UI |
| `$ORBIT_METRICS` (`/orbit/metrics.jsonl`) | One JSON object per line, e.g. `{"step": 10, "loss": 0.3}`; charted in the Web UI |
| `$ORBIT_RUN_ID` | The run id |

Leased GPUs are the only GPUs visible in the container. Runs use your host `uid:gid` by default so
output files belong to you (`--root` to run as root).

### Runs

```bash
orbit run --image pytorch/pytorch:latest --gpus 1 --mem 32 -n baseline -- python train.py
orbit run --dockerfile docker/Dockerfile --gpus 2 --gpu-mem 40 -- python train.py   # build an image
orbit run --gpus 1 --timeout 120 -w --image ... -- python eval.py   # wait; exit code = run result
```

Common options:

| Option | Meaning |
| --- | --- |
| `--image` / `--dockerfile` | Image to use, or a Dockerfile to build (context: its directory) |
| `--gpus`, `--gpu-mem <GB>`, `--gpu-ids` | Number of GPUs, minimum memory per GPU, pin specific GPUs |
| `--cpus` (default 4), `--mem <GB>` (default 16) | CPU and memory limits |
| `-n`, `-g`, `-t KEY=VALUE` | Name, group and tags |
| `-m src:dst[:rw]`, `-d name[:dst[:rw]]` | Bind-mount a host path or a registered dataset (read-only by default) |
| `-e KEY=VALUE` | Environment variable (stored with the run: no secrets) |
| `--pass-env VAR` | Pass a variable from the daemon's environment (for secrets; not stored) |
| `--project <dir>`, `--no-project`, `--no-snapshot` | Choose the repository, run without one, or mount it read-only instead of copying it |
| `--no-network`, `--host-network` | Disable networking, or share the host network |
| `--timeout <min>` | Stop the run after this long |
| `--node <name>` | Run on a specific node (multi-node) |
| `-w`, `--json` | Wait for the result; print JSON |

### Sweeps

```bash
orbit sweep --image python:3.12-slim --gpus 1 -g lr -p lr=1e-4,3e-4 -p seed=1,2,3 \
  -- python train.py --lr {lr} --seed {seed}
orbit wait -g lr                # block until the group is done; exit 1 if any run failed
```

`{key}` in the command is replaced by each value; 2 × 3 = 6 runs are submitted and queued as
resources allow.

### Following and reviewing runs

```bash
orbit ps                        # active runs; queued runs show why they wait
orbit ps -a -g lr               # all runs of a group
orbit show <id>                 # details and latest metrics
orbit logs <id> -f              # follow the log (--tail BYTES to start near the end)
orbit wait <id>...              # wait for specific runs
orbit cancel <id>...
orbit rm <id>... | -g <group>   # permanently delete finished runs (asks you to type the id or group)
orbit note <id> "lr 3e-4 diverges after step 2k"   # attach a conclusion (- reads stdin)
orbit web <id> --open           # open the run in the Web UI
```

Most commands accept `--json` for scripts and agents.

</details>

<a id="web-ui"></a>

### Review trajectories in the Web UI

`orbit web` prints a URL that logs your browser in with the daemon's token (stored as a cookie).
Pages: runs (filter, group, multi-select), run detail (overview, logs with search, metric charts,
artifacts preview, code diff, agent session), compare (metrics of several runs), resources (GPUs,
leases, queue, worker nodes), bench jobs and comparisons, and settings (doctor, auth and notification
profiles). Keyboard shortcuts are listed with `?`.

The daemon listens on `127.0.0.1` only. To view it from another machine, use an SSH tunnel:
`ssh -L 7717:127.0.0.1:7717 gpu-server`, then open the printed URL locally (use the port in the URL that
`orbit web` prints if your daemon is not on 7717).

Keep personal experiment notes, scores and artifacts in user-owned storage. The source repository’s `docs/` is for reusable product and development documentation.

<a id="benchmarks"></a>

## 📊 Benchmarks

Compare methods under the same resource rules, keeping execution, evaluation validity and cleanup separate. Only valid scores enter aggregates.

| Integration | Use it for | Guide |
| --- | --- | --- |
| **Harbor format** | [TB-Science](https://github.com/harbor-framework/terminal-bench-science), Terminal-Bench and other Harbor datasets; `bench tasks` lists supported tasks | [Adapter guide](docs/guides/bench-adapter.md) |
| **ASI native wrapper** | ASI’s own runner, with known compatibility issues checked before launch | [Compatibility](docs/guides/bench-adapter.md#asi-bench-版本兼容) |
| **LongDS native CLI** | DataMind's sequential Codex / Claude Code sessions and original judge, via an external adapter | [LongDS setup](examples/bench-adapters/longds/README.md) |
| **External adapters** | Other benchmarks via a JSON protocol, without rebuilding Orbit | [ResearchClawBench example](examples/bench-adapters/researchclawbench/README.md) |

```bash
orbit bench add tbs ../terminal-bench-science --adapter harbor
orbit bench tasks tbs
orbit bench run tbs -t symbolic-regression -m oracle -m empty -n smoke
orbit bench show <job>
orbit bench compare <job>...
```

<details>
<summary><strong>Full benchmark reference: agent methods, task resources and compatibility</strong></summary>

```bash
orbit bench add tbs ../terminal-bench-science --adapter harbor
# datasets published on Harbor Hub: download them with Harbor's CLI, then register the directory
harbor download terminal-bench/terminal-bench@latest -o ~/datasets
orbit bench add tb ~/datasets/terminal-bench --adapter harbor
orbit bench add asi ../ASI-Bench --adapter asi -c python=/path/to/venv/bin/python --pass-env JUDGE_KEY
orbit bench add rcb ../ResearchClawBench --adapter ./examples/bench-adapters/researchclawbench/adapter.py \
  --pass-env OPENAI_API_KEY --pass-env OPENAI_BASE_URL
orbit bench add longds ../DataMind/longds --adapter ./examples/bench-adapters/longds/adapter.py \
  -c image=orbit-longds -c python=/path/to/longds-venv/bin/python \
  --pass-env JUDGE_API_KEY --pass-env JUDGE_BASE_URL --pass-env JUDGE_MODEL
orbit bench tasks tbs           # tasks, and why unsupported ones cannot run
orbit bench run tbs -t symbolic-regression -m oracle -m empty \
  -m gpt=codex,auth=gpt,model=gpt-5,effort=high --seeds 3 -n first-try
orbit bench jobs
orbit bench show <job>
orbit bench compare <job>...    # per-task comparison; paired means use tasks valid for every method
orbit bench usage <job>...      # measured peak memory / CPU / GPU per task, suggested resources
orbit bench cancel <job>
orbit bench rm-job <job>        # delete a finished job with its trials and runs (type the job id)
```

Methods are `name=agent[,auth=P,model=M,effort=E,bundle=DIR]` with agent `codex`, `claude-code`,
`oracle` (reference solution) or `empty` (submits nothing; checks that the verifier gives 0). Every
trial records execution (how the solve run ended), evaluation (`valid` / `invalid` / `unknown`) and
cleanup separately; only valid scores count. The Web UI shows jobs, a task × method matrix and
cross-job comparison under **Bench**. Grader secrets given with `--pass-env` reach only the verify
run. Per-task solve resources (GPU, memory, CPU, timeout) come from an optional JSON file given with
`orbit bench add --resources`; every run records its measured peaks, and a solve run killed for memory
makes the trial invalid instead of a zero. Any other benchmark needs only an adapter executable that speaks a small JSON protocol (no
rebuild of Orbit): [docs/guides/bench-adapter.md](docs/guides/bench-adapter.md).

ASI Agent runs require a complete source checkout with `--fail-on-agent-error` support and the
sandbox timeout fix. Orbit checks the selected Codex/Claude adapter before launching an Agent and
rejects the known bug that treats a background timeout warning as execution failure. Update the
**registered ASI checkout**, including any frozen copy; upgrading Orbit alone cannot fix that code.
The native attempt status is shown separately from score validity. See
[ASI compatibility](docs/guides/bench-adapter.md#asi-bench-版本兼容).

</details>

<a id="several-machines"></a>

## 🌐 Multiple machines

Every machine runs Orbit. The machine your agent works on (the primary) places runs on workers it has
added; local resources are used first.

```bash
# on the worker (e.g. Tailscale address 100.64.0.12); its firewall must let the primary reach 7718
orbit node expose --listen 100.64.0.12:7718
orbit node token                                # copy the printed token
# on the primary: asks for the token (paste it, input hidden, then Enter)
orbit node add http://100.64.0.12:7718
orbit node ls
orbit data add imagenet /data/imagenet          # on every node that has the data
orbit run -d imagenet --gpus 1 --image pytorch/pytorch -- python train.py
```

Code snapshots are sent once per content hash; datasets are never copied; logs and metrics are
mirrored to the primary; outputs stay on the worker and are read through the primary. The cluster
protocol is plain HTTP with a token: use Tailscale, a private network or an SSH tunnel, never the
public internet. Details: [docs/guides/multi-node.md](docs/guides/multi-node.md).

<a id="notifications"></a>

## 📱 Notifications and mobile access

Use `orbit feishu init` to create a Feishu bot by QR code, receive result cards with metric curves,
and query `/gpu`, `/runs` or `/show <id>`. Feishu webhooks, DingTalk, WeCom, Slack and generic webhooks are also supported.

<details>
<summary><strong>Set up notifications and the Feishu bot</strong></summary>

```bash
orbit notify add team --kind feishu --url-env FEISHU_HOOK --on failed,group
orbit notify add team --kind feishu --url-stdin --on failed,group
orbit notify test team
orbit notify list
```

Kinds: `feishu`, `dingtalk`, `wecom`, `slack`, `webhook`. Events: `succeeded`, `failed`, `group` (one
summary when a group has finished). Failure messages include the reason and the last log lines.
Use `--url-stdin` for hidden terminal input or a pipe, or `--url-env VAR`. The legacy `--url` option
warns because webhook secrets appear in process arguments. See the [notification guide](docs/guides/notifications.md).

### Feishu bot


```bash
orbit feishu init phone       # prints a QR code: scan it with the Feishu app and confirm
```

Scanning creates a Feishu app (bot, message permissions and the message event pre-filled) paired with
whoever scanned it. Then:

- When a run or group finishes, the bot sends a card: state, resources and measured peaks, metric curves
  (e.g. loss), and the log tail for failures.
- Message the bot at any time (mention it in groups): `/gpu` shows memory, utilization and holder of each
  GPU plus CPU, memory and the queue; `/runs` the recent runs; `/show <run id>` one run. Commands are
  read-only.

The daemon opens an outbound long connection to Feishu: no public address is needed and the daemon still
listens on localhost only. If `init` reports that the long connection or the test card failed, it prints
the console page to fix (subscription mode "persistent connection", permissions, publish a version);
then run `orbit feishu check phone` to reconnect and test.

- Several bots can be bound (with different names), but each app only once, and never to the daemons of
  two machines (Feishu hands each event to only one connection). Pairing with several bots duplicates
  notifications.
- An existing app: `orbit notify add phone --kind feishu-app --app-id cli_… --secret-stdin`. Others who
  message the bot get a pairing code and can use it after you run `orbit notify pair phone <code>`;
  unpaired people see no data.
- `orbit notify list` shows paired users and the connection; `orbit notify rm phone` removes the bot.

</details>

<a id="configuration-and-files"></a>
<a id="configuration"></a>

## ⚙️ Configuration and data

<details>
<summary><strong>Directories, ports, nodes and data management</strong></summary>

| Item | Default | Override |
| --- | --- | --- |
| State directory (database, profiles, config) | `~/.orbit` | `ORBIT_HOME` |
| Data directory (run directories, bench staging, code bundles) | the state directory | `orbit config data <dir>`, or `ORBIT_DATA` |
| Daemon port (on `127.0.0.1`) | 7717, else a free port | `ORBIT_PORT`, or `orbit daemon --port` (then a busy port is an error) |
| Node name | host name | `ORBIT_NODE` |
| GPUs Orbit may use | all | `ORBIT_GPUS=0,1` |
| Daemon endpoint and token | `~/.orbit/daemon.json` (0600) | |

The daemon is the only writer of Orbit's state; the CLI, the Web UI and agents all go through its
local HTTP API. `orbit daemon --stop` stops it; running containers continue and are picked up again
when it restarts. `orbit daemon` runs it in the foreground.

Run data can grow to hundreds of GB. On a machine with a small system disk, put it on a large disk
once, before the first runs: `orbit config data /data/$USER/orbit && orbit daemon --stop`.
`orbit doctor` warns when the data directory or Docker's data root is on the system disk or low on
space. Folders organize runs and bench jobs without moving files: `orbit run --folder rcb/noskills`,
`orbit mv <id...> rcb/archive`, `orbit folders`, and `orbit export rcb /path/to/copy` for a real copy.

</details>

<a id="roadmap"></a>

## 🧭 Vision and progress

| Direction | Current progress |
| --- | --- |
| **Digital experiments** | Docker execution, resource scheduling, sweeps, trajectory records and local Web review are implemented; single-machine workflows are validated. |
| **Benchmarks & multiple machines** | Implemented; benchmark validation focuses on oracle / empty methods, and multi-node validation uses two daemons on one host. |
| **Embodied environments** | Vision: extend execution and resource abstractions to simulation, robots and experimental equipment. Device backends are not implemented yet. |
| **Learning and evolution from trajectories** | Records and review are available for agents to analyze and refine the next experiment. Automated learning, policy updates and evaluation feedback loops are future research directions. |

Orbit is in early development (0.1.1). See [project status](docs/status.md) for validation limits and near-term work, and [design](docs/design.md) for the architecture.

<a id="documentation"></a>

## 📚 Documentation

| I want to… | Start here |
| --- | --- |
| Connect agents and manage plugins | [Plugin guide](plugin/README.md) |
| Add a benchmark or size task resources | [Benchmark adapter guide](docs/guides/bench-adapter.md) |
| Connect several machines | [Multi-node guide](docs/guides/multi-node.md) |
| Understand architecture and support | [Design](docs/design.md) · [Project status](docs/status.md) |
| Build and publish a package | [Release guide](docs/guides/releasing.md) |
| Present Orbit | [Offline slides (Chinese)](docs/ppt/README.md) |

<a id="troubleshooting"></a>

## 🔧 Troubleshooting

| Symptom | What to check |
| --- | --- |
| `orbit doctor` reports docker errors | Docker is running and your user can run `docker ps` without sudo |
| GPU runs fail to start | `nvidia-smi` works; the NVIDIA Container Toolkit or a CDI spec is installed |
| A run stays `queued` | `orbit ps` shows the reason (GPUs busy, CPUs busy outside Orbit, memory, pinned node offline, …) |
| An agent cannot reach Orbit | `orbit` is on its `PATH`; Codex sandbox allows network access |
| Snapshot too large | Add data and weights to `.gitignore` and mount them with `-m` or `orbit data` |

<a id="development"></a>

## 🛠️ Development and contributing

Requires pnpm 10 (`corepack enable`). See the [release guide](docs/guides/releasing.md) for publishing.

```bash
git clone https://github.com/zjunlp/Orbit.git
cd Orbit
pnpm install
pnpm build
pnpm orbit doctor
pnpm --filter @zjunlp/orbit-web dev   # Vite dev server; proxies /api to the daemon
pnpm orbit <args>                     # run the CLI from source
pnpm verify                           # lint + typecheck + module boundaries + tests + build
```

```
packages/orbit/   the `@zjunlp/orbit` package (CLI `orbit`, daemon, modules)
packages/web/     the Web UI (React + Vite, served by the daemon)
assets/           shared project logo and icon
plugin/           the Orbit skill for Codex / Claude Code
scripts/          repository checks (module boundaries)
docs/             design.md, status.md, tasks/, guides/, ppt/
```

Contributors and coding agents: read [AGENTS.md](AGENTS.md) first.

Contributions and reproducible bug reports are welcome through [GitHub Issues](https://github.com/zjunlp/Orbit/issues).

<a id="acknowledgements"></a>

## 🤝 Acknowledgements

Orbit's `harbor` adapter reads the task format defined by [Harbor](https://github.com/harbor-framework/harbor)
(Apache-2.0) from the Terminal-Bench team; it is an independent implementation, not an official Harbor
runner and not endorsed by its authors. Scores from Orbit are comparable to Harbor's only where they have
been checked against it; see `docs/tasks/` for what was checked.

<a id="license"></a>

## 📄 License

Orbit's original source code is licensed under [MIT](LICENSE) © 2026 ZJUNLP.
Bundled dependencies retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).
The [presentation](docs/ppt/README.md#来源与许可) follows AGPL-3.0, with separate licenses for its third-party assets.
