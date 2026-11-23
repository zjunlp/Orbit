import { describe, expect, it } from "vitest";
import { autoRunName, fitRunName, runDisplayName, shellWords } from "../src/contracts/naming.ts";
import { RunSpec } from "../src/contracts/runs.ts";

describe("run names from commands", () => {
  it("drops launchers and interpreters, keeps the program and key=value arguments", () => {
    const cases: [string[], string][] = [
      [
        ["python", "scripts/train.py", "--lr", "3e-4", "--seed", "1", "--data", "/data/x"],
        "train.py lr=3e-4 seed=1",
      ],
      [
        ["torchrun", "--nproc_per_node", "4", "-m", "mypkg.finetune", "model=llama", "lr=1e-5"],
        "mypkg.finetune model=llama lr=1e-5",
      ],
      [["bash", "-c", "cd src && python eval.py --split test"], "eval.py split=test"],
      [
        ["/x/.venv/bin/python", "-u", "-m", "ai4sci_bench.cli", "run", "--tasks", "math.a"],
        "ai4sci_bench.cli run tasks=math.a",
      ],
      [
        [
          "accelerate",
          "launch",
          "--mixed_precision",
          "fp16",
          "train.py",
          "--epochs",
          "3",
          "--debug",
        ],
        "train.py epochs=3",
      ],
      [["uv", "run", "python", "train.py", "lr=0.1"], "train.py lr=0.1"],
      [["torchrun", "--standalone", "train.py", "--bs", "32"], "train.py bs=32"],
      [["env", "CUDA_VISIBLE_DEVICES=0", "python", "a.py", "out=~/x"], "a.py"],
      [
        ["codex", "exec", "--skip-git-repo-check", "--sandbox-off", "Reply with the word OK"],
        "codex exec",
      ],
      [["Rscript", "analysis/fit.R", "--k", "5"], "fit.R k=5"],
    ];
    for (const [cmd, want] of cases) expect(autoRunName(cmd), cmd.join(" ")).toBe(want);
  });

  it("falls back to the clipped command and prefers a given name", () => {
    expect(autoRunName(["python", "-c", 'print("hello from orbit")'])).toBe(
      'python -c print("hello from orbit")',
    );
    const long = autoRunName([
      "python",
      "t.py",
      ...Array.from({ length: 20 }, (_, i) => `k${i}=v`),
    ]);
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
    expect(runDisplayName({ name: "lr sweep", command: ["python", "t.py"] })).toBe("lr sweep");
    expect(runDisplayName({ command: ["python", "t.py"] })).toBe("t.py");
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(["a", "b c", 'd "e"', "f g", ""]);
  });
});

describe("generated Run names", () => {
  const suffix = " · openpi-pi05 #2 · verify";
  const runSpec = { backend: "process" as const, command: ["true"] };

  it.each([42, 252, 308, 511, 512])("keeps a generated name of %i characters intact", (length) => {
    const label = "x".repeat(length - suffix.length);
    const name = fitRunName(label, suffix);
    expect(name).toBe(label + suffix);
    expect(RunSpec.parse({ ...runSpec, name }).name).toBe(name);
  });

  it("shortens a 513-character name and preserves the suffix", () => {
    const label = "x".repeat(513 - suffix.length);
    expect(RunSpec.safeParse({ ...runSpec, name: label + suffix }).success).toBe(false);
    const name = fitRunName(label, suffix);
    expect(name).toBe(`${label.slice(0, -2)}…${suffix}`);
    expect(name).toHaveLength(512);
    expect(RunSpec.parse({ ...runSpec, name }).name).toBe(name);
  });

  it("keeps Unicode well formed at the cutoff", () => {
    const label = `${"x".repeat(512 - suffix.length - 2)}🧪 more`;
    const name = fitRunName(label, suffix);
    expect(name).toBe(`${label.split("🧪")[0]}…${suffix}`);
    expect(name.isWellFormed()).toBe(true);
  });
});
