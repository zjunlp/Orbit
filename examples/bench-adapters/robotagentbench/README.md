# RobotAgentBench native raw-22 adapter

Evaluates a registered Agent CLI through the pinned upstream
[RobotAgentBench](https://github.com/AetherLabsAI/RobotAgentBench) worker
(fa207f52d8da139f591f9dc590eb002c58f72383). Orbit owns the Agent invocation,
resource leases, private simulation service, cleanup and independent verification.
The adapter contains no model loop or alternative simulator.

## Scope and conditions

The complete saved-instances-0.2.17 release stays visible: 49 groups × 30 saved
configurations. The ordinary room profile can prepare 29 groups. Cloth, recovery,
atomic owners and OpenEnd/discovery scoring are explicitly unsupported here.
An unprepared group is visible with its setup reason. Long-task native result shapes
still require native calibration; an unknown denominator fails verification.

The public interface uses the original RawRobotBridge and tool schemas: observe,
execute_actions and done. Native 22D rows contain 20 absolute joint targets followed
by base forward/yaw velocity, in original units at 20 Hz. Native cameras, instructions,
measured state and explored maps remain unchanged. No IK, projection or action retry
is added. This raw-tool profile is distinct from the upstream coding-policy interface.

An Orbit seed selects a saved configuration ordinal 1–30. Its original actual_seed is
preserved, not resampled. The original owner owns simulation limits, stopping and
scores. The empty control holds measured joints with zero base velocity until native
termination. Calling done early is abandonment and invalid, not a valid zero.

Verification requires a delayed closed acknowledgement, native worker exit 0,
unchanged source layers, original shutdown receipt and a finished native task result.
Native total / maximum is the primary score; success is separate. Signed evidence
supports CPU rescore without restarting simulator or model. The Agent receives only
the public tool client; private inputs, receipts and signing key stay in the service.

## Setup

Use Python 3.11 and follow the upstream INSTALL, RUNTIME and MODEL_QUICKSTART guides
to download the pinned asset release, configure a room Runtime and restore a saved
configuration. Keep all assets, Runtime copies and registrations outside this checkout.
Review and accept the NVIDIA runtime terms before invoking native setup.

Build the upstream docker/Dockerfile, wrap the native image using Dockerfile.native,
then prepare the native deployment against that final immutable image ID using the
upstream CPU-only namespace --prepare-native command. Build this directory's Dockerfile
for the Agent/CPU verifier. The Agent image contains no simulator or private grader.

~~~bash
python3.11 examples/bench-adapters/robotagentbench/prepare.py \
  --source /path/to/RobotAgentBench --selection /private/selection/selection.json \
  --native-image orbit-robotagent-native:local --agent-image orbit-robotagent-agent:local \
  --deployment prepared-name --lock-root /private/robot-locks \
  --output-dir /private/robotagent-registration
orbit bench add-file /private/robotagent-registration/benchmark.json
orbit bench tasks robotagentbench-raw22
orbit bench run robotagentbench-raw22 -t short/prepare_coffee -m empty --seeds 1
~~~

prepare.py validates the original restoration and namespace without executing Docker
or starting physics. It exports existing bindings into Orbit's service contract.
Each solve makes a private Runtime copy with reflinks when supported; writable
source/cache aliases point to that copy and retain their original container paths.
The original Runtime stays unchanged. Templates must copy within the adapter's
90-second preparation budget. Simulator caches are never shared between concurrent
trials; the original lock root remains shared.

Resources are provisional: Agent 2 CPU / 4GB; native service 8 CPU / 32GB / one RTX GPU
with at least 16GB VRAM. Native physics/model calibration is pending; CPU fixtures and
contract checks do not establish task success or parity with upstream results.

CPU development checks use explicit upstream worker fixtures, without starting physics:

~~~bash
python3 examples/bench-adapters/robotagentbench/check_native.py --source /path/to/RobotAgentBench
python3 examples/bench-adapters/robotagentbench/check_mcp.py --source /path/to/RobotAgentBench
~~~

The second check requires the pinned MCP package installed by the Agent image.
DEBIAN_MIRROR and PIP_INDEX_URL are optional image build arguments; defaults use the official sources.
