# MMAU (audio)

Adapter for [Sakshi113/MMAU](https://github.com/Sakshi113/MMAU), revision
`110127f54c0dfba3faa5ec9feee4a7e4148679c5`, public **1000-question test-mini**. This is the audio
understanding benchmark. Each Orbit task is one original question with its sound, music or speech
clip. Full private test evaluation is outside this adapter's scope.

Prepare `evaluation.py` and `mmau-test-mini.json` from that revision outside Orbit. Their original
Git blob hashes are checked before use. Put original WAVs under `<checkout>/test-mini-audios/`.
Questions without installed audio remain listed as unsupported; audio is never replaced by text.

The official [gamma-lab-umd/MMAU-test-mini](https://huggingface.co/datasets/gamma-lab-umd/MMAU-test-mini)
release at `ccd9696c0111ea7060827598f310558df0b71b0a` distributes `test_mini.parquet`. The optional
`prepare_audio.py` checks its SHA-256, matches the transformed HF annotations against the pinned
original questions and extracts the original WAV bytes. Run it through Orbit with `prepare.Dockerfile`
(1 CPU, 4 GiB, no GPU, 15-minute timeout), mounting the Parquet and original annotation JSON read-only:

```bash
orbit run --dockerfile /path/to/mmau/prepare.Dockerfile --cpus 1 --mem 4 --gpus 0 \
  --timeout 15 --no-network -m /data/mmau:/data -- \
  python examples/bench-adapters/mmau/prepare_audio.py \
  --parquet /data/test_mini.parquet --annotations /data/mmau-test-mini.json
```

Use `--ids <uuid> ...` to extract a subset. Copy the resulting `test-mini-audios/` from the run output
to the external benchmark checkout; keep `audio-manifest.json` beside it for provenance.

```bash
orbit bench add mmau /data/mmau --adapter /path/to/mmau/adapter.py \
  --resources /path/to/mmau/resources.json
orbit bench calibrate mmau -t <uuid> -t <uuid> -t <uuid> -t <uuid>
```

Only **audio-capable external methods**, `oracle` and `empty` are accepted. The external entrypoint
is a command string split with POSIX quoting into argv, without shell expansion. It receives
`ORBIT_TASK_FILE=/input/task.json` and `ORBIT_METHOD_CONFIG`. The task JSON has
`prompts[0].question`, `choices` and `audio=/media/audio.wav`; labels are absent. Write
`$ORBIT_OUTPUT/answers.json` as `{"0":"the chosen answer text"}`. The original scorer expects the
answer text, not only an option letter. Set a suitable runtime image with `-c image=<image>` and use
method `passEnv` for credentials. Local audio models may need resource overrides; the default
1 CPU / 2 GiB / no GPU assumes a remote API subject and lightweight scoring.

Independent no-network verify calls unmodified `evaluation.string_match`. Its binary results average
to accuracy in [0,1] (the original CLI prints percentages). Missing/malformed answers become empty
`model_output` and score zero, so unanswered tasks remain in the denominator; the original CLI skips
rows that omit this key. Native scorer failures are invalid. Source and audio digests are checked
against collected solve inputs before rescore. No reference labels reach the subject except for
the explicitly named oracle calibration method.

Oracle replay verifies data, audio collection, scoring and cleanup; it does **not** test audio
perception by a model. Synthetic unit tests and real sampled Docker checks are reported separately.
