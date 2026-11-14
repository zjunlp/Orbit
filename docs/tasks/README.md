# Task records

One record per feature, substantive fix or design change (template in [AGENTS.md §5](../../AGENTS.md)).
Records are historical: they describe the work and validation at the time and are not updated afterwards.
Current behavior is in [design](../design.md) and [status](../status.md). Older records may use retired terms
(C1–C7 categories, L0/L1/L2 tiers, fidelity levels); see design §9.10 for the current concepts.

## Core platform: daemon, runs, resources, state

- [20260929](20260929-ts-rewrite-r0.md) R0: TypeScript rewrite skeleton (Orbit)
- [20260930](20260930-r1-research-loop.md) R1: single-node research loop
- [20260930](20260930-r4-multinode.md) R4: multi-node placement
- [20261001](20261001-code-review.md) Full-branch review: fixes and tidy-up of implemented code
- [20261002](20261002-cpu-external-load.md) CPU admission counts CPU use outside Orbit
- [20261005](20261005-data-dir-folders.md) Data directory and folders
- [20261006](20261006-gpu-processes.md) Who holds each GPU
- [20261008](20261008-preflight-smoke.md) Pre-flight checks and smoke runs
- [20261015](20261015-bundle-upload-eof.md) Drain bundle uploads through EOF
- [20261015](20261015-hot-paths.md) Hot-path performance and resource use
- [20261015](20261015-security-hardening.md) Security hardening
- [20261015](20261015-state-integrity.md) State and data integrity
- [20261016](20261016-run-checkpoints.md) Failed-run checkpoints and session continuation
- [20261103](20261103-snapshot-index-race.md) Preserve Git snapshot race detection
- [20261104](20261104-p5-core-capabilities.md) P5：资源与执行能力（设备、按卡型分配、结束阶段持久化）
- [20261104](20261104-p7-scale.md) P7：规模与可靠性（对账回收、主机保护、能力路由、catalog）
- [20261105](20261105-start-watchdog.md) 启动看门狗：镜像拉取与构建的期限
- [20261106](20261106-gpu-sharing.md) Joint GPU admission and shared GPU memory budgets

## Agents, auth, plugins, notifications

- [20261113](20261113-run-trajectory.md) Run trajectory generation, storage, API/CLI and session projection
- [20261113](20261113-token-accounting.md) T3: session token accounting in Runs, reports and comparisons
- [20261112](20261112-atif-trajectory.md) ATIF contract and native Codex / Claude Code converters

- [20260930](20260930-r2-auth-notify.md) R2: agent auth profiles and notifications
- [20261008](20261008-agent-plugins.md) Codex, dsh and pi plugin distribution
- [20261008](20261008-feishu-app.md) Feishu app: phone access through a long connection
- [20261008](20261008-feishu-init.md) Feishu bot setup by QR code
- [20261008](20261008-npm-plugin-install.md) npm distribution and one-command Claude Code plugin installation
- [20261013](20261013-public-release-deps-licenses.md) Release dependency and license fixes
- [20261103](20261103-agent-registry.md) Agent 注册表与自定义 Agent
- [20261106](20261106-codex-gui.md) Codex GUI 能力验证与启用
- [20261106](20261106-codex-startup-validity.md) Codex 启动配置失败的评测有效性

## Bench core: protocol, validity, metrics, reports

- [20260930](20260930-r3-bench.md) R3: benchmarks on the Run / lease model
- [20261003](20261003-bench-adapter-protocol.md) Bench adapter protocol and ResearchClawBench
- [20261003](20261003-bench-resources-usage.md) Per-task bench resources and measured run usage
- [20261004](20261004-bench-validity-checks.md) Bench validity: Agent errors and hidden ASI scorer failures
- [20261005](20261005-bench-metrics.md) Bench metrics declared by adapters
- [20261008](20261008-bench-rescore.md) Rescore bench trials without rerunning the Agent
- [20261009](20261009-bench-timeout-classification.md) Cross-adapter timeout classification
- [20261010](20261010-bench-consolidate.md) Consolidate completed benchmark retries
- [20261011](20261011-bench-append-tasks.md) Append completed benchmark tasks
- [20261013](20261013-agent-failure-reconcile.md) Reconcile terminal Agent failures before consolidation
- [20261015](20261015-agent-failure-skip-verify.md) Skip verification when the Agent could not use its model
- [20261015](20261015-bench-adapters.md) Bench and adapter correctness
- [20261015](20261015-bench-failed-retry-consolidation.md) Explicit consolidation of failed attempts
- [20261015](20261015-bench-invalid-attempt-consolidation.md) Retain completed invalid retry attempts
- [20261103](20261103-eval-identity.md) 评测身份、官方口径与报告修订（P2）
- [20261104](20261104-p65-integration.md) P6.5：接入层（覆盖盘点、自动校准、Harbor GPU 补全、L1 清单、L2 SDK）
- [20261110](20261110-bench-adapter-organization.md) Bench adapter organization
- [20261111](20261111-drop-legacy-categories.md) Drop legacy categories from code, and audit hotspots
- [20261111](20261111-bench-core-decoupling.md) Decouple bench core from specific benchmarks, split calibration and trial views
- [20261111](20261111-bench-trial-machine.md) Move the trial state machine out of BenchService
- [20261112](20261112-web-polish.md) Web page layout and visual consistency
- [20261112](20261112-trial-review-views.md) Trial page: tests and rubric views, grouped evidence, leaner header

