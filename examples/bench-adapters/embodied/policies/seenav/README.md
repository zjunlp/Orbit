# SeeNav-Agent and Qwen2.5-VL-3B-Instruct

The paired policies share one local Transformers runtime and the same pinned SeeNav planner on
[EB-Navigation](../../benchmarks/eb-navigation/README.md). Each call uses the projected dual view,
instruction and recent action feedback to select one native action. The service uses bfloat16
inference and greedy decoding. It resets feedback and its fixed fallback RNG for each episode.
The bundled SeeNav evaluation script uses near-zero-temperature decoding and randomly falls
back on invalid model output. Orbit uses a deterministic per-episode fallback so batch order
does not influence the paired test.

The policy image build tests the pinned planner with a synthetic model on CPU. It checks the image
sent to the model, action parsing and fallback, step feedback, and episode reset.

Download each checkpoint into a dedicated directory. The configurator checks the published shard
SHA-256 values for Git LFS files and Git blob IDs for the remaining configuration files.

```bash
hf download wangzc9865/SeeNav-Agent --revision b1024343452d2cf42bd23b4dc6e8efe01313b549 \
  --include '*.json' '*.safetensors' 'merges.txt' --local-dir "$SEENAV_WEIGHTS"
hf download Qwen/Qwen2.5-VL-3B-Instruct --revision 66285546d2b821cf421d4f5eb2576359d3770cd3 \
  --include '*.json' '*.safetensors' 'merges.txt' --local-dir "$QWEN_WEIGHTS"

config=examples/bench-adapters/embodied/policies/seenav/configure_seenav.py
python3 -B "$config" --source "$SEENAV_SOURCE" --build-tag orbit/seenav-eb-navigation:reference
python3 -B "$config" --source "$SEENAV_SOURCE" --policy-image orbit/seenav-eb-navigation:reference \
  --model seenav --weights "$SEENAV_WEIGHTS" --output-dir "$EB_NAV_CONFIG"
python3 -B "$config" --source "$SEENAV_SOURCE" --policy-image orbit/seenav-eb-navigation:reference \
  --model qwen25vl-3b --weights "$QWEN_WEIGHTS" --output-dir "$EB_NAV_CONFIG"

orbit data add seenav-eb-navigation "$SEENAV_WEIGHTS"
orbit data add qwen25vl-3b-eb-navigation "$QWEN_WEIGHTS"
orbit policy add "$EB_NAV_CONFIG/seenav-eb-navigation.json"
orbit policy add "$EB_NAV_CONFIG/qwen25vl-3b-eb-navigation.json"

orbit bench run eb-navigation-seenav --sample-plan "$EB_NAV_PLAN" --batch-size 2 \
  --option "gpuId=$EB_NAV_GPU" \
  -m seenav=policy,policyRef=seenav-eb-navigation \
  -m qwen=policy,policyRef=qwen25vl-3b-eb-navigation
```

Set `EB_NAV_GPU` to a GPU identifier or omit that option to let Orbit select the GPU. The simulator
and model share the reserved GPU. Each method has its own batch and model service.
