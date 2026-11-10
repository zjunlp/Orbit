# FrontierSWE v2 and WANDR

Thin suite-specific adapters reuse Orbit's Harbor parser, execution, separate/shared verifier and
review paths. They add pinned identities, complete task enumeration and native scoring semantics.
Use this checkout's Node 24 dependencies (`pnpm install`) and executable `adapter.ts`.

| Suite | Source | Pinned revision |
| --- | --- | --- |
| FrontierSWE v2 | [Proximal-Labs/frontier-swe-v2](https://github.com/Proximal-Labs/frontier-swe-v2) | `da83f84f8fbcec3cbf0f2b17c98ebc811355c2df` |
| WANDR | [perplexityai/wandr](https://github.com/perplexityai/wandr) | `9ea23c7f24d0aaabc2c87b26815a513001b2e7ce` |

Register the repository root. The adapter checks its commit and tracked changes. Missing task files
in sparse checkouts remain listed as unsupported, not silently omitted. Task-owned CPU, memory,
GPU, image and timeout declarations are retained; no blanket CPU/GPU override is supplied.

```bash
orbit bench add frontierswe-v2 /absolute/frontier-swe-v2 \
  --adapter /absolute/Orbit/examples/bench-adapters/harbor-suites/adapter.ts \
  -c suite=frontierswe -c allowlistNetwork=public
orbit bench add wandr /absolute/wandr \
  --adapter /absolute/Orbit/examples/bench-adapters/harbor-suites/adapter.ts \
  -c suite=wandr --pass-env OPENAI_API_KEY --pass-env PERPLEXITY_API_KEY
```

## FrontierSWE v2

The 34-task release uses original solver/verifier images. `[agent] user` is preserved through
`commandUser`: image initialization runs as root, the Agent runs as the existing named account, and
verification keeps its own image user. This requires a root-started Linux image with `runuser`,
`getent`, `find` and coreutils. Only managed writable run files are made accessible to the command
account; private host ancestors stay private. Project mounts and checkpoints are rejected for this
mode. `[verifier] user` remains unsupported.

Artifact exclusions use the original tar semantics (including `./tests` and nested paths) before
handing files to the independent verifier. The daemon host needs `tar`, as the native transfer does. Oracle
runs receive the release's `HARBOR_ORACLE_FLAG` on both phases; model runs never receive it. Native
`valid=0` is an invalid evaluation, not a zero reward. Tasks that declare a partial oracle are tagged
accordingly. Empty is supported; only tasks with original reference solutions support an oracle.

Orbit has no allowlist egress filter. The explicit `allowlistNetwork=public` option records a
network deviation; omit it to keep allowlist tasks unsupported. Results are not official-network
parity. Native task directories and images may need large downloads and GPU resources.

```bash
orbit bench run frontierswe-v2 -t crash-proof-flash-filesystem -m empty -m oracle -n 'Native calibration'
orbit bench run frontierswe-v2 -t TASK \
  -m candidate=claude-code,auth=YOUR_PROFILE,model=YOUR_MODEL -n 'Native agent sample'
```

## WANDR

All 501 public tasks retain their original instructions, submission files, environments and
verifiers. The primary reward is `soft_recall_full`, displayed as relaxed recall. All twelve
soft/hard precision/recall/F1 metrics across full/retrieval lineages remain available. A missing,
nonfinite, inconsistent reward or native `error.json` is invalid. There is no published oracle.

Nonempty grading calls the original judge and page-fetch services. Configure their keys in the
daemon environment with the names above. For native fetch settings, also register their names with
`--pass-env` (for example `WANDR_FETCH_BASE_URL` and `WANDR_FETCH_MODEL`). Explicit pass-through
values override the task template defaults only in the verifier phase.
An Agent API credential is separate from these judge/fetch credentials. Do not silently substitute
a different judge or label an ungraded model answer successful. Missing submissions are scored
through the native verifier and can be calibrated without judge calls.

```bash
orbit bench run wandr -t knowledge-product-metric-disclosure-evidence -m empty -n 'Native empty check'
orbit bench run wandr -t TASK \
  -m candidate=claude-code,auth=YOUR_PROFILE,model=YOUR_MODEL -n 'Native research sample'
```

Shared verifier runs preserve their after-phase evidence; rescore follows the existing Harbor path.
Fixture tests cover all native metric keys and invalid-score handling. The native WANDR environment
build exceeded its deadline downloading upstream dependencies, so local native calibration and
full-suite model parity remain unverified. Current bounded development validation is recorded in the task record.
