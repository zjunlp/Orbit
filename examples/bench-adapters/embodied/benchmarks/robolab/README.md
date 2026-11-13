# Native RoboLab

This route registers all 120 manipulation tasks from
[NVlabs/RoboLab](https://github.com/NVlabs/RoboLab/tree/9cce00cadd5dc575fd2b8ea3836f5bdcde574229)
at commit `9cce00cadd5dc575fd2b8ea3836f5bdcde574229`. It uses the official DROID robot,
joint-position controller, default instructions, home-office background, native scenes and native
success predicates. Benchmark registration is independent of a policy registration.

The frozen runtime is Isaac Sim 5.0.0 from the official `nvcr.io/nvidia/isaac-lab:2.2.0`
container, pinned by manifest digest in the Dockerfile. Its installed Isaac Lab package is **0.44.8**.
This container differs from the Git `v2.2.0` tag, whose package metadata says 0.44.9: the only Python
source difference is a postponed-annotations import in `manager_based_rl_mimic_env.py`, which
RoboLab does not use. The DROID runtime paths match the tag. The profile freezes the container
identity, package version and a digest of its core Python sources, application configurations and version files; the simulator
checks that digest before creating an environment.
Isaac Sim 5.1 or 6.0 needs a separate recipe: the upstream project warns that PhysX changes affect
contact dynamics and replay outcomes. An RTX GPU and compatible NVIDIA driver are required.
Upstream recommends 48 GB VRAM; the generated single-environment resource file is an unmeasured
starting estimate, and must be calibrated before broad use.


On Linux R535 drivers whose minor version is at least 256, Vulkan can misreport the driver
version and reject a compatible device. Before launching Isaac, the SDK queries `nvidia-smi`
with a five-second limit and requires one valid, consistent system driver version. Only this
known affected range receives NVIDIA's documented `--/rtx/verifyDriverVersion/enabled=false`
workaround; the actual version and applied workaround are logged. Other driver versions,
malformed or inconsistent responses, and failed queries retain native version verification.
The workaround changes only this process's faulty version gate; it does not alter the host
driver, Vulkan device creation, physics or task scoring. See NVIDIA's
[known driver issues](https://docs.omniverse.nvidia.com/dev-guide/latest/common/technical-requirements.html#known-issues-and-limitations).

## Prepare the runtime and native assets

Keep the upstream source, assets, generated configuration and outputs outside the Orbit checkout.
Set `ROBOLAB_SOURCE` and `ROBOLAB_CONFIG` to those absolute paths. Review the upstream NVIDIA
runtime license requirements before using the simulator image, whose headless entry point accepts
the runtime EULA. The native asset download is approximately 7 GB.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/NVlabs/RoboLab.git "$ROBOLAB_SOURCE"
GIT_LFS_SKIP_SMUDGE=1 git -C "$ROBOLAB_SOURCE" checkout 9cce00cadd5dc575fd2b8ea3836f5bdcde574229
git -C "$ROBOLAB_SOURCE" lfs install --local
git -C "$ROBOLAB_SOURCE" lfs pull --include 'assets/**' --exclude ''

docker build --label orbit.task=robolab \
  --build-context robolab="$ROBOLAB_SOURCE" \
  -f examples/bench-adapters/embodied/benchmarks/robolab/robolab.Dockerfile \
  -t orbit/robolab-simulator:reference .

python3 -B examples/bench-adapters/embodied/benchmarks/robolab/configure_robolab.py \
  --robolab-source "$ROBOLAB_SOURCE" --assets "$ROBOLAB_SOURCE/assets" \
  --benchmark-image orbit/robolab-simulator:reference --output-dir "$ROBOLAB_CONFIG"
orbit data add robolab-assets "$ROBOLAB_SOURCE/assets"
orbit bench add-file "$ROBOLAB_CONFIG/benchmark.json"
orbit bench tasks robolab-native --json
```

The build accepts `--build-arg ISAACLAB_BASE=<immutable image reference>` for a pinned copy of the
official `nvcr.io/nvidia/isaac-lab:2.2.0` image. Registration resolves the finished image to its
immutable identity, verifies the source revision and freezes all native Python source hashes.
It also reconstructs the published asset tree from Git objects and Git LFS object hashes, rejecting
missing assets, altered content and unresolved LFS pointers. Assets mount read-only at the native
`/opt/robolab/assets` path. `resources.json` is bound to the registration, rather than relying on a
manual command-line resource override.

## Run two real tasks with a negative control

The optional hold-position policy is explicitly marked `kind: calibration`. It copies the seven
observed joint angles as absolute targets and retains the observed binary gripper state. It is a
negative control for simulator execution and the evidence chain, not a trained model or a positive
oracle. It consumes no GPU and uses the same image's ordinary Python entry point without launching
Isaac. Native success is still recorded if the environment reports it; the fixture never hard-codes
a score.

Generate it explicitly, register it separately, then freeze one sample for each of the two upstream
recommended sanity tasks:

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/robolab/configure_robolab.py \
  --robolab-source "$ROBOLAB_SOURCE" --assets "$ROBOLAB_SOURCE/assets" \
  --benchmark-image orbit/robolab-simulator:reference --output-dir "$ROBOLAB_CONFIG" \
  --with-hold-calibration
orbit bench add-file "$ROBOLAB_CONFIG/benchmark.json"
orbit policy add "$ROBOLAB_CONFIG/hold-policy.json"

python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$ROBOLAB_SOURCE" --reference-file "$ROBOLAB_CONFIG/reference.json" \
  --task BananaInBowlTask --task RubiksCubeAndBananaTask \
  --initial-state 0 --environment-seed 0 > "$ROBOLAB_CONFIG/samples.json"
orbit bench run robolab-native \
  --method hold=policy,policyRef=robolab-hold-calibration \
  --sample-plan "$ROBOLAB_CONFIG/samples.json" --batch-size 2
```

A passing integration check needs real camera observations, a completed native episode for each
sample, sealed action/native-result evidence and successful CPU verification. Check cleanup and
execution status separately from task success. The expected hold-control outcome is native failure
at the full horizon: 750 actions for `BananaInBowlTask` and 900 for `RubiksCubeAndBananaTask`.
A reset failure, missing native verdict, resource failure or watchdog timeout is not a valid zero.
The batch also checks that closing one environment leaves the process-wide Isaac application usable
for the next sample. Native HDF5 writers close before evidence is sealed, including invalid
completed episodes; their later environment cleanup cannot rewrite the sealed file. A failed
evidence finalizer invalidates the episode. CPU verification does not start the simulator.

The source catalog supports all 120 tasks by default. `--tasks TASK [TASK ...]` creates an explicit
subset registration; selection changes its frozen profile digest. `--benchmark-only` makes the
no-policy intent explicit and cannot be combined with `--with-hold-calibration`.

## Native protocol and independent policies

- Reset seeds are `environmentSeed + int(initialStateId)` and must fit unsigned 32-bit integers.
  Each sample creates one native environment and executes the official runner's two initial resets.
- Physics runs at 120 Hz with decimation 8, so policy actions run at 15 Hz. Native task duration
  determines the horizon. There are no added settling actions or changed success tolerances.
- Observations are native 720 × 1280 HWC uint8 shoulder-left and wrist RGB, seven joint angles in
  radians, one normalized gripper position and the default instruction. Native proprioceptive noise
  is disabled by `enable_corruption=False`; the adapter does not add image resizing or state noise.
- The eight actions are seven absolute joint targets in radians and the native gripper command
  (`0` open, `1` close; native threshold `> 0.5`). They are not Cartesian deltas.
- Success and termination come from `RobolabEnv.get_env_results()` and `all_terminated`. RoboLab
  ignores some first-two-step termination artifacts by resetting internally, so raw Gym termination
  flags alone are insufficient. A run without a native final verdict remains invalid.

A separately registered `policy-ws` service can use the semantic profile in `reference.json`.
The official [DROID policy clients](https://github.com/NVlabs/RoboLab/tree/9cce00cadd5dc575fd2b8ea3836f5bdcde574229/policies/pi0_family)
support Pi0, Pi0-FAST and Pi0.5 joint-position checkpoints. Model serving, image preprocessing,
checkpoint identity and resource requirements belong in that independent policy service.
Use `--replan-steps 15` when deliberately selecting the official Pi0.5 DROID chunk recipe; the default
benchmark recipe uses one action per policy call. Replan length is frozen and must match the policy.

For a positive simulator sanity check, upstream includes a successful recorded
`RubiksCubeAndBananaTask` episode and [its native replay procedure](https://github.com/NVlabs/RoboLab/blob/9cce00cadd5dc575fd2b8ea3836f5bdcde574229/docs/replay.md).
Run that procedure through an Orbit GPU Run with the recorded data and exact native configuration.
It restores the recorded initial state, so it is a separate replay check, not a policy result on the
seed-generated sample plan above. Do not substitute replay scores for a trained policy comparison.

## Development verification

```bash
PYTHONPATH=examples/sdk python3 -B -m unittest orbit_embodied.test_robolab -v
```

These are explicitly synthetic tests for source and asset identities, reset ordering, native result
handling, action semantics and application lifetime. They do not attest real Isaac execution or
positive calibration. The native two-task hold check, independent CPU verification, rescore and
separate official successful replay have passed; see the [development record](../../../../../docs/tasks/20261109-robodojo-robolab.md).
Trained-policy calibration and full-suite statistical equivalence remain unverified.
