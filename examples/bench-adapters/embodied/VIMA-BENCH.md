# Native VIMA-Bench

Orbit registers the official PyBullet test partitions from
[VIMA-Bench](https://github.com/vimalabs/VIMABench/tree/97e0af11e126fd477c9d81eeabfb6c739021c680).
Placement and combinatorial have 13 task entries each, novel object has 12, and
novel task has 4. Across partitions there are 17 distinct templates. Each registration
uses its original task parameters and seeded scene generation.

The Policy receives front and top RGB and segmentation, the end-effector indicator,
the prompt with its original placeholders, and a base64 MessagePack field. Decode
the latter with `unpack_prompt_context` for example images, masks, object IDs and
action bounds. The 12-component action describes two XY positions and their XYZW
quaternions, in pick and place order. Orbit runs the native task primitive and
reports native success. The command limit follows the VIMA example's
`oracle_max_steps + 2` from task construction. Each sample tries its exact planned
seed and records a reset error if scene generation fails.

## Build and register

Use the pinned VIMA-Bench checkout as `$VIMA_BENCH_SOURCE`. The build exports the
source commit, including its simulator assets. The configurator reads all four
partitions from the resulting image and verifies the build manifest.

```bash
python3 -B examples/bench-adapters/embodied/configure_manipulation.py vima-bench \
  --source "$VIMA_BENCH_SOURCE" --build-tag orbit/vima-bench:reference

python3 -B examples/bench-adapters/embodied/configure_manipulation.py vima-bench \
  --source "$VIMA_BENCH_SOURCE" --benchmark-image orbit/vima-bench:reference \
  --output-dir "$VIMA_CONFIG"

config="$VIMA_CONFIG/vima-bench-placement-generalization-native"
orbit bench add-file "$config/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$VIMA_BENCH_SOURCE" \
  --reference-file "$config/reference.json" --all-tasks --initial-state 0 > "$config/samples.json"
```

## Run the released VIMA 20M Policy

Use [VIMA](https://github.com/vimalabs/VIMA/tree/8449837aa453f8ec9ba229cb956e3bbef5c796ea)
as `$VIMA_POLICY_SOURCE`. Prepare the official [20M.ckpt](https://huggingface.co/VIMA/VIMA/resolve/main/20M.ckpt),
the [T5 tokenizer](https://huggingface.co/google-t5/t5-base/resolve/main/tokenizer.json) as `tokenizer.json`,
and the [T5 configuration](https://huggingface.co/google-t5/t5-base/resolve/main/config.json)
as `t5-config.json` under `$VIMA_WEIGHTS`. The checkpoint includes the trained
prompt encoder and word embeddings. The Policy uses the reference preprocessing
and loads all checkpoint tensors strictly, then runs on CPU independently of the simulator.
Registration compares the Policy image's build manifest with the SDK sources selected for packaging.
Rebuild the Policy image with the command below after updating those files or when upgrading
from an image built without the SDK manifest.

```bash
python3 -B examples/bench-adapters/embodied/configure_manipulation.py vima-bench \
  --source "$VIMA_BENCH_SOURCE" --policy-source "$VIMA_POLICY_SOURCE" --build-tag orbit/vima-20m:reference

python3 -B examples/bench-adapters/embodied/configure_manipulation.py vima-bench \
  --source "$VIMA_BENCH_SOURCE" --policy-source "$VIMA_POLICY_SOURCE" \
  --benchmark-image orbit/vima-bench:reference --policy-image orbit/vima-20m:reference \
  --weights "$VIMA_WEIGHTS" --output-dir "$VIMA_CONFIG"

orbit data add vima-20m "$VIMA_WEIGHTS"
orbit policy add "$VIMA_CONFIG/vima-20m-policy.json"
orbit bench run vima-bench-placement-generalization-native --method vima=policy,policyRef=vima-20m --sample-plan "$config/samples.json"
```
