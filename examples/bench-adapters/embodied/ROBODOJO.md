# Native RoboDojo

`robodojo-arx-x5-native` registers all 54 native tasks (42 base tasks and 12 random
variants) at commit `f57e1633ffed59761bc8e568cfe7530c4b33381c`. The benchmark registration
is independent of a policy. Tasks with no downloaded replay layouts remain listed with an
explicit unsupported reason. Sampled native execution checks are recorded below; trained-policy
performance and full-suite statistical equivalence remain unverified.

[Official source](https://github.com/RoboDojo-Benchmark/RoboDojo/tree/f57e1633ffed59761bc8e568cfe7530c4b33381c)
· [Evaluation guide](https://robodojo-benchmark.com/doc/usage/quick-evaluation/)
· [Frozen task and I/O profile](profiles/robodojo-native.json)

## Prepare the simulator and assets

Keep upstream sources, generated registrations and downloaded assets outside the Orbit checkout.
The pinned upstream Dockerfile installs Python 3.11, Isaac Sim 5.1.0, Torch 2.7.0 with CUDA 12.8,
and the repository's pinned IsaacLab, CuRobo and XPolicyLab submodules. Its full image is large;
check disk capacity and NVIDIA's Isaac Sim driver requirements before building. RTX rendering
is required even though RoboDojo's default physics configuration uses the CPU.

Set `ROBODOJO_SOURCE`, `ROBODOJO_ASSETS` and `ROBODOJO_CONFIG` to user-owned directories.
Use a host Python 3.11 virtual environment for the configurator commands and development tests
below. The simulator image supplies its own interpreter.
Download the official dataset's complete `Assets` tree, including robots, objects, materials and
replay layouts, at an explicit dataset revision. Registration hashes the actual content and
individual layouts; the dataset revision alone is insufficient. Git LFS pointers are not assets.

```bash
git clone https://github.com/RoboDojo-Benchmark/RoboDojo "$ROBODOJO_SOURCE"
git -C "$ROBODOJO_SOURCE" checkout f57e1633ffed59761bc8e568cfe7530c4b33381c
git -C "$ROBODOJO_SOURCE" submodule update --init --recursive
hf download RoboDojo-Benchmark/RoboDojo --repo-type dataset \
  --revision "$ROBODOJO_ASSET_REVISION" --include 'Assets/**' --local-dir "$ROBODOJO_DOWNLOAD"
# ROBODOJO_ASSETS is "$ROBODOJO_DOWNLOAD/Assets".
python3 -B examples/bench-adapters/embodied/configure_robodojo.py \
  --prepare-assets --robodojo-source "$ROBODOJO_SOURCE" \
  --assets "$ROBODOJO_ASSETS" --output-dir "$ROBODOJO_CONFIG"

ROBODOJO_RUNTIME_DIGEST=$(python3 -B examples/bench-adapters/embodied/configure_robodojo.py \
  --prepare-image --robodojo-source "$ROBODOJO_SOURCE" --output-dir "$ROBODOJO_CONFIG")
docker build --label orbit.task=robodojo -t orbit/robodojo-upstream:reference "$ROBODOJO_SOURCE"
ROBODOJO_BASE=orbit/robodojo-upstream:reference
docker build --label orbit.task=robodojo \
  --build-arg ROBODOJO_BASE="$ROBODOJO_BASE" \
  --build-arg RUNTIME_MANIFEST_DIGEST="$ROBODOJO_RUNTIME_DIGEST" \
  --build-context runtime-manifest="$ROBODOJO_CONFIG" \
  -f examples/bench-adapters/embodied/robodojo.Dockerfile \
  -t orbit/robodojo-simulator:reference .
```

Asset preparation applies upstream's `curobo_tmp.yml` substitutions for the container's
`/workspace/RoboDojo` path, writes `Robots/x5/curobo.yml`, and records both hashes.
Registration requires this generated file and includes it in the asset digest. A different
existing configuration is rejected without overwriting it; prepare a separate asset tree.

Pass a local image tag or a full repository digest as `ROBODOJO_BASE`; BuildKit does not
accept a bare image ID as a `FROM` reference. Registration freezes the completed simulator image ID.

The preparation step checks each submodule's commit and clean runtime source, then records its
file hashes. The thin Orbit image layer checks these hashes against the files installed in the
upstream image and checks the Isaac Sim package version. Registration repeats those checks against
local source and image labels. Every episode process also checks source and asset contents before
launching the simulator. IsaacLab release tags and Python package versions are different identities;
the source commit identifies the installed fork. Required runtime directories include IsaacLab's
`source` and `apps`, XPolicyLab's `client_server`, and CuRobo's `curobo` package. Missing directories
fail preparation. The image also checks that an unprivileged user can import the SDK and prefers
the NVIDIA driver libraries injected from the host over bundled CUDA compatibility drivers;
Isaac Sim's own driver checks remain active except for the scoped upstream workaround below.

On Linux R535 drivers whose minor version is at least 256, Vulkan can misreport the driver
version and reject a compatible device. Before launching Isaac, the SDK queries `nvidia-smi`
with a five-second limit and requires one valid, consistent system driver version. Only this
known affected range receives NVIDIA's documented `--/rtx/verifyDriverVersion/enabled=false`
workaround; the actual version and applied workaround are logged. Other driver versions,
malformed or inconsistent responses, and failed queries retain native version verification.
The workaround changes only this process's faulty version gate; it does not alter the host
driver, Vulkan device creation, physics or task scoring. See NVIDIA's
[known driver issues](https://docs.omniverse.nvidia.com/dev-guide/latest/common/technical-requirements.html#known-issues-and-limitations).


The thin layer keeps the upstream simulation versions and pins compatible auxiliary packages
(`psutil`, build/test tools and Viser) to preserve Isaac Sim's dependency requirements. It prints
final Torch/CUDA, NumPy, Warp and Isaac Sim versions and rejects unexpected `pip check` failures.
One upstream requirement cannot be satisfied simultaneously: the pinned IsaacLab requires
Starlette 0.49.1 for livestreaming, while Isaac Sim 5.1's fixed FastAPI requires Starlette below
0.46. The image keeps Starlette 0.45.3 for Isaac Sim and reports this remaining `pip check`
conflict explicitly. This integration supports headless evaluation; the IsaacLab livestream/UI
path is unsupported and unverified. Rebuilt images require their own native initialization, camera and control checks;
the development results below apply only to the pinned stack that was checked.

## Register and freeze samples

```bash
python3 -B examples/bench-adapters/embodied/configure_robodojo.py \
  --benchmark-only --robodojo-source "$ROBODOJO_SOURCE" --assets "$ROBODOJO_ASSETS" \
  --benchmark-image orbit/robodojo-simulator:reference --output-dir "$ROBODOJO_CONFIG"
orbit data add robodojo-native-assets "$ROBODOJO_ASSETS"
orbit bench add-file "$ROBODOJO_CONFIG/benchmark.json"
orbit bench tasks robodojo-arx-x5-native --json

python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$ROBODOJO_SOURCE" --reference-file "$ROBODOJO_CONFIG/reference.json" \
  --task push_T --task stack_bowls --environment-seed 0 --initial-state 0 \
  > "$ROBODOJO_CONFIG/samples.json"
```

The generated registration binds `resources.json`: one simulator GPU with a provisional 16 GB
GPU memory budget, 32 GB host memory, eight CPUs and a 60 minute limit. These are uncalibrated
starting limits; revise them using measured `orbit bench usage` before larger evaluations.

`environmentSeed` selects the official `Eval_Layout/RoboDojo/arx_x5/{0,1,2}` partition.
`initialStateId` is the ordinal after numerically sorting that task's layout filenames. For
example, files `push_T_2.json` and `push_T_10.json` have ordinals 0 and 1. The partition,
ordinal, filename and content digest are all frozen. A rejected layout is recorded as
`sample_rejected`; it is never replaced by a different scene within the same frozen plan.
A small frozen plan is a development check, not the official 25/50 accepted layouts per task
and seed or a full leaderboard reproduction.

## Policy interface and native semantics

An independent `policy-ws` service can declare the exact `benchmarkProfile` in the generated
reference. Its own registration specifies checkpoint, normalization, random stream and action
chunk length. This integration does not ship model weights or a calibrated model recipe.
`bench calibrate --policy` requires a real model; a hold-position control is only a simulator
negative control and must be described as such.

To emit the explicit CPU hold-position service, replace `--benchmark-only` above with
`--with-hold-calibration`, then register `hold-policy.json` with `orbit policy add` and submit
the two-task frozen plan with:

```bash
orbit policy add "$ROBODOJO_CONFIG/hold-policy.json"
orbit bench run robodojo-arx-x5-native \
  --method hold=policy,policyRef=robodojo-hold-calibration \
  --sample-plan "$ROBODOJO_CONFIG/samples.json" --batch-size 2
```
The fixture repeats the native measured arm positions and commanded gripper targets and requires no checkpoint. It tests the real
simulator and evidence path, and must never be reported as a trained-policy score or success oracle.
Use `orbit bench run` for this fixture; `bench calibrate --policy` intentionally rejects calibration
fixtures. Keep the complete native horizon and review invalid versus valid-zero results separately.

The transport exposes the three original 480×640 RGB camera frames, both native joint-state observation groups, end-effector poses and the native instruction. Poses use
metres and scalar-first quaternions relative to the environment origin, with world-aligned axes.
Both native joint groups contain measured arm positions and the last commanded normalized grippers;
the gripper fields are not measured finger positions. Actions are 14 absolute joint/gripper targets in left-arm, left-gripper, right-arm,
right-gripper order. Native `take_action` owns control interpolation, clipping and physics steps.
No frame resizing, action normalization, settling override or horizon shortening is applied.
Runs use the native repository as their working directory so relative material paths resolve correctly.
Before Kit starts, the SDK imports and checks the native `utils.load_file` module: Kit exposes
OpenCV’s same-named regular package, which otherwise shadows RoboDojo’s namespace package.
An already conflicting module is rejected; the SDK does not replace another loaded module.

The SDK calls the official `create_eval_env`, `reset`, `run_reward`, optional `get_score`,
`get_obs` and `take_action`. Only the constructor's WebSocket policy transport is replaced by
an explicit lifecycle handoff; the shared Orbit driver resets and calls the independent policy.
The original factory globals remain unchanged. Interactive support-arm preparation is retained.
One SimulationApp lives for the process; each episode owns a fresh environment and stage.
The native articulation-dependent PhysX checks remain enabled where upstream enables them.
Fatal simulator failures produce invalid attempts, without restarting or silently continuing the
same frozen episode.

The native `success` flag initially means the slot is still active. It becomes evidence of
success only together with `end_flag`. Native early endings are retained. The primary score is
1 for success, otherwise the native gated process score divided by 100, or 0 for tasks without
partial scoring. `success_rate` and the raw `process_score` are separate metrics. This normalized
primary score corresponds to the official evaluator's percentage `score` divided by 100.
The CPU verifier checks each recorded native step count, layout identity, termination flag and
process score against the final result; it does not replay physics.

## Development checks

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=examples/sdk \
  ORBIT_ROBODOJO_SOURCE="$ROBODOJO_SOURCE" \
  python3 -m unittest orbit_embodied.test_robodojo -v
```

The metadata checks read the real pinned source without importing Isaac. The environment unit
tests use explicitly synthetic doubles. Passing them does not establish that Isaac starts,
assets load, policies solve tasks, or published scores are reproduced. A real task check should
retain the frozen plan, per-step evidence and Orbit resource measurements separately from these
unit tests.

Two full-horizon native hold-control episodes passed actual GPU execution, independent CPU
verification and rescore, including a fresh environment for the second task in one process.
A separate native reset/camera/control check retained all three original RGB frames. These
checks do not establish trained-policy performance, a successful RoboDojo oracle, or full-suite parity.
