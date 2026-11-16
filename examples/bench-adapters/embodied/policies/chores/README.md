# SPOC and FLaRe for CHORES

SPOC has dedicated `SigLIP-ViTb-3-CHORES-S` and `SigLIP-ViTb-3-CHORES-L` checkpoints. FLaRe publishes four task-family checkpoints for object navigation, pickup, fetch and room visitation. Both policy services receive the dual RGB observations, instruction and gripper occupancy from the same native [CHORES registration](../../benchmarks/chores/README.md). The upstream policy code maintains previous actions and resets episode history at every connection.

New policy definitions declare the recommended suite or task family. Orbit shows a warning when a submitted plan is outside that scope and accepts semantically compatible cross-suite or cross-family evaluations. Regenerate older policy definitions to add the recommendation.

The [asset list](release.json) pins the six published weight files by size and SHA-256. Place each selected checkpoint in its own dataset directory. For SPOC, also download the corresponding `config.yaml` from the checkpoint's URL directory. The configurator and service both check the checkpoint against the release manifest. The SHA-256 values were computed after matching the publisher's [multipart object ETags](https://developers.cloudflare.com/r2/objects/upload-objects/#etags) with 10 MiB parts for SPOC and 8 MiB parts for FLaRe.

Check out [SPOC](https://github.com/allenai/spoc-robot-training/tree/baaa237ad162e31cafb0d920a18c31093a095065) and [FLaRe's AllenAct dependency](https://github.com/allenai/allenact/tree/d055fc9d4533f086e0340fe0a838ed42c28d932e). Set `CLIP_SOURCE` to the [pinned CLIP dependency](https://github.com/openai/CLIP/tree/a1d071733d7111c9c014f024669f959182114e33). Prepare each image's backbone directory with a regular-file portable Hugging Face cache layout under `huggingface/hub`. SPOC uses the OpenCLIP model from `timm/ViT-B-16-SigLIP-256` and the tokenizer from `timm/ViT-B-16-SigLIP`. FLaRe uses the `t5-small` model and tokenizer, a checkout of [DINOv2](https://github.com/facebookresearch/dinov2/tree/7764ea0f912e53c92e82eb78a2a1631e92725fc8) exported to `dinov2/`, and the [ViT-S/14 weights](https://dl.fbaipublicfiles.com/dinov2/dinov2_vits14/dinov2_vits14_pretrain.pth) at the backbone directory root. Keep the cache snapshot paths and refs, copy as regular files and exclude incomplete downloads. Build and registration fingerprint the resulting backbone directory.

```bash
config=examples/bench-adapters/embodied/policies/chores/configure_chores_policy.py
python3 -B "$config" --family spoc --source "$SPOC_SOURCE" --policy-base orbit/chores:reference \
  --clip-source "$CLIP_SOURCE" --backbones "$SPOC_BACKBONES" --build-tag orbit/spoc-chores:reference
python3 -B "$config" --family flare --source "$FLARE_SOURCE" --policy-base orbit/chores:reference \
  --allenact-source "$ALLENACT_SOURCE" --clip-source "$CLIP_SOURCE" --backbones "$FLARE_BACKBONES" --build-tag orbit/flare-chores:reference

python3 -B "$config" --family spoc --source "$SPOC_SOURCE" --policy-base orbit/chores:reference \
  --backbones "$SPOC_BACKBONES" --policy-image orbit/spoc-chores:reference \
  --model spoc-chores-small --weights "$SPOC_SMALL_WEIGHTS" --output-dir "$CHORES_CONFIG"
python3 -B "$config" --family flare --source "$FLARE_SOURCE" --policy-base orbit/chores:reference \
  --backbones "$FLARE_BACKBONES" --policy-image orbit/flare-chores:reference \
  --model flare-chores-objectnav --weights "$FLARE_OBJECTNAV_WEIGHTS" --output-dir "$CHORES_CONFIG"

orbit data add spoc-chores-small "$SPOC_SMALL_WEIGHTS"
orbit data add flare-chores-objectnav "$FLARE_OBJECTNAV_WEIGHTS"
orbit policy add "$CHORES_CONFIG/spoc-chores-small.json"
orbit policy add "$CHORES_CONFIG/flare-chores-objectnav.json"

python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$FLARE_SOURCE" \
  --reference-file "$CHORES_CONFIG/chores-small/reference.json" \
  --task ObjectNavType:000 --initial-state 0 > "$CHORES_CONFIG/objectnav-pair.json"
orbit bench run chores-small --sample-plan "$CHORES_CONFIG/objectnav-pair.json" \
  --option "gpuId=$VLN_GPU" -m spoc=policy,policyRef=spoc-chores-small \
  -m flare=policy,policyRef=flare-chores-objectnav
```

Repeat with `spoc-chores-large` for the large catalog. For task-family comparisons use the released FLaRe checkpoint for the chosen task and report the exact checkpoint. The two policies share the same benchmark assets and protocol. Orbit uses FLaRe's pinned simulator for both and runs inference with evaluation-time image augmentation disabled.
