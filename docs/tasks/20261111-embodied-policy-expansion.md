# Native embodied policy expansion

branch: feat/embodied-policy-expansion · status: completed · updated: 2026-11-12

## Goal

Run short OpenVLA-OFT × LIBERO-PRO and OpenPI DROID × MolmoSpaces checks. Add independent
LingBot-VLA × RoboTwin and StarVLA QwenGR00T × SimplerEnv WidowX registrations.

## Changes

- Register the OpenPI `pi05_droid_jointpos` checkpoint with the native MolmoSpaces observation
  and eight-step joint-position recipe. The model service converts its gripper output to 0/255.
- Run synchronous policy inference on a single worker so WebSocket health and keepalive
  requests remain responsive during the first model compilation.
- Bind the depth-free LingBot RoboTwin checkpoint to the existing 50-step native joint recipe
  with upstream camera ordering and RoboTwin normalization.
- Include the Policy WebSocket transport dependencies in the RoboTwin and SimplerEnv
  simulator images so the evaluation clients can connect and encode NumPy observations.
- Freeze the four-task StarVLA WidowX recipe with direct 224×224 area-resized RGB,
  `oxe_bridge` normalization, a seven-step prediction ensemble, and native SimplerEnv controls.
  The driver validates the recipe's camera size and passes writable action buffers to the
  native controller.
  The selected 20K QwenGR00T checkpoint is independent of the earlier QwenOFT artifact.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Repository and shared SDK | working tree | passed | `pnpm verify`, the Python 3.8 shared SDK selection and Python 3.11 discovery, and synthetic DROID, LingBot and StarVLA I/O checks. |
| Native registrations | working tree | passed | LIBERO-PRO Language and Task use the existing OpenVLA-OFT checkpoint. MolmoSpaces registrations, both RoboTwin 50-task catalogs, and the four StarVLA grids with 96 initial scenes resolve. |
| Model image packaging | working tree | passed | The three Docker policy images loaded their released checkpoints and served requests in native short runs. |
| OpenVLA-OFT × LIBERO-PRO | working tree | passed | One native rollout each for Spatial Language and Spatial Task. CPU rescore reproduced the initial verifier decisions. |
| OpenPI DROID × MolmoSpaces | working tree | passed | Pick and Pick-and-Place each completed one native rollout with GPU EGL rendering in a development image, independent CPU verification and rescore. The transport regression exercises keepalive during a synchronous model call. |
| LingBot inference environment | working tree | passed | The released checkpoint and the pinned Torch and FlashAttention image passed checkpoint integrity and offline import checks. |
| StarVLA inference environment | working tree | passed | The released checkpoint passed integrity checks and the Python 3.11 policy image passed offline import checks. |
| StarVLA × SimplerEnv WidowX | working tree | passed | A real carrot-on-plate episode completed the frozen 120-step protocol and passed independent CPU verification and rescore. |
| LingBot × RoboTwin | working tree | passed | One Clean `adjust_bottle` episode passed native success, independent CPU verification and rescore. The transport and Triton compiler also passed offline checks. |

## Next / open issues

- Compare initial observations and action chunks against the pinned upstream evaluators. This round verified sampled native runs and CPU rescoring.
