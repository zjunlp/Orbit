# LawBench

Native task-specific evaluation for [open-compass/LawBench](https://github.com/open-compass/LawBench)
revision `e30981bb3ff54c41571f222e0b23e92d27375388`, **zero-shot** data. `release.json` contains Git blob
hashes of the original data and grading sources, checked before use. No upstream code is vendored.

One Orbit task contains the full original question list for one of the 20 task types. The mapping
from task ID to grader is parsed directly from `evaluation/main.py`. Task `2-1` (grammar correction)
is explicitly unsupported: ChERRANT requires LTP model assets and a writable native toolchain.
Missing original assets remain listed with reasons. This adapter does not implement one-shot evaluation.

```bash
orbit bench add lawbench /data/LawBench --adapter /path/to/lawbench/adapter.py \
  --resources /path/to/lawbench/resources.json
orbit bench calibrate lawbench -t 1-2 -t 2-3 -t 2-9 -t 3-7
```

Prepare the specified upstream revision outside Orbit. Required files are `data/zero_shot/*.json`,
`evaluation/main.py`, `evaluation/evaluation_functions/*.py` and the three `evaluation/utils/*.py`
files listed in `release.json`. Model predictions, images and other upstream result directories
are unnecessary. The runtime Dockerfile pins Python and lightweight CPU grading dependencies.

The subject sees original instructions and questions only, with stable IDs. Return
`$ORBIT_OUTPUT/answers.json` as `{"0":"answer", "1":"answer"}`. The shared SDK supplies CLI batch
instructions, not a new Agent loop. External methods run their own entrypoint with
`ORBIT_TASK_FILE` and `ORBIT_METHOD_CONFIG`; use method `passEnv` for credentials.

Verify reconstructs the original `origin_prompt`/`prediction`/`refr` rows and calls the unmodified
native function. It rejects changed inputs since solve. Missing or malformed answers become empty
predictions. Native scorer/import errors are invalid, distinct from valid zero credit. Original
abstention handling, data imperfections, ROUGE smoothing and potentially negative normalized
distance scores are preserved. Replaying references is calibration; it does not guarantee full
marks for every upstream task. Calibration allows only the native ROUGE numerical epsilon below 1;
larger gaps fail calibration and must be investigated. `1-1` reference replay removes
the same native answer prefix (`\u7b54\u6848:`) the grader removes from its reference.

Resources default to 1 CPU, 2 GiB, no GPU; solve 30 minutes, verify 5 minutes. Rescore invokes the
original functions again on saved predictions. CLI batch conditions differ from an official model
harness. Unit tests use explicitly synthetic fixtures; real sampled calibration is reported separately.
