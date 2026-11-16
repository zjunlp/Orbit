# AppWorld

Pinned AppWorld `0.1.3.post1` public train/dev data and native `AppWorld` execution. The adapter keeps the original task instruction, API documentation, stateful execution and `TestTracker.success` evaluator. The subject sees a private HTTP execution service; the verifier replays the collected code in a fresh AppWorld environment and loads the original ground truth only there.

The registration must use the immutable image containing the matching AppWorld package and data manifest. Test split and live remote services are unsupported. Oracle is a native compiled-solution replay; empty is a valid zero when evaluation succeeds.

Install `appworld==0.1.3.post1`, run its original installation and data-download commands, and retain the extracted package at `/native/appworld` and data at `/datasets/appworld`. `release.json` pins every original wheel Python source. Build an image with that package's installed apps and runtime dependencies; supply its immutable image id.

Create a JSON manifest mapping every data-relative regular file path to its SHA-256, then hash the manifest itself. Registration verifies these files on each operation:

```bash
orbit bench add appworld /native --adapter /path/to/adapter.py \
  --resources /path/to/resources.json -c data=/datasets/appworld \
  -c dataManifest=/datasets/appworld-manifest.json -c dataSha256=MANIFEST_SHA256 \
  -c image=IMAGE_AT_SHA256 -c split=train
```

Subjects call `python /adapter/tool.py info` and `python /adapter/tool.py execute FILE` (or `execute -` for stdin). API state is retained between calls. External commands receive `ORBIT_TOOL_URL` and `ORBIT_METHOD_CONFIG`. Only the private service's collected trace is trusted, not subject-supplied state or scores. Original AppWorld syntax checks, execution timeouts and the default 1000-interaction budget remain active. This measures task success; AppWorld's grouped scenario success is not claimed.

Reference/empty checks run offline and replay in fresh verifiers; they do not validate the live HTTP service. Live service validation and real Agent quality remain pending. Default solve resources are one CPU, 4 GB RAM and 60 minutes; the private service independently requests one CPU and 4 GB RAM. No GPU is needed.
