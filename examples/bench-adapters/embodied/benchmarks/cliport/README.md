# Native CLIPort

The two registrations cover all 18 entries in the upstream `multi-language-conditioned`
test split, including the seen and unseen variants.

| Benchmark | Tasks | Native action |
| --- | --- | --- |
| `cliport-language-test-native` | 16 suction tasks | Pick and place XYZ and XYZW quaternion pairs, 14 values in total |
| `cliport-language-test-push-native` | 2 Separating Piles variants | Spatula push from one XY endpoint to another, 4 values in total |

Both actions use world coordinates in metres. The native push primitive computes its own
height and tool rotation. Orbit checks the task's primitive and end effector at reset
and enforces the corresponding action profile when binding a policy.

The original TransporterNets demo-conditioned split uses goal images and is a separate
upstream recipe.

The simulator uses PyBullet 3.0.4 in DIRECT mode on CPU and advances physics at 480 Hz.
A policy receives three RGB-D camera pairs and the current language subgoal.
The episode ends at the primitive limit computed during reset or when the simulator
signals termination. The primary score is the sum of native rewards for the episode,
including partial credit. A reward above 0.99 is reported as an
additional completion metric. The 5 fps review video advances one frame per primitive.

[Upstream source and quickstart](https://github.com/cliport/cliport/tree/2be5c47b5bb9bb7040ad90693288b87b1e18e7ad) ·
[Official v1.0.0 assets and checkpoint](https://github.com/cliport/cliport/releases/tag/v1.0.0)

## Build and freeze the test plan

Use a host Python 3.11 virtual environment with NumPy and place sources, assets, weights
and generated files outside the Orbit checkout. Download the release's `google.zip`
(SHA-256 `294dca8ba54d8af66f228bdc2c035e43ff2f39f5868f23b26ab455b0859af768`) and
extract the `google/` directory as `CLIPORT_GOOGLE_ASSETS`. The image contains the other
simulator assets from the pinned source.

```bash
git clone https://github.com/cliport/cliport "$CLIPORT_SOURCE"
git -C "$CLIPORT_SOURCE" checkout 2be5c47b5bb9bb7040ad90693288b87b1e18e7ad
configurator=examples/bench-adapters/embodied/benchmarks/cliport/configure_cliport.py
python3 -B "$configurator" --source "$CLIPORT_SOURCE" --build-tag orbit/cliport:reference
python3 -B "$configurator" --source "$CLIPORT_SOURCE" --benchmark-image orbit/cliport:reference \
  --google-assets "$CLIPORT_GOOGLE_ASSETS" --plan-seeds "$CLIPORT_CONFIG/test-seeds.json" --jobs 4
python3 -B "$configurator" --source "$CLIPORT_SOURCE" --benchmark-image orbit/cliport:reference \
  --google-assets "$CLIPORT_GOOGLE_ASSETS" --seed-catalog "$CLIPORT_CONFIG/test-seeds.json" \
  --output-dir "$CLIPORT_CONFIG"

config="$CLIPORT_CONFIG/cliport-language-test-native"
orbit data add cliport-google-assets "$CLIPORT_GOOGLE_ASSETS"
orbit bench add-file "$config/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$CLIPORT_SOURCE" \
  --reference-file "$config/reference.json" --all-tasks --initial-state 0 > "$config/samples.json"
```

To register and plan the push suite, repeat the last two commands with
`config="$CLIPORT_CONFIG/cliport-language-test-push-native"`.

The seed planner starts from 10001, tries odd seeds in order, and keeps those where
the native oracle accumulates a reward above 0.99. It freezes the accepted seeds,
their post-reset primitive limits, the simulator image and the Google asset digest.
Each oracle worker uses its own temporary URDF directory. Each reset starts with
the original task palettes and seeds both NumPy and Python RNGs so the scene and language
are reproducible when run alone or in a batch. The default is 100
accepted seeds per task, for 1,800 samples. Use `--episodes 1` for a short catalogue,
or `--all-initial-states` in `plan.py` to expand a complete catalogue. The full plan
can take substantially longer to prepare than the short catalogue. Regenerate older seed
catalogues and sample plans that only froze the seeds. The new registration checks
that reset reproduces the frozen limit, and CPU verification enforces that limit.

## Run the released CLIPort policy

The benchmark can be registered without model weights. To run the released reference
policy, extract the multi-language-conditioned 1000-demo checkpoint
`steps=400000-val_loss=0.00014655.ckpt` as `model.ckpt` and the matching
`.hydra/config.yaml` as `config.yaml` from the official quickstart archive.
Add the [OpenAI CLIP RN50 weights](https://openaipublic.azureedge.net/clip/models/afeb0e10f9e5a86da6080e35cf09123aca3b358a0c3e3b6c78a7b63bc04b6762/RN50.pt)
as `RN50.pt`. Put all three files under `CLIPORT_WEIGHTS`. The configurator and the
offline policy service check their digests. The service preserves the module modes
from the upstream checkpoint loader, including training-mode BatchNorm in the U-Net.
The same weights serve both profiles. The push Policy sends the two XY endpoints from
the model's pose predictions. When upgrading from the combined registration, reuse a
version 2 seed catalogue for the same simulator image, regenerate the two registrations
and sample plans, and rebuild the Policy image. The new pick/place Policy is version 3.
The service requests one CUDA GPU independently
of the CPU simulator. Set GPU eligibility in the [daemon configuration](../../../../../docs/guides/multi-node.md).

```bash
policy=examples/bench-adapters/embodied/policies/cliport/configure_cliport_policy.py
python3 -B "$policy" --source "$CLIPORT_SOURCE" --build-tag orbit/cliport-policy:reference
python3 -B "$policy" --source "$CLIPORT_SOURCE" --policy-image orbit/cliport-policy:reference \
  --reference-file "$config/reference.json" --weights "$CLIPORT_WEIGHTS" \
  --output "$CLIPORT_CONFIG/policy.json"

orbit data add cliport-multi-language "$CLIPORT_WEIGHTS"
orbit policy add "$CLIPORT_CONFIG/policy.json"
orbit bench run cliport-language-test-native --sample-plan "$config/samples.json" \
  --method cliport=policy,policyRef=cliport-multi-language
```

For the push suite, set `config` to the push registration directory, generate and add a
Policy definition with that reference, then run `cliport-language-test-push-native`
with `--method cliport=policy,policyRef=cliport-multi-language-push`. Both Policy
definitions use the same `cliport-multi-language` weights dataset.
