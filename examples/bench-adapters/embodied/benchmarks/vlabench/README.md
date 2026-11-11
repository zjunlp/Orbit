# Native VLABench and OpenWAM

VLABench is a native MuJoCo / dm_control benchmark. Orbit registers the simulator tracks independently of OpenWAM, whose weights and inference runtime are registered as a policy. The native policy evaluator uses a Franka arm.

| Track | Released tasks | Fixed scenes |
| --- | ---: | ---: |
| 1 In distribution | 10 | 500 |
| 2 Cross category | 10 | 460 |
| 3 Common sense | 10 | 500 |
| 4 Semantic instruction | 10 | 500 |
| 5 Cross task | 96 native task IDs | Seeded |
| 6 Unseen texture | 10 | 500 |

Track 2 includes a task with 10 episodes. Orbit expands each task's actual episode count. Track 5 leaves the train/eval split open. Use the native task IDs and explicit initial-state indices to define the evaluation set. The default environment seed is 42 and the index is added to it. Fixed tracks use the published episode objects and the same seed formula to freeze incidental randomness. The runtime injects the sample seed into dm_control before the loader's first reset and checks the mounted assets once per solve Run. Track 5 covers the tasks registered by the pinned policy simulator, including physical reasoning and composite manipulation. Seed-sampled scenes can fail native initialization. Orbit records those failures against the selected sample.

Orbit follows the native task-specific horizon, takes one simulator step per command and uses the evaluator's final timestep for success. It saves native intention and progress as separate metrics where the task provides them. Some composite tasks disable the native tracking used by these scorers. The runtime fixes malformed positions in two clustering tasks, preserves their configured receptacle placement, and honors the explicit cylinder and capsule shapes in the weight experiment. The official success rule averages per-task rates over valid episodes. Simulator errors remain visible in the job.

## Build and register

Use VLABench at `cf588fe60c0c7282174fe979f5913170cfe69017` and [rrt-algorithms](https://github.com/motion-planning/rrt-algorithms) at `e51d95ee489a225220d6ae2a764c4111f6ba7d85`. Fetch both archives via VLABench's `scripts/download_assets.py` or its linked Drive files. Place the extracted `obj` and `scenes` directories together in `$VLABENCH_ASSETS`. Git supplies the robot and base assets. [Upstream VLABench](https://github.com/OpenMOSS/VLABench/tree/cf588fe60c0c7282174fe979f5913170cfe69017)

A complete public mirror is available for servers that cannot reach the Drive downloads. Its tar SHA-256 is `d0ed07d35e49cc39e16cbe1982bda326942816b41fdaf776187534f1fdf3e5ff`. Use the mirror's `assets/obj` and `assets/scenes` directories. [VLABench asset mirror](https://huggingface.co/datasets/SeonghoonYu/VLABench_assets/tree/e5793eb9af41483c990534f542a572d0f0f81501)

Build the existing `native-gym.Dockerfile` base as described in [SimplerEnv setup](../simpler-env/README.md) and set `$NATIVE_GYM_BASE` to its image. Set `$VLABENCH_SOURCE`, `$RRT_SOURCE`, and `$LOCAL_CONFIG` to your local directories. To provision OpenWAM too, set `$OPENWAM_SOURCE` to revision `090c4d41668fcb238d77d3d5a2da9183088b119c` and `$OPENWAM_WEIGHTS` to the downloaded VLABench inference checkpoint directory. [OpenWAM reference recipe](https://github.com/OpenWAM-Official/OpenWAM/tree/090c4d41668fcb238d77d3d5a2da9183088b119c/benchmarks/vlabench) · [OpenWAM VLABench weights](https://huggingface.co/OpenWAM/OpenWAM-Alpha-Sim-VLABench/tree/480d3bc77b298434e69400a884a416d7196e677c)

```bash
docker build --build-arg BENCHMARK_BASE="$NATIVE_GYM_BASE" \
  --build-context vlabench="$VLABENCH_SOURCE" --build-context rrt="$RRT_SOURCE" \
  -f examples/bench-adapters/embodied/benchmarks/vlabench/vlabench.Dockerfile -t orbit/vlabench:reference .

docker build --target openwam --build-arg VCS_REF="$(git -C "$OPENWAM_SOURCE" rev-parse HEAD)" \
  -f "$OPENWAM_SOURCE/docker/Dockerfile" \
  -t orbit/openwam-upstream:reference "$OPENWAM_SOURCE"
docker build --build-arg OPENWAM_BASE=orbit/openwam-upstream:reference \
  -f examples/bench-adapters/embodied/policies/openwam/openwam-policy.Dockerfile -t orbit/openwam-policy:reference .

python3 examples/bench-adapters/embodied/benchmarks/vlabench/configure_vlabench.py --source "$VLABENCH_SOURCE" \
  --assets "$VLABENCH_ASSETS" --benchmark-image orbit/vlabench:reference \
  --weights "$OPENWAM_WEIGHTS" --policy-image orbit/openwam-policy:reference --output-dir "$LOCAL_CONFIG"

orbit data add vlabench-assets "$VLABENCH_ASSETS"
orbit data add openwam-alpha-sim-vlabench "$OPENWAM_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/policy.json"
for track in "$LOCAL_CONFIG"/track-*; do
  orbit bench add-file "$track/benchmark.json"
done
```

Omit both policy flags to generate the benchmark registrations separately. OpenWAM uses the reference RGB camera order, base-relative EEF10 proprioception, and the native checkpoint's normalization. The policy converts its physical EEF10 output back to a world-frame target and two finger positions, and VLABench applies its own Franka IK. OpenWAM's action buffer resets between episodes, including episodes in one Orbit solve batch.

```bash
python3 examples/bench-adapters/embodied/plan.py --reference-source "$VLABENCH_SOURCE" \
  --reference-file "$LOCAL_CONFIG/track-1/reference.json" --all-tasks --all-initial-states \
  > "$LOCAL_CONFIG/track-1/samples.json"
orbit bench run vlabench-track-1-native \
  --method openwam=policy,policyRef=openwam-alpha-sim-vlabench \
  --sample-plan "$LOCAL_CONFIG/track-1/samples.json"
```

For a smaller check, use `--task select_fruit --initial-state 0`. Use explicit `--initial-state` indices for the seeded Track 5.

## Verification

Orbit registered all six tracks and expanded all 2,460 fixed episode configurations. The 96 cross-task IDs matched the live native registry. Thirteen reset, render, and control checks across the six tracks passed, including the two clustering tasks and the weight experiment. The released OpenWAM checkpoint completed a sampled Track 1 episode. Orbit independently verified its saved native success, intention and progress evidence in a separate CPU run.
