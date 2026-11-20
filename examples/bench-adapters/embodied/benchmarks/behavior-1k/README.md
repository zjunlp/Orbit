# BEHAVIOR-1K native Policy evaluation

This family extends the existing native embodied adapter with the original
[BEHAVIOR-1K evaluator](https://github.com/StanfordVL/BEHAVIOR-1K) at commit
b544acbbb76b461349bcba21f93b870b11da6608 and its 2026 R1Pro public-test recipe.
It adds no Agent loop, Run lifecycle or scheduler.

Every released BDDL activity remains visible. Activities absent from installed
2026 challenge metadata are explicitly unsupported. This is not a claim that all
thousand activities have public challenge instances or have been calibrated.

## Native conditions

- Frozen samples select public-test ordinals 0–19, mapping to native IDs 301–320.
  Environment seed stays 0; ordinals are not added to random seeds.
- Original BatchedEvaluator.run owns reset, settling, first-query allowance,
  wall-clock deadlines, termination and metrics. The native budget remains
  int(1.5 * human_demo_length).
- R1Pro uses 23D native commands: base 3, trunk 4, each arm 7 and each gripper 1.
  Native camera buffers are 224×224 RGBA; proprioception and poses are unchanged.
- Independent policy-ws Policy definitions must match the generated semantic
  profile and emit one native action per query.
- CPU verification checks saved actions, termination, native instance identity,
  Q-score and evidence digests. Rescore starts neither simulator nor model.
- Primary score is final Q-score; native success is separate. No reference Policy
  is released. A no-op baseline need not score zero. Parallel environments and
  shared-process batches are not exposed by this recipe.

## Licensed setup

Prepare behavior-1k-assets, omnigibson-robot-assets, 2026-challenge-task-instances
and omnigibson.key through the official installation workflow. The user must accept
its data license. This adapter does not accept terms or download keys automatically.

Verify the pinned checkout before building the upstream and wrapper images. The wrapper
receives the verified revision explicitly because the upstream image excludes Git metadata.
Registration also checks the image's tracked OmniGibson, BDDL and JoyLo file contents
against the pinned checkout in a read-only CPU container. Registration and Solve
use the wrapper image's Python launcher with the same pinned source paths and user
site packages disabled.

~~~bash
BEHAVIOR_SOURCE=/path/to/BEHAVIOR-1K
BEHAVIOR_REVISION=$(git -C "$BEHAVIOR_SOURCE" rev-parse HEAD)
test "$BEHAVIOR_REVISION" = b544acbbb76b461349bcba21f93b870b11da6608 &&
test -z "$(git -C "$BEHAVIOR_SOURCE" status --porcelain -- OmniGibson bddl3 joylo)" &&
docker build --label orbit.task=behavior-robotagent \
  -f "$BEHAVIOR_SOURCE/docker/Dockerfile" \
  -t behavior-native:local "$BEHAVIOR_SOURCE" &&
docker build --label orbit.task=behavior-robotagent \
  --build-arg BEHAVIOR_SOURCE="$BEHAVIOR_REVISION" \
  --build-arg BEHAVIOR_BASE=behavior-native:local \
  -f examples/bench-adapters/embodied/benchmarks/behavior-1k/behavior.Dockerfile \
  -t orbit-behavior:local .
orbit data add behavior1k-licensed-data /path/to/prepared-data
python3 examples/bench-adapters/embodied/benchmarks/behavior-1k/configure_behavior.py \
  --source "$BEHAVIOR_SOURCE" --data /path/to/prepared-data \
  --benchmark-image orbit-behavior:local --output-dir /path/to/private-config
orbit bench add-file /path/to/private-config/benchmark.json
~~~

To freeze installed assets before a compatible simulator image is available, pass
--reference-only with --source, --data and --output-dir. This writes only the
reference profile and starts neither simulator nor model. Per-task Run watchdogs
include the original rollout budget plus startup and first-query allowances.

Review upstream runtime terms before building. A working RTX/Vulkan runtime is
required; import success does not establish rendering readiness. Use the shared
embodied/plan.py and independent Policy onboarding workflow. Resource estimates
are provisional; source/CPU checks do not replace native physics calibration.
