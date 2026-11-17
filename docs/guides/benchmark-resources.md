# Prepare benchmark resources

Open **Benchmarks → Prepare resources**, select a benchmark, review its official sources and
preparation steps, then choose **Download, prepare and register**. All 52 supported benchmark
families appear here, including ones that require authorization or a specialized native environment.
Orbit downloads from upstream; it does not host or redistribute benchmark datasets.

The same workflow is available from the CLI:

```bash
orbit bench resources                       # list every supported family
orbit bench resources humaneval             # sources, inputs and preparation steps
orbit bench prepare humaneval               # returns a preparation Run ID
orbit logs <run> -f
orbit wait <run>
orbit bench preparation <run>                # registration status and required actions
orbit bench tasks humaneval
```

`--json` works on the three preparation commands. Preparation is an ordinary Orbit process Run:
it uses the local node's scheduler, logs, timeout, cancellation and restart recovery. Its child
Docker containers use the existing Orbit shim and cleanup. Use `orbit cancel <run>` to cancel.
A successful process exit may still require user input or fail registration; inspect
`bench preparation`, not just `orbit wait`.

## Downloads and reuse

By default, resources live in `<ORBIT_DATA>/bench-resources/<family>` (or under `ORBIT_HOME`
when no separate data directory is configured). Set `--directory /absolute/path` to use another
empty directory outside the Orbit installation/source checkout. This managed directory belongs
to one family; Orbit refuses to adopt a directory containing unrelated files. Paths always refer
to the machine running the daemon. Preparation stays on that node, even in a cluster.

```bash
orbit bench prepare humaneval --reuse source=/data/human-eval
orbit bench prepare bfcl --reuse wheel=/data/bfcl_eval-2026.3.23-py3-none-any.whl
orbit bench prepare hle --reuse questions=/data/hle/test.parquet --set python=/data/hle-env/bin/python
```

Resource IDs and environment fields vary by benchmark; use `bench resources <family>`.
`--reuse RESOURCE=PATH` checks existing resources in place without changing the supplied source.
`--set KEY=VALUE` supplies recipe inputs such as an existing simulator image or asset directory.
Git sources must match the declared revision and have no tracked edits. Files with published or
adapter-pinned SHA-256 values must match. Native configurators validate their own image, asset
and catalog identities; a directory merely existing is not evidence of native readiness.

Completed downloads are reused on subsequent attempts. File downloads retain `.partial` files
and resume when the upstream server supports byte ranges. Corrupt resources are refused rather
than overwritten; move the affected file out of the managed directory before retrying.
Incomplete generated outputs may require a fresh preparation directory, as described by the
underlying native preparation guide. Cancellation retains downloaded data and built images.

For a complete existing definition, select **Import an existing benchmark JSON definition** or use:

```bash
orbit bench prepare humaneval --registration-file /data/setup/benchmark.json
```

Imported definitions must explicitly identify the selected family in `labels.identity.id`.
The CUA-Lite WebVoyager / Online-Mind2Web integration keeps its original `cua-lite` collection
identity. Unclassified custom definitions can still use `orbit bench add-file`.
If an imported native definition references a named dataset, register its existing path with
`orbit data add NAME /absolute/path` first. Native recipes register their prepared asset mappings
automatically. Existing registrations with different settings are kept; use `--name` for a new
single-suite setup, or a separate generated definition for a multi-suite setup.

## Authorization and network access

Resources requiring upstream permission show their official access/license page and specific
instructions. Complete that process yourself. A downloadable gated resource also requires an
explicit acknowledgement; Orbit does not accept licenses or apply for access on your behalf.
Manual releases, VM images and native deployments ask for the prepared local path after access.
Public resources can be downloaded while these prerequisites remain outstanding.

```bash
# Set HF_TOKEN in the daemon's environment, never in recipe settings or command arguments.
orbit bench prepare hle --authorized questions --token-env HF_TOKEN \
  --set python=/data/hle-env/bin/python
```

Only the environment variable's name is stored. For an already-running daemon, changing a token
in another shell does not change its environment. Reuse a locally downloaded authorized file if
that is more convenient. Judge/model credentials remain separate evaluation settings.

`--proxy http://127.0.0.1:17890` applies only to this preparation; Orbit does not change global
Git, Docker or shell settings, or the benchmark's evaluation network rules. Direct recipe Docker
builds use a scoped host-network build when a proxy is specified so a local HTTP proxy is reachable.
Native helpers that download inside containers still require their documented reachable proxy
configuration; container loopback is not the host. Proxy URLs cannot contain credentials.

## What preparation guarantees

The entry includes fixed official Git revisions, pinned file downloads, bundled adapter preparation
scripts, selected automatic image builds, native configurators and explicit manual prerequisites.
Examples include HumanEval data registration, BFCL release extraction, Terminal-Bench / TB-Science
source tasks, and the official Harbor conversion of TextArena's reference-supported games.
Specialized simulators, licensed assets, KVM/RTX setup, native Python environments and judge
configuration can still need the steps linked in each recipe. Recipes do not silently substitute
sample data or model weights. Policy weights and Policy registration remain in their model guides.

The daemon validates every produced definition through its original adapter before registration,
then checks name/path conflicts again before committing. It registers only after the preparation
Run's cleanup is confirmed. A completed registration means task discovery succeeded; inspect task
coverage and run the relevant calibration separately. It does not mean all tasks or models work,
or that a full benchmark run has been validated. See [benchmark availability](benchmark-availability.md).

The npm package carries the adapters, Python SDK and preparation helpers needed by these recipes;
a source checkout of Orbit is not required. Host `git`, `curl`, Python 3 and recipe-specific tools
(such as Docker) are still prerequisites. A missing tool or failed native validation is shown in
the preparation log and status.
