# Isolated reference editor (V3)

Use this route when the editor must receive only evolve evidence. It replaces V1's host reading and
editing steps; the host still freezes the study, submits evaluations and records the gate verdict.
It currently runs Codex and edits UTF-8 `AGENTS.md`, `CLAUDE.md` and `skills/**/*.md`. Bundles with
other files, executable bits, links or special files are rejected. The host baseline helper remains
available for V2; this route does not claim to enforce the ACE or bounded-notes editing rules.

## Prepare one round

Use an existing Codex auth profile with **host networking off** and a model endpoint reachable from
the Docker bridge. Profile environment additions may only be proxy variables. Do not change the
shared profile while the Run is queued/running. Use a trusted clean image with Python 3 and a shell
(for example an approved `python:3.12-slim` image, preferably pinned by digest). The daemon mounts
its Codex binary and prepares a fresh Agent home; no host Codex configuration or skills are copied.

Create a request outside the checkout and Orbit's home/data directories. Relative paths resolve
against that request. `out` must be a new directory whose parent exists. Example:

```json
{
  "parent": "./parent-bundle",
  "parentRevision": "0123456789ab",
  "parentDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "evolveJob": "PARENT_EVOLVE_JOB",
  "evolveMethod": "baseline",
  "evolveTasks": "./split/evolve.txt",
  "policy": "./gate-policy.json",
  "out": "./round-1",
  "auth": "codex-bridge",
  "model": "YOUR_MODEL",
  "effort": "low",
  "image": "python:3.12-slim",
  "limits": {
    "changedLines": 20,
    "changedBytes": 8192,
    "editorTokens": 350000,
    "timeoutMin": 5
  }
}
```

Copy the real revision and `basis.bundleDigest` from the parent's saved evaluation record. Keep
the editor model/effort prospective and comparable across methods. `evolve.txt` must match the E1
`split.json` next to it; an arbitrary task list is rejected. The evolve job/method must contain
valid failed solve trials with that exact parent revision. An empty selection stops the round.
The parent's bundle is checked against the frozen policy and digest before submission.

From this skill directory:

```sh
node scripts/run-isolated.mjs submit /outside/request.json
orbit wait EDITOR_RUN_ID
node scripts/run-isolated.mjs collect /outside/round-1
```

The script uses `orbit` on PATH. To select an installed executable or source checkout, set `orbit`
to an argv array, for example `["node", "/checkout/packages/orbit/src/bin.ts"]`. Run it on the
daemon host, with the same `ORBIT_HOME`. A separately copied skill locates contracts beside the
installed `orbit` executable on PATH. If Orbit is only available through npm exec, launch both
commands with `npm exec --package=@zjunlp/orbit -- node /path/to/scripts/run-isolated.mjs ...`;
this also makes that CLI/runtime available to the helper.
No shell command interpolation is used. The runtime uses the package's existing contracts and API.

Submission makes a fresh API export with `valid-only`, `outcome=fail`, `reasoning=none` and explicit
sensitive-text redaction. Inspect reported omissions in the export manifest when reviewing the
round. It checks task membership, benchmark, parent revision, solve phase, cleanup and file hashes.
Every exported source trial is conservatively included in `informedBy`; no editor self-report can
remove a trial from that list. Inputs are limited to 8 MiB / 512 entries per tree.

## What the container sees

- `/evolve-input`, read-only: copied parent bundle, selected evolve export and the packaged editor
  launcher. The launcher's small settings contain only model, effort and change limits.
- `/orbit`, writable: this Run's output, metrics and fresh Agent home. The daemon manages credentials
  here and cleans them up through the normal auth lifecycle.
- The trusted base image and read-only Codex installation. No project snapshot, host home, Docker
  socket, benchmark checkout, task partitions, gate policy, Orbit database or other Run directory.

The container has Docker bridge networking for model access. Host networking is rejected; the
host's loopback-only Orbit API and its token are not exposed. This is filesystem isolation under a
trusted outer controller, image, CLI and model/proxy setup, **not an egress allowlist** or a defense
against a compromised host/kernel. Do not make held-out data available through reachable services
or bake it into the image, parent instructions or model endpoint. Static scans cannot prove the
absence of encoded answers. The helper does not modify network or auth settings automatically.

## Collect and continue the existing gate workflow

`collect` requires a successful local Docker Run, unchanged settings/inputs, confirmed cleanup and
known editor input/output tokens. It downloads the candidate through the authenticated output API,
validates every path and text file before materializing it, applies conservative changed-span line
counts and whole changed-file bytes (deleted files charge their old bytes), then runs E4 preflight.
An empty, over-budget or invalid candidate does not yield `result.json`.

`result.json` identifies the Run, copied candidate directory, digest, exact parent and conservative
`informedBy` list. Review the diff, then resume V1 at **Check, smoke and plan**, using all those trial
IDs. The script neither creates a configuration revision nor submits smoke/gate/guard jobs or
promotes a candidate. Evaluation stays outside the editor container.

Count editor Run `input + output` separately from evaluation costs; cached input is already included.
Reserve `editorTokens` before submitting. The limit is checked after execution; the existing Run
timeout limits duration, not an exact token count. Record all usage and any overshoot, including
failed/cancelled attempts. Missing usage or an exceeded limit blocks collection and further rounds.

There is one submission per new round directory and no automatic retry. Keep inputs until cleanup
is confirmed, including after cancellation (`orbit cancel RUN_ID`). If submission is interrupted
before `run.json` is saved, inspect `orbit ps -a -g evolution-editor` and match the input mount before
doing anything else; do not submit a duplicate. A successful submission can be collected later.
Failed collection leaves evidence/outputs available for review; correct the cause in a new,
prospectively budgeted round. Do not hand-edit `round.json`, `run.json` or mounted inputs.
