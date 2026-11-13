# Native embodied benchmark and policy setup

Start with the [embodied quickstart](../../../docs/guides/embodied-quickstart.md) to run an evaluation
and review its Trial. The [coverage and verified-policy guide](../../../docs/guides/embodied-compatibility.md)
records benchmark scope, tested model checkpoints and evidence.

Run the setup commands from the repository root. The adapter directory is organized by role:

| Path | Contents |
| --- | --- |
| `benchmarks/<family>/` | Native setup, asset preparation, simulator image recipes and usage guides |
| `policies/<family>/` | Model services, model image recipes, checkpoint tools and dependencies |
| `profiles/` | Checked-in reference profiles for benchmark recipes and policies |
| `runtime/` and `fixtures/` | Shared renderer configuration and calibration policies |

Use the root `adapter.py` for benchmark registration and `plan.py` for frozen sample plans.
`run.py` is the container entry point for Solve and Verify.
When generating a registration for a recipe that checks the Dockerfile digest, use an image built
from the current recipe.

| Benchmark or runtime | Setup |
| --- | --- |
| LIBERO | [OpenPI π₀.₅](benchmarks/libero/README.md) · [All suites](../../../docs/guides/libero-suites.md) · [GR00T N1.7](policies/groot/README.md) · [OpenVLA-OFT](policies/openvla-oft/README.md) · [SmolVLA and MolmoAct2](benchmarks/tabletop/README.md) · [Fast-WAM](policies/fast-wam/README.md) |
| LIBERO-Plus | [Perturbation suites and OFT](benchmarks/libero-plus/README.md) |
| LIBERO-PRO | [Original leaderboard perturbations](benchmarks/libero-pro/README.md) |
| VLABench | [Native tracks and OpenWAM](benchmarks/vlabench/README.md) |
| SimplerEnv | [Native catalogs and scene grids](benchmarks/simpler-env/README.md) · [GR00T N1.7](policies/groot/README.md) · [StarVLA QwenGR00T](policies/starvla/README.md) |
| RoboCasa v0.2 | [Atomic-24](benchmarks/robocasa-v02/README.md) |
| RoboCasa365 | [Multitask, Lifelong, π₀.₅, GR00T N1.5 and Diffusion Policy](benchmarks/robocasa365/README.md) |
| RoboTwin 2.0 | [Clean, Randomized, π₀.₅ and X-VLA](benchmarks/robotwin/README.md) · [LingBot-VLA](policies/lingbot-vla/README.md) · [Fast-VLA](policies/fast-vla/README.md) |
| ManiSkill3 and Meta-World | [Tabletop, Plate-25 and MT50](benchmarks/tabletop/README.md) |
| RLBench | [MT100 and RVT-18](benchmarks/rlbench/README.md) |
| CALVIN | [ABC→D](benchmarks/calvin/README.md) |
| RoboDojo and RoboLab | [RoboDojo](benchmarks/robodojo/README.md) · [RoboLab](benchmarks/robolab/README.md) |
| RoboMimic | [PH low-dimensional and RGB profiles](benchmarks/robomimic/README.md) |
| VIMA-Bench | [Test partitions and VIMA 20M](benchmarks/vima-bench/README.md) |
| MolmoSpaces-Bench | [MS manipulation tracks](benchmarks/molmospaces/README.md) |
| Colosseum V2 | [Single-arm and bimanual perturbation protocols](benchmarks/colosseum-v2/README.md) |
| VLA-Arena | [Difficulty levels and safety scoring](benchmarks/vla-arena/README.md) · [DM0.5](policies/dm05/README.md) |
| BiGym 2.0 | [G1 learned-policy evaluation](benchmarks/bigym2/README.md) |
| CLIPort | [Language-conditioned test and reference policy](benchmarks/cliport/README.md) |

The adapter lists native tasks and runs frozen samples. Orbit attaches the independently registered
model service for Solve. A separate CPU Run verifies the saved evidence for each episode.
The legacy vla-eval registrations are a separate route.

For integration work, see the [onboarding template](../../../docs/guides/embodied-onboarding.md) and
[development checks by Python environment](../../../docs/guides/embodied-development.md).
Keep upstream sources, weights, generated registrations and run artifacts outside the source checkout.
