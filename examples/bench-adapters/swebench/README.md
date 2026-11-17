# SWE-bench

Pinned official SWE-bench `3.0.15` and a hash-bound SWE-bench Lite dataset. Each supported task uses an immutable official instance image. The adapter exposes the original issue and repository, keeps the test patch and published F2P/P2P lists private, applies only the submitted patch in a fresh verifier container, and calls the upstream test script, parser and resolved decision. Oracle is the published patch replay; empty is a valid zero.

The image map is intentionally explicit: tasks without a prepared official image remain listed but unsupported rather than silently changing the environment.

Registration config:

```bash
orbit bench add swebench /path/to/SWE-bench-3.0.15 \
  --adapter /path/to/adapter.py --resources /path/to/resources.json \
  -c data=/datasets/swebench-lite.json -c dataSha256=DATA_SHA256 \
  -c imageMap=/datasets/instance-images.json -c harnessDeps=/datasets/harness-deps
```

Download the original Lite test split, keep every row and field, and encode the rows as a JSON array. `imageMap` maps instance ids to immutable official instance image ids. `harnessDeps` is a Python 3.11 installation of `swebench==3.0.15` with its dependencies (for example `pip install --target ... swebench==3.0.15`). The pinned source overrides its native package. The harness dependencies are removed from the test subprocess's Python path to preserve the original repository environment. No Docker socket or upstream Docker orchestration is used.

Verification permits network access because the upstream script may reinstall the patched repository and resolve build requirements. Setup failures are invalid; test assertion failures and inapplicable patches score zero. Runtime dependencies and original instance images remain external prerequisites, not Git content. The resource default is two CPUs, 8 GB RAM and 60 minutes without a GPU. A bounded real CLI Agent check passed native patch evaluation and cleanup; full-suite equivalence remains unverified.
