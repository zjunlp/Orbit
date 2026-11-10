# EmbodiedCLBench

This adapter evaluates the **model, Agent CLI harness and continual experience** through the
benchmark's native visual household tools. It does not evaluate a robot policy or VLA. The official
CPU graph environment uses recorded scene images; no simulator GPU or local model is needed.

Source: [PKU-VaLuE-Lab/EmbodiedCLBench](https://github.com/PKU-VaLuE-Lab/EmbodiedCLBench), pinned to
`f33105f017f5408f8d2c6debe8bd4086881d3ea4`.
The official input archive `tongbench_l2_l4_scaleup_v1_input_subsets.tar.gz` has SHA256
`1bbcf0c26f724d9461313aa3a0272fdd0e2f627896fa98604787800f530833e2`.

## Protocol

- `basic_l2/<task>` runs one native basic task; `zero_shot_l4/<task>` runs one advanced task.
- `in_context_l4/<task>` is **one complete ordered sequence**: every related basic task in the official
  `learning_plan.json`, then the advanced target. One Agent process retains the full interaction
  context within the trial. Other targets, seeds and methods start fresh and cannot reuse memory.
- `skill_l4/<task>` remains visible but unsupported. The official skill setting distills experience and
  transfers only that summary into a fresh context. Keeping the learning conversation would change
  this setting, so it is not advertised as supported.

The official `safe_choice` MCP server supplies observations, attached images, lettered action choices,
feedback and automatic sequence advancement. Its prompt, task descriptions, templates, option bank,
image preparation and environment transitions are reused. The Agent process is launched by Orbit
with `agentTask`; a stdio-to-HTTP MCP transport forwards the native content blocks unchanged. There is
no custom model client or Agent loop. Codex and Claude Code are supported; the configured model must
accept image tool results. Text-only fallbacks are not enabled.

The private environment service owns task graphs, option answers, state and evidence. The Agent sees
only the MCP proxy. Whole native tool calls are serialized on the service, including sequence
advancement and image staging. Orbit finalizes through a private Unix socket: it stops accepting new
actions, drains an in-flight tool call, then exports evidence once. Original graph/manifest/option-bank files and all available observation images
used by the trial are SHA256 frozen and checked again at runtime and verification. A separate CPU
verify run replays the recorded tool actions in the original environment, checks sequence order and
saved grades, and invokes the original `grade_trace` (through `export_outputs`) and
`summarize_l2_l4_results.py` report functions. Only the target contributes to the trial score;
learning episodes remain visible in the review.

Native rollout budgets remain shortest path plus **six** actions. The primary score is the official
report's binary success at shortest path plus **three** actions. The subset controls task selection,
not episode length or difficulty. Valid model failures score zero; missing/changed inputs, environment
errors and untrustworthy replay are invalid. Empty submissions are valid zeros. The explicit `oracle`
calibration chooses the original reference-path actions through the same option bank; this is not an
Agent method.

The public data package explicitly marks some L4 branches `missing_image_in_packaging`. Native
preparation retains its available image mappings. Reaching a nonterminal observation without an
image is reported as an input/environment failure, rather than silently running a text-only task.
This stricter validity condition must be considered when comparing coverage with upstream reports.
Full-suite statistical equivalence is not claimed.

## Setup

Keep upstream code, datasets and outputs outside the Orbit source checkout. Follow the upstream
README to download the official input data and verify its SHA256. The packaged native Agent runtimes
are not needed: Orbit supplies the actual Agent CLI and its existing auth profile.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/PKU-VaLuE-Lab/EmbodiedCLBench /data/benchmarks/EmbodiedCLBench
git -C /data/benchmarks/EmbodiedCLBench checkout f33105f017f5408f8d2c6debe8bd4086881d3ea4

docker build --label orbit.task=embodied-harness-benchmarks \
  -t orbit-embodied-clbench:f33105f-1 examples/bench-adapters/embodied-clbench

orbit bench add embodied-clbench /data/benchmarks/EmbodiedCLBench \
  --adapter "$PWD/examples/bench-adapters/embodied-clbench/adapter.py" \
  --resources "$PWD/examples/bench-adapters/embodied-clbench/resources.json" \
  -c data=/data/benchmarks/embodied-clbench-data -c subset=stage0_smoke
orbit bench tasks embodied-clbench
```

Config accepts only `data`, `subset` and `image`. `data` contains `input/merged` and `subsets`;
`subset` is `stage0_smoke` (default), `stage2_20pct` or `stage3_full`. Missing subsets do not silently
fall back. The full release contains 168 basic tasks and 100 advanced targets. Every advanced target
has zero-shot, ICL and unsupported skill entries. No task is silently omitted.

```bash
orbit bench run embodied-clbench \
  -t basic_l2/task_L2_HL_v5_adult_0005 \
  -t in_context_l4/task_L4_HL_v5_adult_0002 \
  -m empty -m oracle -n 'CLBench native calibration'

orbit bench run embodied-clbench \
  -t basic_l2/task_L2_HL_v5_adult_0005 \
  -t in_context_l4/task_L4_HL_v5_adult_0002 \
  -m ark-vision=claude-code,auth=YOUR_ARK_PROFILE,model=glm-5.3-flash \
  -n 'CLBench Ark visual tasks'
```

The default solve reservation is 2 CPU / 4 GB RAM / no GPU / 60 minutes; the private environment
adds 2 CPU / 4 GB RAM for Agent methods. Verification uses 2 CPU / 4 GB RAM. Inspect `orbit bench usage`
after real runs before changing these estimates. Trial overrides that request a GPU are rejected.

## Development checks

`pnpm verify` includes the dedicated Vitest contract check and explicit synthetic Python fixtures
for sequence order, unsupported settings, visual provenance, input isolation and scoring validity.
These fixtures are not native calibration. Real checks must use the official data and image through
`orbit bench`; keep their private run records outside the source checkout.
