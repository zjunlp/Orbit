# EmbodiedLab: coding agents running laboratory experiments

This adapter targets the model, its coding-agent harness and its experimental procedure. It does not evaluate a VLA or a pretrained robot policy. It preserves all 30 experiments from [HexaFuture/EmbodiedLab](https://github.com/HexaFuture/EmbodiedLab) at commit `5dd50ff33ec1211685f47ee38d9abf8db75656bf`.

The integrated interface is **T0**: three RGB camera views, calibrated robot state, joint/gripper commands, kinematics-only inverse kinematics, instruments and one submission. Agents implement their own perception, manipulation and measurement procedure. T1 additionally requires SAM3/cuRobo and is explicitly rejected by this adapter; the upstream release does not include T2.

## Native behavior

- Tasks come from the pinned `experiments/*/experiment.yaml` registry; `catalog.json` records their identifiers, titles, disciplines, tiers and budgets.
- An Orbit-managed GPU service starts the original SDK `Worker`, which launches the original Isaac simulator as a child process. It does not start Docker or use the upstream host Controller/Worker orchestration.
- The original `scripts/trial.py` templates produce the agent's task card, README and prompt. The original standard-library `embodiedlab_api` client talks to a narrow public-tool transport. Each native operation executes once and is polled by operation ID. Concurrent tool calls are refused until the current operation completes.
- Orbit launches the selected Agent CLI with `agentTask`. The Agent gets a writable workspace only; the upstream source, instance truth, simulator administration interface and signing key remain in the service. The spectator view is disabled.
- The simulator derives its original `dev` instance from the Orbit seed; the simulator runtime seed remains 0, as in the native trial runner. Simulated-time and wall-clock budgets come from the original experiment specification. One sealed submission and all original evidence requirements remain enforced by the benchmark.
- After the Agent exits, an Orbit hook finalizes native video, sealed evidence and process records. The service signs a digest manifest. A separate CPU verifier checks the signature and instance binding, then calls the original `evaluate` and `score_trial` functions. Saved evidence supports rescore.

The primary score is native binary success (`task_completed`). Native reward is also recorded; the six-level process score is displayed on a 0–100 scale. Experiment means receive equal weight. Missing submissions with intact native process records are valid failures; missing or altered evidence, simulator/GPU failures and scorer exceptions are invalid. There is no published reference oracle. `empty` is an explicit no-action control and requires a real simulator to generate its valid zero.

## Build and register

Build outside the source checkout. The upstream checkout and runtime assets must remain outside Git records.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/HexaFuture/EmbodiedLab.git /path/to/EmbodiedLab
git -C /path/to/EmbodiedLab checkout 5dd50ff33ec1211685f47ee38d9abf8db75656bf
# Verify there are no unresolved Git LFS pointer files before building.
docker build --label orbit.task=embodied-harness-benchmarks -t orbit-embodiedlab-native:5dd50ff -f /path/to/EmbodiedLab/docker/lab/Dockerfile /path/to/EmbodiedLab
docker build --label orbit.task=embodied-harness-benchmarks -t orbit-embodiedlab-lab:5dd50ff -f /path/to/adapter/Dockerfile.lab /path/to/adapter
docker build --label orbit.task=embodied-harness-benchmarks -t orbit-embodiedlab-agent:5dd50ff -f /path/to/adapter/Dockerfile.agent /path/to/adapter
orbit bench add embodiedlab /path/to/EmbodiedLab \
  --adapter /path/to/adapter/adapter.py --resources /path/to/adapter/resources.json
orbit bench tasks embodiedlab
orbit bench run embodiedlab -t pendulum_g -m empty -n embodiedlab-empty
```

Use an existing Orbit CLI method/profile for the requested model, including an Ark Agent Plan relay profile. Image observations require a model and profile that actually support image input. This adapter never invokes a model API directly.

Configuration keys are `image`, `labImage`, `exposure` (only `T0`), and `wallSeconds`. A shorter `wallSeconds` is explicitly labeled a bounded smoke check and suppresses the official aggregate declaration. An Orbit timeout shorter than the task budget is likewise recorded as a bounded smoke condition in the trial and review. Such checks test the integration and cannot establish full-budget model quality.

The original runtime is Isaac Sim **6.0.1**, which needs a compatible NVIDIA driver and RTX rendering GPU. The source recommends a 24 GB RTX GPU (tested upstream on RTX 4090). The provisional service request is one RTX GPU, 24 GB GPU memory minimum, 8 CPUs and 32 GB RAM; the CPU Agent reserves 2 CPUs and 4 GB RAM separately. Resource sizing and full-suite numerical equivalence require real runtime validation. Do not bypass the simulator's driver gate to label an incompatible host supported.

## Development validation

```bash
python3 -B -m unittest discover -s /path/to/adapter -p 'test_*.py' -v
```

These tests cover planning, interface rejection, Agent/service isolation, evidence tampering and valid-zero handling using explicit fixtures. They do not simulate Isaac or stand in for a real model-driven experiment. Real runtime outcomes and private model scores belong in user-owned notes outside this checkout.
