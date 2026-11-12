import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Redactor } from "../src/lib/redact.ts";
import { downsample, outputFile, readLog, readMetrics, safeJoin } from "../src/records/index.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-records-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("records", () => {
  it("reads logs in chunks without splitting UTF-8 characters", async () => {
    const f = join(dir, "log.txt");
    writeFileSync(f, "ab中文\nline2\n");
    const first = await readLog(f, 0, 4, false); // "ab" + first byte of 中 would split
    expect(first.text).toBe("ab");
    const rest = await readLog(f, first.next, 1024, true);
    expect(first.text + rest.text).toBe("ab中文\nline2\n");
    expect(rest.eof).toBe(true);
    const tail = await readLog(f, -7, 1024, false);
    expect(tail.text).toBe("line2\n");
  });

  it.each(["fixture-secret-12345", "测试密钥测试密钥"])(
    "redacts a secret across byte windows: %s",
    async (secret) => {
      const f = join(dir, "secret.log");
      const prefix = "before 中文 ";
      const text = `${prefix}${secret} after\n`;
      writeFileSync(f, text);
      const redactor = new Redactor([secret]);
      const split = Buffer.byteLength(prefix) + 5;
      const first = await readLog(f, 0, split, true, redactor);
      const rest = await readLog(f, first.next, 1024, true, redactor);
      expect(first.text + rest.text).toBe(`${prefix}[redacted] after\n`);
      expect(rest.next).toBe(Buffer.byteLength(text));
      expect(rest.eof).toBe(true);
      expect((await readLog(f, split, 1024, true, redactor)).text).toBe(" after\n");
    },
  );

  it("holds a running log's unfinished secret until subsequent writes complete it", async () => {
    const f = join(dir, "growing.log");
    const secret = "fixture-secret-12345";
    const redactor = new Redactor([secret]);
    const prefix = "public line\n".repeat(5);
    writeFileSync(f, prefix + secret.slice(0, 7));
    const first = await readLog(f, 0, 1024, false, redactor);
    expect(first.text).toBe(prefix.slice(0, first.next));
    expect(first.eof).toBe(false);
    const waiting = await readLog(f, first.next, 1024, false, redactor);
    expect(waiting).toMatchObject({ text: "", next: first.next, eof: false });
    appendFileSync(f, `${secret.slice(7)}\n${"done\n".repeat(10)}`);
    const second = await readLog(f, first.next, 1024, false, redactor);
    const last = await readLog(f, second.next, 1024, true, redactor);
    expect(first.text + second.text + last.text).toBe(
      `${prefix}[redacted]\n${"done\n".repeat(10)}`,
    );
    expect(last.eof).toBe(true);
  });

  it("parses metrics, falling back to the line number as step", async () => {
    const f = join(dir, "metrics.jsonl");
    writeFileSync(
      f,
      '{"step": 10, "loss": 0.5}\nnot json\n{"loss": 0.25, "acc": 0.9, "tag": "x"}\n[1]\n',
    );
    const m = await readMetrics(f);
    expect(m.invalidLines).toBe(2);
    expect(m.series).toEqual([
      { key: "acc", points: [[3, 0.9]] },
      {
        key: "loss",
        points: [
          [10, 0.5],
          [3, 0.25],
        ],
      },
    ]);
    expect(m.summary).toEqual({ acc: 0.9, loss: 0.25 });
    expect((await readMetrics(join(dir, "missing"))).series).toEqual([]);
  });

  it("downsamples but keeps the last point", () => {
    const pts = Array.from({ length: 10 }, (_, i) => i);
    expect(downsample(pts, 4)).toEqual([0, 3, 6, 9]);
    expect(downsample(pts, 20)).toBe(pts);
  });

  it("refuses paths escaping the artifact directory", () => {
    expect(safeJoin("/a/b", "c/d.txt")).toBe("/a/b/c/d.txt");
    expect(safeJoin("/a/b", "../x")).toBeNull();
    expect(safeJoin("/a/b", "/etc/passwd")).toBeNull();
  });

  it("refuses symlinks outside the output root and serves a verified descriptor after a directory swap", async () => {
    const root = join(dir, "output");
    const outside = join(dir, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "sub", "file"), "safe 中文");
    writeFileSync(join(outside, "file"), "private fixture");
    symlinkSync(join(outside, "file"), join(root, "escape"));
    symlinkSync(outside, join(root, "escape-dir"));
    expect(await outputFile(root, "escape")).toBeNull();
    expect(await outputFile(root, "escape-dir/file")).toBeNull();
    expect(await outputFile(root, "sub")).toBeNull();
    const file = await outputFile(root, "sub/file");
    expect(file?.size).toBe(Buffer.byteLength("safe 中文"));
    renameSync(join(root, "sub"), join(root, "moved"));
    symlinkSync(outside, join(root, "sub"));
    expect(await new Response(file?.body).text()).toBe("safe 中文");
    expect(await outputFile(root, "sub/file")).toBeNull();
  });

  it.each(["complete", "cancel", "abort"])("closes the output descriptor on %s", async (action) => {
    const file = join(dir, `close-${action}`);
    writeFileSync(file, action === "complete" ? "data" : Buffer.alloc(1024 * 1024));
    const openCount = () =>
      readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`) === file;
        } catch {
          return false;
        }
      }).length;
    const abort = new AbortController();
    const result = await outputFile(dir, `close-${action}`, abort.signal);
    expect(result).not.toBeNull();
    if (action === "complete") expect(await new Response(result?.body).text()).toBe("data");
    else if (action === "cancel") await result?.body.cancel();
    else {
      abort.abort();
      await expect(new Response(result?.body).text()).rejects.toThrow();
    }
    await expect.poll(openCount).toBe(0);
  });

  it("serves nothing for a request aborted before the file is opened", async () => {
    writeFileSync(join(dir, "aborted-early"), Buffer.alloc(1024));
    const abort = new AbortController();
    abort.abort();
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    try {
      expect(await outputFile(dir, "aborted-early", abort.signal)).toBeNull();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(errors).toEqual([]);
  });
});
