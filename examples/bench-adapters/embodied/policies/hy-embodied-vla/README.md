# Hy-Embodied-0.5-VLA on RoboTwin 2.0

The released RoboTwin policy reads three native RGB views and a fresh dual-arm end-effector
pose on every control. The upstream wrapper keeps six frames sampled five controls apart and
recomputes its action cache every seven controls. Orbit requests one action at a time so that
the wrapper sees each intervening observation. The native controller receives absolute 16D
targets in left/right xyz, quaternion wxyz and gripper order. The model and episode driver run
in separate containers. [Upstream policy](https://github.com/Tencent-Hunyuan/Hy-Embodied-0.5-VLA/tree/af57e7507ec5964b52fdf6296741e553cbcd3288)

Prepare the two RoboTwin suites as in the [native guide](../../benchmarks/robotwin/README.md).
Select `--recipe absolute-ee` when generating each suite's benchmark registration, and use its
generated reference to build a sample plan. Both suites use the upstream unseen instruction split.

Set `HY_SOURCE` to the pinned checkout above, `HY_WEIGHTS` to the checkpoint directory,
`FLASH_ATTENTION_WHEEL` to the [upstream Python 3.11 CUDA wheel](https://github.com/Dao-AILab/flash-attention/releases/tag/v2.7.4.post1),
and `ROBOTWIN_CONFIG` to one of the generated registrations.

```bash
hf download tencent/Hy-Embodied-0.5-VLA-RoboTwin \
  --revision bd7bba6f5934ad62293a2a34f74760c6a3ef2ff8 --local-dir "$HY_WEIGHTS"

recipe=examples/bench-adapters/embodied/policies/hy-embodied-vla/configure_hy_vla.py
python3 -B "$recipe" --source "$HY_SOURCE" --build-tag orbit/hy-embodied-vla-robotwin:native \
  --policy-base pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime --flash-attention-wheel "$FLASH_ATTENTION_WHEEL"
python3 -B "$recipe" --source "$HY_SOURCE" --policy-image orbit/hy-embodied-vla-robotwin:native \
  --reference-file "$ROBOTWIN_CONFIG/reference.json" --weights "$HY_WEIGHTS" --output "$ROBOTWIN_CONFIG/policy.json"

orbit data add hy-embodied-vla-robotwin "$HY_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
```

The checkpoint is also published by Tencent on [ModelScope](https://modelscope.cn/models/Tencent-Hunyuan/Hy-Embodied-0.5-VLA-RoboTwin).
The service freezes the checkpoint, processor and normalization files by content.
