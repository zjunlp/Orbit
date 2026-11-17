# Motus on RoboTwin 2.0

The upstream Motus wrapper composes the three RoboTwin RGB views and reads live 14D joint
state. It jointly predicts video and sixteen 14D absolute joint targets. Orbit executes the
native qpos controls and retains their action chunks and the simulator's camera recordings.
The service omits the wrapper's optional predicted-frame contact sheets. The original Clean
and Randomized protocols use unseen instructions. [Upstream policy](https://github.com/thu-ml/Motus/tree/88f6fe30c62af033874b0a2e48ad1cbdaf12cfdf/inference/robotwin)

Prepare [RoboTwin](../../benchmarks/robotwin/README.md) and register each suite with
`--recipe qpos-chunk-16`. Set `MOTUS_SOURCE` to the pinned checkout above, `MOTUS_WEIGHTS`
to the directory for the three asset groups, `FLASH_ATTENTION_WHEEL` to the
[upstream Python 3.11 CUDA wheel](https://github.com/Dao-AILab/flash-attention/releases/tag/v2.7.4.post1),
and `ROBOTWIN_CONFIG` to one of the generated registrations.

```bash
hf download motus-robotics/Motus_robotwin2 mp_rank_00_model_states.pt \
  --revision ab74bc214f7fc5952c85198e062c5f8bf1dc47a7 --local-dir "$MOTUS_WEIGHTS/robotwin2"
hf download Wan-AI/Wan2.2-TI2V-5B --revision 921dbaf3f1674a56f47e83fb80a34bac8a8f203e \
  --include config.json --include Wan2.2_VAE.pth --include models_t5_umt5-xxl-enc-bf16.pth \
  --include 'google/umt5-xxl/*' --local-dir "$MOTUS_WEIGHTS/wan"
hf download Qwen/Qwen3-VL-2B-Instruct --revision 89644892e4d85e24eaac8bacfd4f463576704203 \
  --exclude '*.safetensors' --local-dir "$MOTUS_WEIGHTS/qwen"

recipe=examples/bench-adapters/embodied/policies/motus/configure_motus.py
python3 -B "$recipe" --source "$MOTUS_SOURCE" --build-tag orbit/motus-robotwin:native \
  --policy-base pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime --flash-attention-wheel "$FLASH_ATTENTION_WHEEL"
python3 -B "$recipe" --source "$MOTUS_SOURCE" --policy-image orbit/motus-robotwin:native \
  --reference-file "$ROBOTWIN_CONFIG/reference.json" --weights "$MOTUS_WEIGHTS" \
  --output "$ROBOTWIN_CONFIG/policy.json"

orbit data add motus-robotwin "$MOTUS_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
```

The released task checkpoint contains the video and VLM expert weights. The local Wan folder
provides the VAE and T5 encoder. The Qwen folder supplies architecture and processor files.
The inference image imports the upstream training rank helpers through `torch.distributed`.
It loads the T5 checkpoint on CPU and moves the BF16 encoder to the inference device after loading.
The released evaluation wrapper and model computations run from the pinned source.
