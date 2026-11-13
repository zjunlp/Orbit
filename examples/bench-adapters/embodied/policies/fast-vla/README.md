# Fast-VLA on native RoboTwin 2.0

Use a clean [Fast-VLA checkout](https://github.com/Garfield-kh/FastVLA/tree/ad69ea0f32595801a015dfbd70fb77876d694752)
and the pinned [OpenDM checkout](https://github.com/dexmal/opendm/tree/e41e501bb82e9c3cb8138c0fb4687faa5f98c690).
Prepare `FAST_VLA_WEIGHTS` outside the checkout using these pinned inference files.

- `actor/` contains the four files under
  [fastvla-robotwin](https://huggingface.co/kehong/FastVLA-weights/tree/bd09489a801cd5c8043fcb266ba54900534223cb/fastvla-robotwin).
- `dm05/` contains the checkpoint and processor from
  [DM05-robotwin2](https://huggingface.co/Dexmal/DM05-robotwin2/tree/bef09062f8d9744b7691d0a5db4e23834e46071e).
- `hub/models--facebook--dinov2-base/` contains `refs/main` with the revision
  `f9e44c814b77203eaa57a6bdbbd535f21ede1415` and `snapshots/<revision>/config.json` from
  [DINOv2](https://huggingface.co/facebook/dinov2-base/blob/f9e44c814b77203eaa57a6bdbbd535f21ede1415/config.json).
  The actor checkpoint supplies the DINOv2 weights.

Use regular files in the weight tree. The policy loads them offline. Prepare the corresponding
[Clean or Randomized RoboTwin simulator and assets](../../benchmarks/robotwin/README.md).

```bash
policy=examples/bench-adapters/embodied/policies/fast-vla/configure_fast_vla.py
robotwin=examples/bench-adapters/embodied/benchmarks/robotwin/configure_robotwin.py
python3 -B "$policy" --source "$FAST_VLA_SOURCE" --opendm-source "$FAST_VLA_OPENDM_SOURCE" \
  --policy-base pytorch/pytorch:2.11.0-cuda12.8-cudnn9-devel \
  --build-tag orbit/fast-vla-robotwin:reference
python3 -B "$robotwin" benchmark --robotwin-source "$ROBOTWIN_SOURCE" \
  --suite demo_clean --recipe fast-vla --assets "$ROBOTWIN_ASSETS" \
  --benchmark-image "$ROBOTWIN_IMAGE" --output-dir "$LOCAL_CONFIG"
python3 -B "$policy" --source "$FAST_VLA_SOURCE" --opendm-source "$FAST_VLA_OPENDM_SOURCE" \
  --weights "$FAST_VLA_WEIGHTS" --policy-image orbit/fast-vla-robotwin:reference \
  --reference-file "$LOCAL_CONFIG/reference.json" --output "$LOCAL_CONFIG/fast-vla-policy.json"
orbit data add robotwin-demo-clean-full-assets "$ROBOTWIN_ASSETS"
orbit data add fast-vla-robotwin "$FAST_VLA_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/fast-vla-policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"
orbit bench run robotwin-demo-clean-full-fast-vla-native \
  --method model=policy,policyRef=fast-vla-robotwin \
  --sample-plan "$LOCAL_CONFIG/samples.json" --batch-size 2
```

Generate the sample plan from this recipe using the
[expert-accepted seed planner](../../benchmarks/robotwin/README.md). For Randomized, select
`--suite demo_randomized` and its matching assets. The resulting benchmark is
`robotwin-demo-randomized-full-fast-vla-native`.

The policy uses the current head and both wrist images, the 14-element native joint state,
and head frames 17 and 8 controls before the current observation. The initial frame fills the
history slots at reset. At a replan boundary the simulator reads a fresh current observation,
matching the upstream video-enabled evaluator's render sequence under dynamic lighting.
Each prediction returns 50 absolute joint targets. The model builds
task memory on the first call of each episode and reuses it through the episode. A fixed solve
batch shares the model process and opens a new policy connection for each episode, which clears
the model cache. The simulator and policy share the leased GPU.
