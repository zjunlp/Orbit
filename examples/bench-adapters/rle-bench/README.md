# RLE-Bench: coding-agent harness evaluation

This integration uses the [official RLE-Bench](https://github.com/RLE-Bench/RLE-Bench)
revision `c6bf572283b5453c0ee76eaa3054f23d691e433d`. A coding Agent writes robotics
programs, policies or mechanical designs in the native task workspace; the original
verifier evaluates those artifacts. This is an Agent/harness benchmark, not a
registration of a pretrained VLA as an Orbit Policy.

`adapter.py` delegates task parsing and solve/verify planning to Orbit's existing
Harbor adapter. It adds the RLE identity, canonical task IDs, immutable image references,
and fail-closed interpretation of native `scoring_error` / `harness_crash` markers.
It creates no Agent loop, calls no model API, and never launches containers itself.

## Coverage

The pinned upstream contains 51 tasks in nine families. All remain visible after
running the official generators; unsupported settings are reported on each task.

| Native family | Tasks | Current Orbit route |
| --- | ---: | --- |
| task01: kitchen control | 15 | Unsupported: multi-step lifecycle, user/health checks, allowlist and compose bindings |
| task02: reusable skills | 15 | Unsupported: same lifecycle and simulator requirements |
| task03: embodied reasoning | 5 | Unsupported: user/health checks, allowlist and explicit GPU bindings |
| task04: humanoid policy engineering | 5 | Unsupported: explicit GPU binding in compose |
| task05: VLA training engineering | 4 | Unsupported: private dataset/encoder mounts and verifier compose |
| task06: perception/estimation | 4 | Unsupported: separate Agent user and environment health checks |
| task07: bin clearing | 1 | Native separate solve/verifier; requires prepared images |
| task08: mobile-base design | 1 | Native separate solve/verifier; first CPU validation candidate |
| task09: teleoperation co-design | 1 | Unsupported: submitted trim.py runs with verifier privileges and can alter trusted code/results |

Unsupported conditions are not deleted or weakened to make tasks appear runnable.
The complete catalog is required, preventing an unprepared checkout from silently
registering only the seven task directories committed by upstream.

## Prepare

Keep the checkout, generated assets, image map and run outputs outside Orbit's source
checkout. Python 3.11+ is needed for the native generators; the adapter itself only
uses Python's standard library and the repository's adapter SDK.

```bash
git clone https://github.com/RLE-Bench/RLE-Bench.git /data/rle-bench
git -C /data/rle-bench checkout c6bf572283b5453c0ee76eaa3054f23d691e433d
python3.12 /path/to/orbit/examples/bench-adapters/rle-bench/prepare.py \
  /data/rle-bench --catalog --task task08 --build
orbit bench add rle-bench /data/rle-bench \
  --adapter /path/to/orbit/examples/bench-adapters/rle-bench/adapter.py \
  --resources /path/to/orbit/examples/bench-adapters/rle-bench/resources.json
orbit bench tasks rle-bench
```

Preparation runs upstream generators and the official Docker builds. It records
immutable local image IDs and build-input digests in `/data/rle-bench/orbit-images.json`.
The complete prepared task trees are hashed into `/data/rle-bench/orbit-catalog.json`;
planning rejects changes to generated instructions, task settings, graders or oracle
files even when the tracked Git revision is unchanged. Rebuild changed inputs rather
than editing either digest file by hand. Images carry the task label
`orbit.task=embodied-harness-benchmarks`. Run preparation again
with `--task task07 --build` to prepare the other structurally supported environment.
Task09 is blocked even though its Harbor settings parse: its native controller sandbox
does not separate submission privileges from the trusted verifier. The adapter does not
silently rewrite that grader or accept its potentially modified rewards.
Optional registration keys are `orbit=/absolute/path/to/orbit` and
`imageMap=/absolute/path/to/orbit-images.json`. No other adapter configuration is accepted. Docker build options such as a site proxy
or network mode can be supplied through `ORBIT_RLE_BUILD_ARGS` (shell-style argument
splitting, never shell evaluation). They affect preparation only and are not injected
into benchmark runs; keep private proxy settings outside source-controlled files.
`ORBIT_RLE_APT_RETRIES=5` optionally creates a private Dockerfile copy with download
retries only (default 0 uses the exact upstream Dockerfile). Package versions and
benchmark code stay unchanged; the image map records the effective Dockerfile hash
and retry count. `ORBIT_RLE_PIP_INDEX_URL` similarly selects a public package
mirror without changing pinned versions; credential-bearing URLs are rejected.
Its URL and effective Dockerfile hash remain in the private preparation map.

## Run and score

```bash
orbit bench run rle-bench -t task08 -m empty -m oracle -n native-calibration
orbit bench run rle-bench -t task08 \
  -m 'ark=claude-code,auth=YOUR_ARK_AGENT_PLAN_PROFILE,model=YOUR_PLAN_MODEL' \
  -n native-agent
```

Use an existing Orbit Agent auth profile; the coding CLI is the only model caller.
Do not put API credentials into benchmark config or environment files.

`task08` provides public shelf scenes, stock components and three canonical robot
arms. The Agent writes `/logs/artifacts/robot.xml` and `controller.py` in a two-hour
session. The separate original verifier evaluates every checkpoint using the worst
arm, three hidden dynamic seeds, and twelve public shelf targets at both payloads.
Its CPU budget is 90 minutes. Artifacts, native `reward.json`, detailed `report.json`,
verifier logs and renders are retained by Orbit. Native controller UID isolation and
trusted asset replacement remain inside the original verifier.

The resources file has no overrides: upstream budgets remain authoritative. Supported
CPU families use 4 CPUs; task07 requests 6 GiB and 240 minutes and task08 4 GiB and
120 minutes. A timeout override is a changed experimental
condition, not the official full-budget result.

A genuine empty or incorrect submission has its native valid reward, normally zero.
Missing/malformed rewards or native error markers are invalid, including error markers
beside a nonzero reward. One narrow task08 exception preserves failure attribution:
its native staging labels oversized/nonregular submission files as `scoring_error`.
The adapter returns valid zero only when the original staging traceback and this exact
trial's saved artifact type/size both prove that rejection. Unrelated exceptions or
error text without matching artifacts remain invalid. Reference solutions can earn partial credit. Automatic oracle calibration uses the
upstream task08 regression floor of 0.64 (`tests/test_base_design_golden.py`, even
without shelf control), not an arbitrary zero floor or a full-reward claim. Other
supported tasks carry `oracle=partial` and skip automatic oracle calibration; their reference
solutions remain available through an explicit `-m oracle` run.

**Known network difference:** Orbit enables public networking for CLI Agent model
authentication. RLE's native runner adds only provider/setup hosts to its allowlist.
The wrapper records this difference on Agent trials; these runs do not establish
closed-book network parity. The verifier still runs without network access. Full-suite
parity is not claimed for the unsupported families or untested prepared environments.

Synthetic contract checks (not native simulation checks):

```bash
python3 -m unittest discover -s examples/bench-adapters/rle-bench -p 'test_*.py'
```
