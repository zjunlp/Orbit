# AgentDojo clean utility

Pinned AgentDojo v1.2.2 clean user tasks. This adapter does not evaluate attacks or defenses.
Install the source archive at the commit in `release.json`; all used Python/YAML/data sources
are hash checked. The native package dependencies are built with the provided Dockerfile.

```bash
orbit bench add agentdojo /path/to/agentdojo --adapter /path/to/adapter.py \
  --resources /path/to/resources.json
orbit bench run agentdojo -t banking/user_task_0 -m empty -m oracle
```

A trial gets a private native tool service, original prompt and original tool schemas. The
service has no network interface; HTTP requests use a per-trial Unix socket shared through
`/ipc/tools.sock`. This avoids allocating a second Docker bridge for tool communication.
The subject image contains only a small HTTP client; it cannot read ground truth or utility code.
Use `python /adapter/tool.py info`, `call FUNCTION 'JSON_ARGS'` and `finish 'ANSWER'`.
External commands use the same client and receive `ORBIT_TOOL_SOCKET` and JSON `ORBIT_METHOD_CONFIG`.
The service permits at most 64 calls. Ordinary subjects cannot invoke the oracle endpoint.
Reference and empty methods execute native ground-truth traces offline, then verify by fresh
replay; they do not start or validate the live tool service.

Orbit collects `/evidence/trace.json` from the tool service, independently of subject output.
A separate offline verifier recreates the original environment, replays recorded calls and runs
the original task utility, including utility-from-traces. It does not accept self-reported scores
or model-provided final state. Missing service evidence is an infrastructure/scorer failure.
Empty output is checked by the native utility and normally receives zero.

Config: `image` overrides the native service/verifier image, `subjectImage` overrides the subject
image. Images must contain the dependencies in the Dockerfile. Version/attack overrides are
rejected; broader security evaluation needs its own explicit protocol.

Fixture tests are explicit. Bounded live subject, trusted-trace replay and cleanup checks passed;
see `docs/tasks/20261117-tool-service-sockets.md`. Full-suite equivalence remains unverified.
