# Native embodied benchmark and policy setup

Start with the [embodied quickstart](../../../docs/guides/embodied-quickstart.md) to run an evaluation
and review its Trial. The [coverage and verified-policy guide](../../../docs/guides/embodied-compatibility.md)
records benchmark scope, tested model checkpoints and evidence.

| Benchmark or runtime | Setup |
| --- | --- |
| LIBERO | [OpenPI π₀.₅](OPENPI-LIBERO.md) · [All suites](../../../docs/guides/libero-suites.md) · [GR00T N1.7](GR00T.md) · [OpenVLA-OFT](OPENVLA.md) · [SmolVLA and MolmoAct2](NATIVE-EXPANSION.md) |
| LIBERO-Plus | [Perturbation suites and OFT](LIBERO-PLUS.md) |
| VLABench | [Native tracks and OpenWAM](VLABENCH.md) |
| SimplerEnv | [Native catalogs and scene grids](SIMPLER.md) · [GR00T N1.7](GR00T.md) |
| RoboCasa v0.2 | [Atomic-24](ROBOCASA-V02.md) |
| RoboCasa365 | [Multitask, Lifelong, π₀.₅, GR00T N1.5 and Diffusion Policy](ROBOCASA365.md) |
| RoboTwin 2.0 | [Clean, Randomized, π₀.₅ and X-VLA](ROBOTWIN.md) |
| ManiSkill3 and Meta-World | [Tabletop, Plate-25 and MT50](NATIVE-EXPANSION.md) |
| RLBench | [MT100 and RVT-18](RLBENCH.md) |
| CALVIN | [ABC→D](CALVIN.md) |
| RoboDojo and RoboLab | [RoboDojo](ROBODOJO.md) · [RoboLab](ROBOLAB.md) |
| RoboMimic | [PH low-dimensional and RGB profiles](ROBOMIMIC.md) |
| VIMA-Bench | [Test partitions and VIMA 20M](VIMA-BENCH.md) |
| MolmoSpaces-Bench | [MS manipulation tracks](MOLMOSPACES.md) |
| Colosseum V2 | [Single-arm and bimanual perturbation protocols](COLOSSEUM.md) |

The adapter lists native tasks and runs frozen samples. Orbit attaches the independently registered
model service for Solve. A separate CPU Run verifies the saved evidence for each episode.
The legacy vla-eval registrations are a separate route.

For integration work, see the [onboarding template](../../../docs/guides/embodied-onboarding.md) and
[development checks by Python environment](../../../docs/guides/embodied-development.md).
Keep upstream sources, weights, generated registrations and run artifacts outside the source checkout.
