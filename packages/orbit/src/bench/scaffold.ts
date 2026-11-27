import { lstat, mkdir, mkdtemp, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { OrbitPaths } from "../config/paths.ts";
import { BenchInitRequest, type BenchInitResult } from "../contracts/bench-init.ts";
import { UserError } from "../runs/errors.ts";

const runtime = `import os
from pathlib import Path
import sys
out = Path(os.environ["ORBIT_OUTPUT"])
out.mkdir(parents=True, exist_ok=True)
if sys.argv[1] == "oracle":
    # The instruction supplies the operands; this is a reference solver, not a grader.
    (out / "answer.txt").write_text(str(sum([17, 25])))
elif sys.argv[1] != "empty":
    raise ValueError("tutorial supports only empty and oracle controls")
`;
const grader = `import json
import os
from pathlib import Path
import sys

def grade(source):
    answer = source / "answer.txt"
    if not answer.is_file() or answer.is_symlink():
        return 0
    with answer.open("rb") as stream:
        content = stream.read(1025)
        return int(len(content) <= 1024 and content.strip() == b"42")

if __name__ == "__main__":
    out = Path(os.environ["ORBIT_OUTPUT"])
    out.mkdir(parents=True, exist_ok=True)
    try:
        result = {"score": grade(Path(sys.argv[1])), "invalid": False}
    except Exception as exc:
        result = {"score": None, "invalid": True, "error": str(exc)}
    (out / "result.json").write_text(json.dumps(result))
`;
const adapter = `#!/usr/bin/env python3
"""Synthetic tutorial only; not evidence of real benchmark validation."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent

def run(script, args, mounts):
    return {"image": "python:3.12-slim", "command": ["python3", script] + args,
            "resources": {"cpus": 1, "memGB": 1, "gpus": 0},
            "network": False, "timeoutMin": 2,
            "env": {"PYTHONDONTWRITEBYTECODE": "1"}, "mounts": mounts}

def mount(source, target):
    return {"source": str(source), "target": target, "mode": "ro"}

def main(req):
    op = req["op"]
    if req.get("protocol") != 1 or op != sys.argv[1]:
        raise ValueError("expected protocol 1 and matching operation")
    if op == "tasks":
        return {"tasks": [{"id": "addition", "title": "Synthetic tutorial: add 17 and 25", "supported": True, "reason": "",
                           "tags": {"suite": "synthetic-tutorial"}}],
                "capabilities": {"methods": ["empty", "oracle", "cli"], "scoreKind": "binary", "rescore": "score",
                                 "conditions": {"scope": "synthetic tutorial; not real benchmark validation"}}}
    if op == "solve":
        method = req["trial"]["method"]["agent"]
        if method in ["empty", "oracle"]:
            return {"spec": run("/tutorial/runtime.py", [method], [mount(ROOT / "runtime.py", "/tutorial/runtime.py")])}
        spec = run("", [], [])
        del spec["command"]
        spec["network"] = True
        spec["agentTask"] = {"instruction": "Synthetic tutorial: add 17 and 25. Write only the integer to $ORBIT_OUTPUT/answer.txt."}
        return {"spec": spec}
    if op == "verify":
        return {"spec": run("/private/grader.py", ["/submission"],
                            [mount(ROOT / "grader.py", "/private/grader.py"), mount(req["solve"]["output"], "/submission")])}
    if op == "score":
        try:
            result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
            if result["invalid"]:
                raise ValueError(result.get("error", "grader failed"))
            score = result["score"]
            if type(score) is not int or score not in [0, 1]:
                raise ValueError("invalid grader result")
            return {"score": score, "maxScore": 1, "invalid": False, "issues": [], "review": {"files": [{"label": "Tutorial grader result", "phase": "verify", "path": "result.json", "kind": "json"}]}}
        except Exception as exc:
            return {"score": None, "maxScore": 1, "invalid": True, "failure": "scorer_error", "issues": [str(exc)]}
    raise ValueError("unknown operation")

if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
`;
const manifestRuntime = `import json
import os
from pathlib import Path
import subprocess
import sys
out = Path(os.environ["ORBIT_OUTPUT"])
out.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, "/tutorial/runtime.py", sys.argv[1]], check=True)
subprocess.run([sys.executable, "/tutorial/grader.py", str(out)], check=True)
`;
const manifest = `version: 1
image: python:3.12-slim
scoreKind: binary
conditions:
  scope: "Synthetic tutorial only; runner-owned results; not real benchmark validation"
tasks:
  list:
    - id: addition
      title: "Synthetic tutorial: add 17 and 25"
      tags: {suite: synthetic-tutorial}
solve:
  network: false
  resources: {cpus: 1, memGB: 1, gpus: 0}
  timeoutMin: 2
  env: {PYTHONDONTWRITEBYTECODE: "1"}
  mounts:
    - {source: runtime.py, target: /tutorial/runtime.py}
    - {source: grader.py, target: /tutorial/grader.py}
    - {source: manifest-runtime.py, target: /tutorial/manifest-runtime.py}
methods:
  empty:
    command: [python3, /tutorial/manifest-runtime.py, empty]
  oracle:
    command: [python3, /tutorial/manifest-runtime.py, oracle]
result:
  file: result.json
  score: {path: score, singleBinary: true}
  invalid:
    - {path: invalid, failure: scorer_error, issue: "Tutorial grader failed"}
`;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export async function scaffoldBenchmark(
  paths: Pick<OrbitPaths, "home" | "data">,
  input: BenchInitRequest,
): Promise<BenchInitResult> {
  const request = BenchInitRequest.parse(input);
  if (!isAbsolute(request.directory))
    throw new UserError("directory must be absolute on the daemon host");
  const requested = resolve(request.directory);
  // Reject symlink ancestors rather than silently writing through them.
  let ancestor = dirname(requested);
  while (true) {
    if ((await lstat(ancestor)).isSymbolicLink())
      throw new UserError("directory must not have symlink ancestors");
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  const directory = join(await realpath(dirname(requested)), basename(requested));
  for (const root of [paths.home, paths.data]) {
    const actual = await realpath(root).catch(() => resolve(root));
    if (directory === actual || directory.startsWith(actual + sep))
      throw new UserError("create tutorials outside Orbit home and data directories");
  }
  const definition = {
    config: {},
    env: {},
    passEnv: [],
    name: request.name,
    path: directory,
    adapter: request.template === "adapter" ? join(directory, "adapter.py") : "manifest",
    resources: join(directory, "resources.json"),
  };
  const nextSteps = [
    `orbit bench add-file ${quote(join(directory, "benchmark.json"))}`,
    `orbit bench coverage ${quote(request.name)}`,
    `orbit bench calibrate ${quote(request.name)} --sample 1`,
  ];
  const files: Record<string, string> = {
    "runtime.py": runtime,
    "grader.py": grader,
    "resources.json": `${JSON.stringify(
      { version: 1, default: { cpus: 1, memGB: 1, gpus: 0, timeoutMin: 2 }, tasks: {} },
      null,
      2,
    )}\n`,
    "benchmark.json": `${JSON.stringify(definition, null, 2)}\n`,
    "README.md": `# Synthetic tutorial benchmark\n\nThis generated CPU fixture teaches Orbit integration. It is not a real benchmark, an upstream scoring comparison, or evidence of real benchmark validation. No registration, downloads, or runs have been performed.\n\nThe task is to add 17 and 25 and write answer.txt. Empty/missing answers score a valid zero; oracle scores one. Grader errors are invalid. Python uses only its standard library. Runs use the mutable python:3.12-slim image; obtain it before an offline run and pin a digest for reproducible work.\n\n${request.template === "adapter" ? "The adapter plans independent solve and verify containers. Only verify receives grader.py; Agent solve receives the instruction, not private grading files." : "The manifest supports only empty/oracle tutorial controls. The trusted native runner owns grading and writes results; manifest verify independently checks copied result evidence, but does not rerun the grader. Do not let a model write its own score. Replace this with a trusted isolated native runner before evaluating models."}\n\nNext steps (require a running local daemon and Docker):\n\n\`\`\`sh\n${nextSteps.join("\n")}\n\`\`\`\n\nReplace this fixture with your actual task enumeration, upstream runtime and original grader; calibrate those independently.\n`,
    ...(request.template === "adapter"
      ? { "adapter.py": adapter }
      : { "orbit-bench.yaml": manifest, "manifest-runtime.py": manifestRuntime }),
  };
  const stage = await mkdtemp(join(dirname(directory), ".orbit-bench-init-"));
  let created = false;
  let published = false;
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(stage, name), content, {
        flag: "wx",
        mode: name === "adapter.py" ? 0o700 : 0o600,
      });
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await rename(stage, directory);
    published = true;
    return {
      ...request,
      directory,
      definition,
      files: Object.keys(files),
      nextSteps,
      tutorial: true,
    };
  } catch (error) {
    if (created && !published) await rmdir(directory).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new UserError("directory already exists; choose a new directory");
    throw error;
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}