## Harbor and code / research benchmarks

- [20261009](20261009-asi-runner-timeouts.md) ASI runner compatibility and execution status
- [20261009](20261009-asi-verify-budgets.md) ASI native verification budgets
- [20261010](20261010-harbor-collect-hooks.md) Harbor collect hooks and Terminal-Bench 4.0 coverage
- [20261010](20261010-harbor-shared-verifier.md) Harbor shared verifier mode (after phase)
- [20261010](20261010-harbor-sidecars.md) Service containers for Harbor docker-compose tasks
- [20261010](20261010-harbor-verifier-modes.md) Harbor verifier modes and task settings
- [20261010](20261010-harness-parity.md) Agent harness parity with Harbor, benchmark versions
- [20261017](20261017-longds-bench.md) LongDS-Bench adapter
- [20261105](20261105-sample-bfcl-multiturn.md) BFCL multi-turn category sample
- [20261105](20261105-sample-tau2.md) Direct τ²-bench user-session sample
- [20261105](20261105-samples-c1-c7.md) C1 / C7 样板：HumanEval（固定输入）与 TextArena（游戏）
- [20261110](20261110-benchmark-gaps.md) Native benchmark integrations and availability
- [20261110](20261110-harbor-verifier-gpu-models.md) Preserve Harbor verifier GPU model requirements

## GUI benchmarks

- [20261102](20261102-gui-bench-web.md) GUI benchmark Web workflow
- [20261102](20261102-gui-browsergym.md) GUI phase one: BrowserGym / MiniWoB
- [20261103](20261103-gui-bench-research.md) GUI benchmark infrastructure research
- [20261104](20261104-p3-browsergym-efe.md) P3：BrowserGym 全套与 EFE 原条件任务
- [20261104](20261104-p5a-gui-hub-adapters.md) P5-A：GUI hub 外部适配器（并行线 A）
- [20261104](20261104-p6-cli-agent-bridge.md) P6 + P5-Web：CLI Agent 的 GUI 桥与场景化 Trial 视图（并行线 B）
- [20261104](20261104-p6-mainline.md) P6 主线：CLI Agent 桥的通用化、MCP 接线与 EFE coding agent

## Embodied: policies and native benchmarks

