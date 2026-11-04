import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { formatRun } from "../src/cli/format.ts";
import { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { CodeSnapshot } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";
import { gitSource, snapshotProject } from "../src/workspace/snapshot.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp) };
});

const homes: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
};
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });

function repo(): string {
  const d = temp("orbit-repo-");
  const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { stdio: "pipe" });
  git("init", "-q");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/a.py"), "print(1)\n");
  writeFileSync(join(d, ".gitignore"), "data/\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return d;
}

describe("snapshotProject", () => {
  it.each([false, true])(
    "records same-size edits when file and index timestamps match (linked worktree: %s)",
    async (linked) => {
      const original = repo();
      const out = temp("orbit-snap-");
      const d = linked ? join(out, "worktree") : original;
      if (linked) git(original, "worktree", "add", "--detach", d);
      git(d, "config", "core.trustctime", "false");
      git(d, "config", "core.checkStat", "minimal");
      const file = join(d, "src/a.py");
      const timestamp = new Date("2020-01-01T00:00:00Z");
      utimesSync(file, timestamp, timestamp);
      git(d, "add", "src/a.py");
      const indexPath = git(d, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
      // Model a same-tick, same-size edit; Git must compare content for a racily clean entry.
      utimesSync(indexPath, timestamp, timestamp);
      writeFileSync(file, "print(2)\n");
      utimesSync(file, timestamp, timestamp);
      const index = readFileSync(indexPath);
      const objects = git(d, "count-objects", "-v");

      const snap = await snapshotProject(d, join(out, "ws"), join(out, "code.diff"));

      expect(snap.changedFiles).toEqual(["src/a.py"]);
      expect(snap.dirty).toBe(true);
      expect(readFileSync(join(out, "ws/src/a.py"), "utf8")).toBe("print(2)\n");
      expect(readFileSync(join(out, "code.diff"), "utf8")).toContain("+print(2)");
      expect(readFileSync(indexPath)).toEqual(index);
      expect(statSync(indexPath).mtime).toEqual(timestamp);
      expect(git(d, "count-objects", "-v")).toBe(objects);
    },
  );

  it("copies tracked + untracked files, skips ignored ones, and records the diff", async () => {
    const d = repo();
    writeFileSync(join(d, "src/a.py"), "print(2)\n");
    writeFileSync(join(d, "new.txt"), "hello\n");
    mkdirSync(join(d, "data"));
    writeFileSync(join(d, "data/big.bin"), "x");
    const out = temp("orbit-snap-");
    writeFileSync(join(d, "large.bin"), Buffer.alloc(1024 * 1024));
    const objects = git(d, "count-objects", "-v");
    const index = readFileSync(join(d, ".git/index"));
    const snap = await snapshotProject(join(d, "src"), join(out, "ws"), join(out, "code.diff"));
    expect(snap.subdir).toBe("src");
    expect(snap.dirty).toBe(true);
    expect(snap.changedFiles.sort()).toEqual(["large.bin", "new.txt", "src/a.py"]);
    expect(snap.skippedSubmodules).toEqual([]);
    expect(readFileSync(join(out, "ws/src/a.py"), "utf8")).toBe("print(2)\n");
    expect(existsSync(join(out, "ws/new.txt"))).toBe(true);
    expect(existsSync(join(out, "ws/data/big.bin"))).toBe(false);
    const diff = readFileSync(join(out, "code.diff"), "utf8");
    expect(diff).toContain("+print(2)");
    expect(diff).toContain("+hello");
    expect(diff).toContain("GIT binary patch");
    expect(git(d, "count-objects", "-v")).toBe(objects);
    expect(readFileSync(join(d, ".git/index"))).toEqual(index);
    const scratch = await vi.mocked(mkdtemp).mock.results.at(-1)?.value;
    expect(scratch).toBeTruthy();
    expect(existsSync(String(scratch))).toBe(false);
    // The real index is untouched: new.txt is still untracked.
    expect(execFileSync("git", ["-C", d, "status", "--porcelain"], { encoding: "utf8" })).toContain(
      "?? new.txt",
    );
  });

  it("reports a clean tree and rejects non-repositories", async () => {
    const d = repo();
    const out = temp("orbit-snap-");
    const snap = await snapshotProject(d, join(out, "ws"), join(out, "code.diff"));
    expect(snap.dirty).toBe(false);
    expect(snap.commit).toMatch(/^[0-9a-f]{40}$/);
    await expect(snapshotProject(tmpdir(), join(out, "x"), join(out, "y"))).rejects.toThrow(
      /not inside a git/,
    );
  });

  it("isolates objects for linked worktrees and repositories without commits", async () => {
    const d = repo();
    const out = temp("orbit-snap-");
    const worktree = join(out, "worktree");
    git(d, "worktree", "add", "--detach", worktree);
    const unborn = temp("orbit-unborn-");
    git(unborn, "init", "-q");
    for (const [i, project] of [worktree, unborn].entries()) {
      writeFileSync(join(project, "new.txt"), "untracked fixture\n");
      const objects = git(project, "count-objects", "-v");
      const snap = await snapshotProject(project, join(out, `ws-${i}`), join(out, `diff-${i}`));
      expect(snap.commit === null).toBe(project === unborn);
      expect(snap.changedFiles).toEqual(["new.txt"]);
      expect(git(project, "count-objects", "-v")).toBe(objects);
    }
  });

  it("removes the temporary index and objects when git add fails", async () => {
    const d = repo();
    const out = temp("orbit-snap-");
    git(d, "config", "filter.fixture.clean", "false");
    git(d, "config", "filter.fixture.required", "true");
    writeFileSync(join(d, ".gitattributes"), "*.py filter=fixture\n");
    writeFileSync(join(d, "src/a.py"), "changed\n");
    const objects = git(d, "count-objects", "-v");
    await expect(snapshotProject(d, join(out, "ws"), join(out, "diff"))).rejects.toThrow(
      "git add (temp index) failed",
    );
    const scratch = await vi.mocked(mkdtemp).mock.results.at(-1)?.value;
    expect(scratch).toBeTruthy();
    expect(existsSync(String(scratch))).toBe(false);
    expect(git(d, "count-objects", "-v")).toBe(objects);
  });

  it("records untracked nested repositories returned as directories by ls-files", async () => {
    const d = repo();
    const child = join(d, "embedded");
    mkdirSync(child);
    git(child, "init", "-q");
    writeFileSync(join(child, "contents.txt"), "nested fixture\n");
    git(child, "add", ".");
    git(child, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
    const out = temp("orbit-snap-");
    const objects = git(d, "count-objects", "-v");
    const snap = await snapshotProject(d, join(out, "ws"), join(out, "diff"));
    expect(snap.skippedSubmodules).toEqual(["embedded"]);
    expect(existsSync(join(out, "ws/embedded"))).toBe(false);
    expect(git(d, "count-objects", "-v")).toBe(objects);
  });

  it("records skipped submodules and exposes their warning through events, the client and CLI", async () => {
    const d = repo();
    const child = join(d, "lib");
    mkdirSync(child);
    git(child, "init", "-q");
    writeFileSync(join(child, "contents.txt"), "not snapshotted\n");
    git(child, "add", ".");
    git(child, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
    git(
      d,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(child, "rev-parse", "HEAD").trim()},lib`,
    );
    const home = temp("orbit-snapshot-api-");
    const paths = orbitPaths({ ORBIT_HOME: home });
    ensureHome(paths);
    const store = new Store(paths.db);
    const runs = new RunService({
      store,
      paths,
      shim: ["fixture"],
      probe: async () => ({
        node: paths.node,
        probedAt: new Date().toISOString(),
        gpus: [],
        gpuError: null,
        devices: [],
        cpu: { count: 4, load1: 0, busy: 0 },
        memory: { totalGB: 8, availableGB: 8 },
        disk: { path: home, totalGB: 10, freeGB: 10 },
      }),
    });
    // Submission is real; scheduling stays stopped and the resource probe is an explicit fixture.
    await runs.stop();
    try {
      const run = await runs.submit({
        project: d,
        backend: "process",
        command: ["true"],
        resources: { gpus: 0, cpus: 1, memGB: 1 },
      });
      expect(run.code?.skippedSubmodules).toEqual(["lib"]);
      expect(existsSync(join(runs.dirs(run.id).workspace, "lib"))).toBe(false);
      expect(runs.events(run.id)).toContainEqual(
        expect.objectContaining({
          kind: "warning",
          message: "submodule contents are not snapshotted: lib",
        }),
      );
      const app = createApp({ token: "fixture", runs } as AppDeps);
      vi.stubGlobal("fetch", (input: string, init: RequestInit) => app.request(input, init));
      const client = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
      const fetched = await client.get(run.id);
      expect(fetched.code?.skippedSubmodules).toEqual(["lib"]);
      expect(formatRun(fetched)).toContain("warning  submodule contents are not snapshotted: lib");
      const { skippedSubmodules: _, ...old } = run.code as CodeSnapshot;
      expect(CodeSnapshot.parse(old).skippedSubmodules).toEqual([]);
      rmSync(child, { recursive: true });
      const missing = await snapshotProject(d, join(home, "uninitialized"), join(home, "diff"));
      expect(missing.skippedSubmodules).toEqual(["lib"]);
    } finally {
      vi.unstubAllGlobals();
      store.close();
    }
  });
});

describe("gitSource", () => {
  it("records the commit, tag and tracked changes of a benchmark checkout", async () => {
    const d = repo();
    execFileSync("git", ["-C", d, "tag", "v0.1"]);
    const clean = await gitSource(join(d, "src"));
    expect(clean).toMatchObject({ describe: "v0.1", dirty: false });
    expect(clean?.commit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(d, "untracked.txt"), "x\n");
    expect((await gitSource(d))?.dirty).toBe(false);
    writeFileSync(join(d, "src/a.py"), "print(3)\n");
    expect(await gitSource(d)).toMatchObject({ describe: "v0.1-dirty", dirty: true });
    expect(await gitSource(temp("orbit-nogit-"))).toBeNull();
  });
});
