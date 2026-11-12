<p align="center">
  <img src="https://raw.githubusercontent.com/zjunlp/Orbit/main/assets/orbit-logo.png" alt="Orbit" width="480">
</p>

# Orbit: Learn and Evolve in Any Environment.

Orbit is the lab for agents that work and improve on their own: a place to run experiments, the
evidence to check them, and independent verification of the result. Today, Orbit runs experiments in
Docker with GPU / CPU / memory leases, keeps code snapshots, logs, metrics, outputs and agent sessions
for review in the bundled local Web UI, and evaluates agents on benchmarks with paired comparison.
A gate that accepts or rejects an agent's changes to itself is in design, not yet implemented.

Requires Linux, Node.js 24.18+ (24.x), Git and Docker usable without sudo. GPU runs also need NVIDIA
drivers and the NVIDIA Container Toolkit or CDI. No source checkout is needed; pnpm is only required for dsh plugin installation.

```bash
npx -y @zjunlp/orbit doctor
```

Install the CLI permanently with `npm install -g @zjunlp/orbit`, then use `orbit` instead of
`npx -y @zjunlp/orbit`. The daemon starts automatically on the first command that needs it.

Install both skills for your existing agent (choose one):

```bash
npx -y @zjunlp/orbit plugin install claude
npx -y @zjunlp/orbit plugin install codex
npx -y @zjunlp/orbit plugin install dsh --profile headless
npx -y @zjunlp/orbit plugin install pi
```

Restart the agent to load `orbit` and `orbit-bench`. The skills use `npx` when no global `orbit`
command is available. dsh needs pnpm and a profile with its skills service; pi means pi coding
agent. [Plugin guide](https://github.com/zjunlp/Orbit/blob/main/plugin/README.md) covers versions,
updates and removal. Session capture and in-container agents currently support Codex/Claude only.

```bash
npx -y @zjunlp/orbit run --image python:3.12-slim -- python -c 'print("hello")'
npx -y @zjunlp/orbit ps -a
npx -y @zjunlp/orbit web
```

[Usage and configuration](https://github.com/zjunlp/Orbit#readme) ·
[Chinese guide](https://github.com/zjunlp/Orbit/blob/main/README.zh-CN.md) ·
[Validation limits](https://github.com/zjunlp/Orbit/blob/main/docs/status.md)

Orbit's original source code: MIT © ZJUNLP. Bundled dependencies retain their own licenses;
full notices ship in `dist/web/THIRD_PARTY_LICENSES.md`. See
[Third-party notices](https://github.com/zjunlp/Orbit/blob/main/THIRD_PARTY_NOTICES.md) for license scope.
