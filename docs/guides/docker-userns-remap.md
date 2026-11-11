# Docker `userns-remap` hosts

Known gap: Orbit does not yet detect or handle Docker daemons that run with user-namespace remapping.

## Symptom

Every Run that writes `$ORBIT_OUTPUT` or `$ORBIT_METRICS` fails right after it starts, for example with
`PermissionError: [Errno 13] Permission denied: '/orbit/metrics.jsonl'`. Logs, exit codes, leases and
the Web UI look normal, so the failure is easy to mistake for a bug in user code. `orbit doctor` reports
no problem. Inside the container, bind-mounted host paths show as `nobody:nogroup`. `--root` does not help.

## Cause

Orbit bind-mounts `<dataDir>/runs/<id>/orbit` into the container as `/orbit`. The daemon creates that
directory as its own user and starts the container with `--user <daemon uid>:<daemon gid>`. Under
`userns-remap`, every container uid (including 0) maps to the remap range on the host, so the container
cannot write to directories owned by the daemon user.

Confirm the setup:

```bash
docker info | grep -i userns
docker run --rm --user 0:0 python:3.12-slim cat /proc/self/uid_map   # "0 <base> <count>"
```

Read the base uid from `/proc/self/uid_map` in a probe container. `/etc/subuid` may describe a different
remap profile than the one the daemon actually uses.

## Workaround

Give the remapped uid write access to the data directory with default ACLs, which Run directories
created later inherit. The filesystem must support ACLs.

```bash
setfacl -m u:<base>:rwx,d:u:<base>:rwx <dataDir>
setfacl -R -m u:<base>:rwx,d:u:<base>:rwx <dataDir>/runs
```

## Planned fix

1. `orbit doctor` and `orbit run --check` write a probe file through a bind mount from a one-off
   container and report the remap with the workaround above.
2. Optionally, when remapping is detected, Orbit applies the ACLs to new Run directories itself, using
   the remap base probed once per node.
