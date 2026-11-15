# LightNav-0 for HSSD-OV

This policy uses the [LightNav-0 release](https://huggingface.co/LightOriginsHQ/LightNav-0), its RVQ action decoder, and greedy inference over camera history and object-goal instructions. Orbit projects the released velocity command to the nearest of the four [HSSD-OV benchmark primitives](../../benchmarks/hssd-ov/README.md) in normalized forward and yaw coordinates. STOP wins when both magnitudes are below 0.5, and forward wins magnitude ties. This is an Orbit evaluation recipe with discrete control.

Policy version 2 freezes the `lightnav-hssd-velocity/1` projection. Each episode's `chunks/<n>.raw.npy` contains one row with the normalized linear velocity, normalized angular velocity and decode status (`1` for a decoded trajectory, `0` for the upstream zero-velocity fallback). The companion `chunks/<n>.json` records the source observation and projection version, and `chunks/<n>.npy` contains the discrete action. CPU verification recomputes the projection from the sealed raw chunk. Rebuild and register the policy and refresh the HSSD-OV benchmark registration to collect these artifacts on new runs.

```bash
hf download LightOriginsHQ/LightNav-0 --revision 826dc5fbfa37afa8293d2e336d329b6ffc0bfb64 \
  --local-dir "$LIGHTNAV_WEIGHTS"

config=examples/bench-adapters/embodied/policies/lightnav-0/configure_lightnav.py
python3 -B "$config" --source "$LIGHTNAV_SOURCE" --build-tag orbit/lightnav-0-hssd-ov:reference
python3 -B "$config" --source "$LIGHTNAV_SOURCE" --policy-image orbit/lightnav-0-hssd-ov:reference \
  --weights "$LIGHTNAV_WEIGHTS" --output-dir "$HSSD_CONFIG"
orbit data add lightnav-0-hssd-ov "$LIGHTNAV_WEIGHTS"
orbit policy add "$HSSD_CONFIG/lightnav-0-hssd-ov.json"
orbit bench run hssd-ov --sample-plan "$HSSD_PLAN" --option "gpuId=$VLN_GPU" \
  -m lightnav=policy,policyRef=lightnav-0-hssd-ov
```

Use the [pinned LightNav checkout](https://github.com/lightorigins/LightNav-0/tree/3015508b70fb6e30bbd66701e94c9b916dcb8df8) for `LIGHTNAV_SOURCE`. Set `VLN_GPU` to the UUID of the designated GPU using `nvidia-smi --query-gpu=index,uuid --format=csv,noheader`.

The service gives the upstream loader a directory containing only the verified files in [the release manifest](release.json). The files are linked from the read-only weights mount.