- [20261103](20261103-embodied-infra-research.md) 具身评测与调度基础设施源码调研
- [20261104](20261104-p4-policy.md) P4：Policy 路线与按角色分配 GPU
- [20261105](20261105-embodied-eval.md) Independent policies and native embodied benchmarks
- [20261106](20261106-embodied-batches.md) Fixed sequential embodied solve batches
- [20261106](20261106-embodied-endpoints.md) GR00T and OpenVLA-OFT endpoints, native SimplerEnv WidowX
- [20261106](20261106-policy-calibration.md) Bounded policy integration checks
- [20261107](20261107-embodied-review.md) Review fixes after merging the embodied integration
- [20261107](20261107-groot-google.md) GR00T N1.7 and native SimplerEnv Google Robot
- [20261107](20261107-libero-suites.md) LIBERO Object, Goal and Long coverage
- [20261107](20261107-robocasa365.md) Native RoboCasa365 Atomic-Seen
- [20261107](20261107-robocasa365-gr00t-n15.md) GR00T N1.5 on native RoboCasa365 Atomic-Seen
- [20261107](20261107-robotwin.md) Native RoboTwin 2.0 Clean
- [20261108](20261108-embodied-calvin-xvla.md) Native CALVIN ABC→D and RoboTwin X-VLA
- [20261108](20261108-embodied-native-expansion.md) SmolVLA, MolmoAct2, ManiSkill3 and Meta-World
- [20261108](20261108-libero-90.md) Native LIBERO-90 catalog
- [20261108](20261108-libero-90-rlinf.md) RLinf OpenVLA-OFT on native LIBERO-90
- [20261108](20261108-libero-timeline.md) LIBERO episode timeline
- [20261108](20261108-robocasa365-task-sets.md) RoboCasa365 multitask coverage
- [20261108](20261108-robotwin-review-fixes.md) RoboTwin sample rejection and CUDA build argument
- [20261108](20261108-robotwin-suites.md) RoboTwin 2.0 Clean and Randomized suites
- [20261108](20261108-robotwin-timeline.md) RoboTwin episode timeline
- [20261108](20261108-simplerenv-task-sets.md) SimplerEnv native catalogs and evaluation settings
- [20261109](20261109-embodied-benchmark-coverage.md) Native embodied benchmark coverage
- [20261109](20261109-libero-plus.md) Native LIBERO-Plus
- [20261109](20261109-openwam.md) OpenWAM VLABench policy
- [20261109](20261109-rlbench.md) Native RLBench
- [20261109](20261109-robocasa-v02.md) Native RoboCasa v0.2
- [20261109](20261109-robocasa365-diffusion-policy.md) Diffusion Policy on native RoboCasa365 Atomic-Seen
- [20261109](20261109-robodojo-robolab.md) Native RoboDojo and RoboLab integration
- [20261109](20261109-vlabench.md) Native VLABench
- [20261110](20261110-embodied-harness-benchmarks.md) Embodied harness benchmarks
- [20261110](20261110-robomimic.md) Native RoboMimic
- [20261110](20261110-vima-bench.md) Native VIMA-Bench
- [20261110](20261110-colosseum-v2.md) Native Colosseum V2
- [20261110](20261110-libero-pro.md) Native LIBERO-PRO
- [20261110](20261110-molmospaces.md) Native MolmoSpaces MS manipulation
- [20261110](20261110-vla-arena.md) Native VLA-Arena
- [20261111](20261111-embodied-directory.md) Native embodied adapter directory layout
- [20261111](20261111-embodied-policy-expansion.md) Native embodied policy expansion
- [20261112](20261112-dm05-vla-arena.md) DM0.5 on native VLA-Arena
- [20261112](20261112-fast-vla-robotwin.md) Fast-VLA on native RoboTwin 2.0
- [20261112](20261112-bigym2.md) Native BiGym 2.0 learned-policy evaluation
- [20261112](20261112-cliport.md) Native CLIPort language-conditioned evaluation
- [20261113](20261113-fast-wam.md) Fast-WAM on native LIBERO Spatial
- [20261113](20261113-lingbot-va.md) LingBot-VA on native RoboTwin 2.0 Clean
- [20261113](20261113-robotwin-september.md) RoboTwin 2.0 September suites
- [20261113](20261113-groot-n17-refresh.md) GR00T N1.7 inference refresh
- [20261113](20261113-fast-wam-libero-suites.md) Fast-WAM LIBERO suites and LeRobot 0.7.0
- [20261113](20261113-molmobot-v2.md) Native MolmoBot v2 evaluation
- [20261113](20261113-lingbot-vla-v2.md) LingBot-VLA 2.0 on native RoboTwin
- [20261114](20261114-libero-mem.md) Native LIBERO-Mem with ordered subgoals
- [20261114](20261114-eb-navigation.md) Native EB-Navigation and matched SeeNav/Qwen policies
- [20261114](20261114-eb-navigation-review.md) EB-Navigation policy input video and planner regression
- [20261114](20261114-xiaomi-robocasa365.md) Xiaomi-Robotics-1 on native RoboCasa365
- [20261114](20261114-gigaworld-robocasa365.md) GigaWorld-Policy-0.1 on native RoboCasa365

## Web, catalog and taxonomy

- [20261004](20261004-web-jobs-trials-delete.md) Web: bench jobs and trials in the run list, trial page, run names, deletion
- [20261015](20261015-opt5-structure-web.md) Structure and Web UX
- [20261105](20261105-web-catalog-conversation.md) Web：Catalog / 校准总览与 C3/C4 对话视图
- [20261106](20261106-web-ia.md) Web 信息架构与方法迭代
- [20261109](20261109-benchmark-category-cards.md) Benchmark dimensions and homepage discovery
- [20261109](20261109-benchmark-library.md) Supported benchmark library
- [20261109](20261109-benchmark-taxonomy.md) Benchmark taxonomy v1 and catalog facets
- [20261110](20261110-evaluation-configurations.md) Evaluation configurations in the Web UI
- [20261112](20261112-trial-review-views.md) Trial review views and grouped evidence
- [20261112](20261112-trial-evidence-shapes.md) Native episode timelines and TextArena game conversations

## Docs, presentation and integration merges

- [20261008](20261008-orbit-ppt.md) Orbit editorial HTML presentation
- [20261009](20261009-ppt-polish.md) Orbit presentation: product visuals and architecture
- [20261012](20261012-readme-vision.md) README vision and navigation
- [20261110](20261110-integrate-local-branches.md) Integrate completed local branches
- [20261110](20261110-integrate-ui-embodied.md) Integrate Web discovery and native embodied adapters
- [20261111](20261111-converge-concepts-docs.md) Converge benchmark concepts and organize docs
- [20261112](20261112-positioning-self-improving-lab.md) Positioning: the lab for self-improving agents
- [20261112](20261112-evolution-plan.md) Implementation plan: trajectories, export, fork and the evolution gate
- [20261113](20261113-integrate-branches.md) Integrate embodied expansion, ATIF converters and trial evidence views
