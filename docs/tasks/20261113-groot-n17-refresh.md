# GR00T N1.7 inference refresh

branch: feat/embodied-eval · status: completed · updated: 2026-11-13

## Goal

Update the pinned NVIDIA inference source and checkpoint revisions across LIBERO and SimplerEnv.

## Changes

- GR00T N1.7 pins the updated NVIDIA inference source and checkpoint revisions. The
  policy image manifest binds the source, server and SDK to the registration. The
  published inference tensors used here retain their content digests.
  [Isaac-GR00T](https://github.com/NVIDIA/Isaac-GR00T/tree/3b49067943eb1ab2eb2203b93d461c4390c78da3)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| GR00T N1.7 | working tree | passed | LIBERO, WidowX and Google configurations generated. The audited image served a GPU 1 LIBERO Spatial episode and passed CPU verification and rescore. |

## Next / open issues

The updated SimplerEnv registrations were generated. Model episodes were sampled on LIBERO Spatial.
