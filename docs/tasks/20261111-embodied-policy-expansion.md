# Native embodied policy expansion

branch: feat/embodied-eval · status: completed · updated: 2026-11-12

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
- Build the DROID, LingBot and StarVLA policy images from pinned source revisions. The registration
  tools check the build manifest and entrypoint. StarVLA preserves one termination component when
  converting a recipe that already declares it.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Repository and shared SDK | `5108243` | passed | `pnpm verify`, 60 Python 3.8 shared SDK tests and 151 Python 3.11 SDK tests, with two skips. Includes synthetic Policy I/O and Binding checks. |
| Native registration scope | Development tree | passed | MolmoSpaces registrations, both RoboTwin 50-task catalogs and the four StarVLA grids with 96 initial scenes resolve. |
| OpenVLA-OFT × LIBERO-PRO | Development tree | passed | One native rollout each for Spatial Language and Spatial Task using the existing OFT checkpoint. CPU rescore reproduced the initial verifier decisions. |
| OpenPI DROID × MolmoSpaces | Development image before manifest validation | passed | Pick and Pick-and-Place each completed one native rollout with EGL, independent CPU verification and rescore. |
| LingBot × RoboTwin | Development image before manifest validation | passed | One Clean `adjust_bottle` episode completed with native success, independent CPU verification and rescore. |
| StarVLA × SimplerEnv WidowX | Development image before manifest validation | passed | One Carrot on Plate episode completed under the frozen 120-step protocol with independent CPU verification and rescore. |
| DROID, LingBot and StarVLA image checks | Policy recipes and SDK in `ffdae2c` | passed | Rebuilt the images and checked offline imports, including LingBot's compiler environment. Registration accepted the matching images with released weights and rejected legacy or mismatched images. |
| GPU rollouts with rebuilt policy images | Policy recipes and SDK in `ffdae2c` | not_run | Validation of the rebuilt images covered packaging, imports and registration. |

## Next / open issues

- Compare initial observations and action chunks against the pinned upstream evaluators. This round verified sampled native runs and CPU rescoring.
