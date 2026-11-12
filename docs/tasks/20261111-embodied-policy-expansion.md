# Native embodied policy expansion

branch: feat/embodied-policy-expansion · status: completed · updated: 2026-11-12

## Goal

Record short OpenVLA-OFT × LIBERO-PRO checks.
Add an independent OpenPI DROID registration and check it on native MolmoSpaces.
Add an independent LingBot-VLA × RoboTwin registration.

## Changes

- Record native Spatial Language and Spatial Task checks in the compatibility matrix.
- Register the OpenPI `pi05_droid_jointpos` checkpoint with the native MolmoSpaces observation
  and eight-step joint-position recipe. The model service converts its gripper output to 0/255.
- Run synchronous policy inference on a single worker so WebSocket health and keepalive
  requests remain responsive during the first model compilation.
- Bind the depth-free LingBot RoboTwin checkpoint to the existing 50-step native joint recipe
  with upstream camera ordering and RoboTwin normalization.
- Include NumPy message transport in the RoboTwin simulator image.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| OpenVLA-OFT × LIBERO-PRO | working tree | passed | One native rollout each for Spatial Language and Spatial Task. CPU rescore reproduced the initial verifier decisions. |
| OpenPI DROID × MolmoSpaces | working tree | passed | Pick and Pick-and-Place each completed one native rollout with GPU EGL rendering in a development image, independent CPU verification and rescore. The transport regression exercises keepalive during a synchronous model call. |
| LingBot inference environment | working tree | passed | The released checkpoint and the pinned Torch and FlashAttention image passed checkpoint integrity and offline import checks. |
| LingBot × RoboTwin | working tree | passed | One Clean `adjust_bottle` episode passed native success, independent CPU verification and rescore. The transport and Triton compiler also passed offline checks. |

## Next / open issues

- Compare initial observations and action chunks against the pinned upstream evaluators.
