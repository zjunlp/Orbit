# Native MolmoSpaces MS manipulation

branch: feat/embodied-eval · status: implemented, short native reference validated · updated: 2026-11-11

## Scope

Register the four documented MS manipulation tracks from MolmoSpaces v0.2.9. Pick-v1.1, PnP-v1 and Open-v1 contain 1,000 episodes each. Close-v1 contains 915. Navigation and MB (Mobile Manipulation Benchmark) have separate upstream protocols.

## Changes

The asset preparer uses the pinned upstream resource manager and installs the scenes referenced by the four published catalogs. It selects the Objaverse archives for the 250 distinct Objaverse receptacles used by Pick and Place and includes Objathor metadata. The registration pins the source, resource versions, episode files and sample order. The simulator driver restores each native JSON episode, exposes the DROID joint and camera observation profile, and takes the native final success predicate as the episode score. [Registration guide](../../examples/bench-adapters/embodied/MOLMOSPACES.md)

## Validation

| Check | Result | Scope |
| --- | --- | --- |
| Official JSON catalogs | Passed | All four files match the recorded SHA-256 digests and contain 3,915 episodes in total. |
| Published archive coverage | Passed | The official archive indexes resolve every selected house index and every added Objaverse receptacle. |
| Native image and catalog parser | Passed | The pinned MuJoCo 3.5.0 image loaded all 3,915 official entries offline. The native evaluator derived the same 455/682 step limits as the Orbit profiles. |
| Native taxonomy data | Passed | The final image verified both pinned WordNet archive digests and resolved an English synset from each corpus with networking disabled. |
| Registration and frozen plans | Passed | A catalog-only fixture expanded all four plans using the real JSON files and produced 3,915 unique sample IDs. The fixture used a synthetic image ID and did not launch MuJoCo. |
| Driver and evidence checks | Passed | SDK unit tests on Python 3.8 and 3.11 cover native action forwarding, binary gripper validation, the stopping rule and restoration of the native grasp lookup on reset failure. |
| Native simulation and upstream parity | Passed, sampled | Official Pick-v1.1 and Close-v1 episode 0 ran offline in native MuJoCo with OSMesa. Both camera images and reset state matched the upstream Pi preprocessing. Four fixed controls per episode matched the native joint states, reward, termination and success. The Close comparison used the explicit upstream DROID joint-grasp library for the scene-local drawer. |
| Native Open-v1 and PnP-v1 reference | Passed, sampled | With the released Objathor metadata and the recorded PnP receptacle, episode 0 of both tracks matched the native reset, both camera inputs and four controls, including joint states, reward, termination and success. |
| Complete resource staging and registration | Passed | The prepared bundle generated four registrations and all 3,915 sample IDs. Checked the scene XML and every added object referenced by each episode, covering 937 scene XMLs and 280 object files. The PnP reference check also passed with the complete bundle mounted read-only. |
| Full simulation sweep | Pending | Native rollout coverage consists of one reference sample per track. |
| Model rollout | Pending | Requires a compatible DROID joint-position Policy and its checkpoint. The published Pi baseline uses `pi05_droid_jointpos`. |
