# Official RoboMME pi0.5 baseline

The independent Policy uses the original `pi05_baseline` training configuration and the
released 79999 checkpoint. It conditions on the latest front and wrist images, Panda state
and task goal. The model predicts 20 controls and the evaluator executes the first 16.
The upstream model's history features are disabled for this baseline. Each episode restarts
the JAX stream at key 0, including when several episodes share a policy service.
[Upstream policy](https://github.com/RoboMME/robomme_policy_learning/tree/ac846a9a4aec841e483b1dc5d620dfe426bde853)

Set `ROBOMME_POLICY_SOURCE` to the pinned upstream policy checkout, `ROBOMME_WEIGHTS` to
the weight directory, and `registration` to the generated [RoboMME benchmark](../../benchmarks/robomme/README.md) directory.
Build the OpenPI dependency image at the pinned revision using the [native LIBERO guide](../../benchmarks/libero/README.md).

```bash
hf download Yinpei/pi05_baseline pi05_baseline/79999.zip \
  --revision 80caa59a4933804b6521e72981b107ae0051d32a --local-dir "$ROBOMME_WEIGHTS"
python "$ROBOMME_POLICY_SOURCE/scripts/unzip_ckpt.py" "$ROBOMME_WEIGHTS/pi05_baseline" --processes 1
mkdir -p "$ROBOMME_WEIGHTS/tokenizer"
curl -fLSs https://storage.googleapis.com/big_vision/paligemma_tokenizer.model \
  -o "$ROBOMME_WEIGHTS/tokenizer/paligemma_tokenizer.model"

recipe=examples/bench-adapters/embodied/policies/robomme-pi05/configure_robomme_pi05.py
python3 -B "$recipe" --source "$ROBOMME_POLICY_SOURCE" --build-tag orbit/robomme-pi05:native \
  --policy-base orbit/openpi-deps:reference
python3 -B "$recipe" --source "$ROBOMME_POLICY_SOURCE" --policy-image orbit/robomme-pi05:native \
  --reference-file "$registration/reference.json" --weights "$ROBOMME_WEIGHTS" --output "$registration/policy.json"
orbit data add robomme-pi05-baseline "$ROBOMME_WEIGHTS"
orbit policy add "$registration/policy.json"
orbit bench run robomme-test-joint-native --method "model=policy,policyRef=robomme-pi05-baseline" \
  --sample-plan "$registration/samples.json"
```
