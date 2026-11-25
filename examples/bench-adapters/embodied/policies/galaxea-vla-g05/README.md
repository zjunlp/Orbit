# GalaxeaVLA G0.5 on RoboTwin 2.0

This recipe uses the [LeRobot G0.5 RoboTwin release](https://huggingface.co/lerobot/g05_robotwin20/tree/b3b9695ce1f6dd08b4fb96486597fd2eb5c63ab0)
under the G0.5 non-commercial license. The serving image uses LeRobot 0.7.0 at
[410c095](https://github.com/huggingface/lerobot/tree/410c095eacc0011d998a73383eb94abed2715af0).
It loads the release's System 1 flow policy and saved normalization locally. Every query uses the
three native RGB cameras, the 14D RoboTwin `joint_action.vector`, and the simulator instruction.
The vector uses joint drive targets for the 12 arm coordinates and includes the two gripper values.
The released processor resizes the 240 × 320 camera frames to 256 × 256.
The release predicts 32 targets and the policy returns the first eight after unnormalizing the
full horizon. RoboTwin executes eight absolute qpos controls between queries and stops at its
native success or task horizon. The simulator refreshes observations after each control.
Registration checks the consumed assets against the pinned release revision.

Prepare Clean and Randomized as in the [RoboTwin guide](../../benchmarks/robotwin/README.md),
using the original simulator revision and passing `--recipe qpos-chunk-8` to the suite
configurator. These registrations use the existing unseen-instruction split.
Use the recipe-specific name for the task query in the suite setup.

```bash
ROBOTWIN_NAME="robotwin-${ROBOTWIN_SUITE/_/-}-full-qpos-chunk-8-native"
orbit bench tasks "$ROBOTWIN_NAME" --json
```

Build the [LeRobot 0.7.0 base image](../lerobot/lerobot-v070.Dockerfile) and set `LEROBOT_SOURCE` to the
pinned checkout, `G05_WEIGHTS` to an external asset directory, and `ROBOTWIN_CONFIG` to the
directory containing the generated files.

```bash
hf download lerobot/g05_robotwin20 --revision b3b9695ce1f6dd08b4fb96486597fd2eb5c63ab0 \
  --local-dir "$G05_WEIGHTS"

recipe=examples/bench-adapters/embodied/policies/galaxea-vla-g05/configure_g05.py
python3 -B "$recipe" --source "$LEROBOT_SOURCE" \
  --policy-base orbit/embodied-lerobot-policy:0.7.0 --build-tag orbit/galaxea-vla-g05-robotwin:0.7.0
python3 -B "$recipe" --source "$LEROBOT_SOURCE" --policy-image orbit/galaxea-vla-g05-robotwin:0.7.0 \
  --reference-file "$ROBOTWIN_CONFIG/reference.json" --weights "$G05_WEIGHTS" \
  --output "$ROBOTWIN_CONFIG/policy.json"

orbit data add galaxea-vla-g05-robotwin "$G05_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
```

Freeze a sample plan using the generated reference. Set `ROBOTWIN_GPU` to a device index or
UUID. The simulator and policy share that GPU, and Verify uses CPU.

```bash
orbit bench run "$ROBOTWIN_NAME" \
  --sample-plan "$ROBOTWIN_CONFIG/samples.json" --option "gpuId=$ROBOTWIN_GPU" \
  --method g05=policy,policyRef=galaxea-vla-g05-robotwin
```

The adapter suite runs the G0.5 wrapper regression tests with synthetic model outputs.
Run the released processor comparison on CPU with the same image and local release assets.

```bash
docker run --rm --network none --label orbit.task=g05-processor-test --entrypoint python \
  -e ORBIT_G05_TEST_WEIGHTS=/weights -v "$G05_WEIGHTS:/weights:ro" \
  -v "$PWD/examples/bench-adapters/embodied/policies/galaxea-vla-g05:/tests:ro" \
  orbit/galaxea-vla-g05-robotwin:0.7.0 -B -m unittest discover -s /tests -p test_g05.py
```
