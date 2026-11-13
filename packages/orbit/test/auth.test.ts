import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth/index.ts";
import type { Run } from "../src/contracts/index.ts";
import { codexConfig, containerPath, finishHarness, prepareAgent } from "../src/harness/index.ts";
import { maskSecret, REDACTED, Redactor } from "../src/lib/redact.ts";
import {
  groupMessage,
  Notifier,
  NotifyStore,
  payload,
  runMessage,
  urlHint,
} from "../src/notify/index.ts";
import { requireAgent, testAgents } from "../test-support/agents.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-auth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LOGIN = (refresh: string) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "access-token-abcdefgh",
      refresh_token: "refresh-token-12345678",
      account_id: "acct-9f3e",
    },
    last_refresh: refresh,
  });

describe("redaction", () => {
  it("replaces secrets, including ones split across stream chunks", async () => {
    const r = new Redactor(["sk-supersecret-123", "short"]);
    expect(r.apply("key=sk-supersecret-123;")).toBe(`key=${REDACTED};`);
    expect(r.apply("short")).toBe("short");
    const chunks = ["a sk-super", "secret-", "123 b ", "sk-supersecret-123"].map((s) =>
      Buffer.from(s),
    );
    let out = "";
    for await (const c of Readable.from(chunks).pipe(r.stream())) out += c.toString();
    expect(out).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("masks secrets for display", () => {
    expect(maskSecret("sk-ant-abcdefghijklmnop")).toBe("sk-…mnop");
    expect(maskSecret("short")).toBe("…");
  });
});

describe("auth store", () => {
  const store = new AuthStore(join(dir, "auth.json"));

  it("keeps secrets private and out of public views", () => {
    const p = store.put({
      name: "relay",
      harness: "claude-code",
      kind: "relay",
      baseUrl: "https://relay.example.com",
      secret: "sk-relay-0123456789",
    });
    expect(p.secretHint).toBe("sk-…6789");
    expect(JSON.stringify(store.list())).not.toContain("0123456789");
    expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(store.get("relay")?.secret).toBe("sk-relay-0123456789");
  });

  it("validates relay URLs and codex logins", () => {
    expect(() =>
      store.put({ name: "x", harness: "claude-code", kind: "relay", secret: "k".repeat(20) }),
    ).toThrow();
    expect(() => store.put({ name: "x", harness: "codex", kind: "login", secret: "{}" })).toThrow(
      /no tokens/,
    );
    const p = store.put({
      name: "cx",
      harness: "codex",
      kind: "login",
      secret: LOGIN("2026-01-01"),
    });
    expect(p.secretHint).toBe("chatgpt (account …9f3e)");
    expect(store.allSecrets()).toEqual(
      expect.arrayContaining([
        "access-token-abcdefgh",
        "refresh-token-12345678",
        "sk-relay-0123456789",
      ]),
    );
  });

  it("replaces and removes profiles", () => {
    const created = store.get("relay")?.profile.createdAt;
    store.put({
      name: "relay",
      harness: "claude-code",
      kind: "relay",
      baseUrl: "https://relay2.example.com",
      secret: "sk-relay-abcdefghij",
    });
    expect(store.get("relay")?.profile.createdAt).toBe(created);
    expect(store.remove("relay")).toBe(true);
    expect(store.remove("relay")).toBe(false);
  });
});

describe("harness", () => {
  const cli = join(dir, "codex-bin");
  writeFileSync(cli, "#!/bin/sh\necho codex-cli 9.9.9\n", { mode: 0o755 });
  const claude = join(dir, "claude-bin");
  writeFileSync(claude, "#!/bin/sh\necho 1.0.0 (Claude Code)\n", { mode: 0o755 });
  process.env.ORBIT_CODEX_DIR = cli;
  process.env.ORBIT_CLAUDE_BIN = claude;
  /** The registry's own lookup, so the test covers the shipped definitions and version probe. */
  const agentCli = (def: { name: string }) => testAgents().host(def as never);
  const now = "2026-01-01T00:00:00Z";
  const profile = (over: object) => ({
    env: {},
    hostNetwork: false,
    secretHint: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  });

  it("writes a codex relay config and passes the key only as secret env", async () => {
    const agent = join(dir, "run1");
    const entry = {
      profile: profile({
        name: "r",
        harness: "codex",
        kind: "relay",
        baseUrl: "https://r.example/v1",
        model: "gpt-x",
      }),
      secret: "sk-relay-codex-123",
    } as Parameters<typeof prepareAgent>[1];
    const h = await prepareAgent(requireAgent(entry.profile.harness), entry, agent, {
      hostCli: agentCli,
    });
    expect(h.cli?.version).toBe("codex-cli 9.9.9");
    expect(h.mounts).toEqual([{ source: cli, target: "/opt/orbit/codex/bin/codex", mode: "ro" }]);
    expect(h.env.CODEX_HOME).toBe("/orbit/agent/codex");
    expect(JSON.stringify(h.env)).not.toContain("sk-relay");
    expect(h.secretEnv).toEqual({ ORBIT_RELAY_API_KEY: "sk-relay-codex-123" });
    const toml = readFileSync(join(agent, "codex", "config.toml"), "utf8");
    expect(toml).toContain('base_url = "https://r.example/v1"');
    expect(toml).toContain('env_key = "ORBIT_RELAY_API_KEY"');
    expect(codexConfig(entry)).not.toContain("sk-relay");
  });

  it("copies a codex login, writes back a refreshed one and removes it after the run", async () => {
    const agent = join(dir, "run2");
    const entry = {
      profile: profile({ name: "l", harness: "codex", kind: "login" }),
      secret: LOGIN("2026-01-01"),
    } as Parameters<typeof prepareAgent>[1];
    const h = await prepareAgent(requireAgent(entry.profile.harness), entry, agent, {
      hostCli: agentCli,
    });
    const file = join(agent, "codex", "auth.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(h.secrets).toContain("refresh-token-12345678");
    expect(finishHarness(entry, agent).refreshed).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    await prepareAgent(requireAgent(entry.profile.harness), entry, agent, { hostCli: agentCli });
    writeFileSync(file, LOGIN("2026-02-01"));
    expect(finishHarness(entry, agent).refreshed).toContain("2026-02-01");
    expect(existsSync(file)).toBe(false);
  });

  it("maps claude-code kinds to environment variables", async () => {
    const mk = (kind: string) =>
      ({
        profile: profile({
          name: "c",
          harness: "claude-code",
          kind,
          baseUrl: "https://a.example",
          model: "m1",
        }),
        secret: "tok-0123456789",
      }) as Parameters<typeof prepareAgent>[1];
    const relay = await prepareAgent(requireAgent("claude-code"), mk("relay"), join(dir, "run3"), {
      hostCli: agentCli,
    });
    expect(relay.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://a.example",
      ANTHROPIC_MODEL: "m1",
      // Harbor parity: root containers may skip permissions; tier aliases follow the relay model.
      IS_SANDBOX: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "m1",
      CLAUDE_CODE_SUBAGENT_MODEL: "m1",
    });
    expect(relay.secretEnv).toEqual({ ANTHROPIC_AUTH_TOKEN: "tok-0123456789" });
    expect(relay.mounts[0]?.target).toBe("/opt/orbit/claude/claude");
    const login = await prepareAgent(requireAgent("claude-code"), mk("login"), join(dir, "run4"), {
      hostCli: agentCli,
    });
    expect(login.secretEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-0123456789" });
    // Only a relay pins the aliases; the official API keeps Claude Code's own tiers.
    expect(login.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(
      (
        await prepareAgent(requireAgent("claude-code"), mk("api-key"), join(dir, "run5"), {
          hostCli: agentCli,
        })
      ).secretEnv,
    ).toEqual({
      ANTHROPIC_API_KEY: "tok-0123456789",
    });
  });

  it("puts harness directories before the image PATH", () => {
    expect(containerPath(["/opt/a"], "/usr/bin")).toBe("/opt/a:/usr/bin");
    expect(containerPath(["/opt/a"], null)).toMatch(/^\/opt\/a:\/usr\/local\/sbin/);
  });
});

function run(id: string, state: Run["state"], group?: string): Run {
  return {
    id,
    spec: { name: `n-${id}`, group, command: ["x"] } as Run["spec"],
    state,
    reason: state === "failed" ? "exit code 1" : null,
    exitCode: state === "failed" ? 1 : 0,
    node: "h",
    image: "img",
    containerId: null,
    lease: null,
    code: null,
    proc: null,
    cleanup: "done",
    checkpoint: null,
    remote: false,
    origin: null,
    imageId: null,
    note: "",
    folder: "",
    usage: null,
    trajectory: null,
    services: [],
    after: null,
    phases: [],
    stopRequested: null,
    sizeBytes: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:01:05Z",
  };
}

describe("notify", () => {
  it("formats payloads per target kind", () => {
    const m = runMessage(run("a", "failed"), "Traceback\nValueError", "http://127.0.0.1:7717");
    expect(m.title).toContain("n-a failed");
    expect(m.text).toContain("duration: 1m5s");
    expect(m.text).toContain("ValueError");
    expect(payload("feishu", m)).toMatchObject({
      msg_type: "text",
      content: { text: expect.any(String) },
    });
    expect(payload("dingtalk", m)).toMatchObject({
      msgtype: "text",
      text: { content: expect.any(String) },
    });
    expect(payload("slack", m)).toEqual({ text: expect.stringContaining("n-a") });
    expect(payload("webhook", m)).toMatchObject({
      event: "failed",
      runs: [{ id: "a", state: "failed" }],
    });
    expect(urlHint("https://open.feishu.cn/hook/abcdef123")).toBe("https://open.feishu.cn/…f123");
    const g = groupMessage("sw", [run("a", "succeeded", "sw"), run("b", "failed", "sw")]);
    expect(g.text).toContain("1 succeeded, 1 failed");
    expect(g.text).toContain("n-b: failed (exit code 1)");
  });

  it("notifies single runs by state and groups once when the last run ends", async () => {
    const store = new NotifyStore(join(dir, "notify.json"));
    store.put({
      name: "hook",
      kind: "webhook",
      url: "http://127.0.0.1:1/x",
      on: ["failed", "group"],
    });
    expect(store.list()[0]?.urlHint).toBe("http://127.0.0.1:1/…:1/x");
    const sent: string[] = [];
    let group: Run[] = [];
    const n = new Notifier({ store, groupRuns: () => group, logTail: () => "tail" });
    n.deliver = async (m) => {
      if (store.targets().some((t) => t.on.includes(m.event))) sent.push(m.event);
    };
    await n.onTerminal(run("a", "succeeded"));
    await n.onTerminal(run("b", "failed"));
    group = [run("c", "succeeded", "g"), run("d", "running", "g")];
    await n.onTerminal(group[0] as Run);
    group = [run("c", "succeeded", "g"), run("d", "failed", "g")];
    await n.onTerminal(group[1] as Run);
    expect(sent).toEqual(["failed", "group"]);
  });
});
