# miniF2F (original Lean 3)

The adapter lists all 244 validation and 244 test theorems from the pinned miniF2F commit. The original statement, imports and locale declarations remain fixed. The subject submits only a proof expression in `$ORBIT_OUTPUT/proof.lean` and may use the mounted Lean executable and libraries locally. It does not get the benchmark source or published reference proofs. The oracle method is available only when that original theorem has a complete published proof; unavailable reference proofs are rejected explicitly.

Use Lean **3.42.1**, original mathlib commit `cb2b02fff213ed6f65bebd64446baac64137dcda` and its matching original olean cache. Lean 4 and newer mathlib are different conditions and are not accepted substitutes. Install them outside Git under `toolRoot/lean` and `toolRoot/mathlib` and record every installed file in `toolManifest` as a map of relative paths to SHA-256. Hash the manifest itself for `toolSha256`.

```bash
orbit bench add minif2f /path/to/miniF2F --adapter /path/to/adapter.py \
  --resources /path/to/resources.json -c toolRoot=/datasets/minif2f-tools \
  -c toolManifest=/datasets/tools-manifest.json -c toolSha256=MANIFEST_SHA256
orbit bench run minif2f -t valid/mathd_algebra_182 -m oracle -m empty
```

The verifier first checks the original imports independently, then elaborates the fixed theorem with Lean's native compiler and exports only its declaration and dependencies. An export audit permits only the standard `propext`, `quot.sound`, `classical.choice` axioms; `sorry`, admitted proofs and new axioms receive zero. The native `leanchecker` independently checks the exported declarations. Empty, malformed and incorrect proofs are valid zeros. Tool/import failures are invalid. A submitted proof that exceeds the bounded checking time receives zero, not a success inferred from syntax.

Default resources are two CPUs, 4 GB RAM, no GPU and 30 minutes, covering the import preflight and both bounded proof checks. The default image is pinned Python 3.11 slim; the externally installed Linux Lean binaries must run in it. `image` may select another compatible image. Full-suite parity and real Agent quality remain unverified.
