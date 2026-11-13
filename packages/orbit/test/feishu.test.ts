import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkFeishu, initFeishu } from "../src/cli/feishu.ts";
import type { OrbitClient } from "../src/client/index.ts";
import {
  type Ledger,
  type Metrics,
  type NotifyTarget,
  NotifyTargetInput,
  type Run,
} from "../src/contracts/index.ts";
import { FeishuBots, type IncomingMessage } from "../src/feishu/index.ts";
import {
  type Card,
  type FeishuApi,
  metricCharts,
  num,
  resourcesCard,
  runCard,
} from "../src/notify/feishu.ts";
import { Notifier, NotifyStore, runMessage } from "../src/notify/index.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-feishu-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const APP = {
  kind: "feishu-app",
  appId: "cli_aa4d817096b81bdf",
  appSecret: "s3cret-value",
} as const;

function run(id: string, state: Run["state"]): Run {
  return {
    id,
    spec: {
      name: `n-${id}`,
      command: ["x"],
      resources: { gpus: 1, cpus: 4, memGB: 16 },
    } as Run["spec"],
    state,
    reason: state === "failed" ? "exit code 1" : null,
    exitCode: state === "failed" ? 1 : 0,
    node: "h",
    image: "img",
    imageId: null,
    containerId: null,
    lease: null,
    code: null,
    proc: null,
    cleanup: "done",
    checkpoint: null,
    remote: false,
    origin: null,
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

const metrics = (keys: string[], n = 500): Metrics => ({
  series: keys.map((key) => ({
    key,
    points: Array.from({ length: n }, (_, i): [number, number] => [i, 1 / (i + 1)]),
  })),
  summary: {},
  invalidLines: 0,
});

/** Records cards instead of calling Feishu. */
function fakeApi() {
  const sent: { type: string; id: string; card: Card }[] = [];
  const api = {
    sendCard: async (type: string, id: string, card: Card) => {
      sent.push({ type, id, card });
    },
  } as unknown as FeishuApi;
  return { api, sent };
}

const json = (c: Card) => JSON.stringify(c);

describe("feishu cards", () => {
  it("draws at most two plain curves, losses first, thinned for a phone", () => {
    const charts = metricCharts(metrics(["acc", "lr", "train/loss"])) as {
      chart_spec: {
        title: { text: string };
        label: { visible: boolean };
        data: { values: unknown[] };
      };
    }[];
    expect(charts).toHaveLength(2);
    expect(charts[0]?.chart_spec.title.text).toMatch(/^train\/loss/);
    expect(charts[0]?.chart_spec.label.visible).toBe(false);
    expect(charts[0]?.chart_spec.data.values.length).toBeLessThanOrEqual(201);
    expect(metricCharts(null)).toEqual([]);
    expect(num(0.00030001)).toBe("0.0003");
    expect(num(0.32471)).toBe("0.3247");
  });

  it("shows the log tail only for runs that did not succeed", () => {
    expect(json(runCard(run("a", "failed"), null, "Traceback\nValueError"))).toContain(
      "ValueError",
    );
    expect(json(runCard(run("a", "succeeded"), null, "noise"))).not.toContain("noise");
    expect(runCard(run("a", "failed"), null).header).toMatchObject({ template: "red" });
  });

  it("names who holds each GPU", () => {
    const gpu = (index: number, uuid: string) => ({
      index,
      uuid,
      name: "A100",
      memTotalMiB: 81920,
      memUsedMiB: 1024,
      utilPct: 50,
      externalMemMiB: 0,
      available: true,
      processes: [],
    });
    const l = {
      resources: {
        node: "h",
        probedAt: "",
        gpus: [gpu(0, "GPU-a"), gpu(1, "GPU-b")],
        gpuError: null,
        cpu: { count: 32, load1: 1, busy: 3 },
        memory: { totalGB: 128, availableGB: 100 },
        disk: { path: "/", totalGB: 1000, freeGB: 500 },
      },
      leases: [{ runId: "r1", gpuIds: ["GPU-a"], state: "active" }],
      queued: [{ runId: "r2", reason: "waiting for 2 GPUs" }],
      nodes: [],
    } as unknown as Ledger;
    const text = json(resourcesCard(l));
    expect(text).toContain("GPU0** 1/80 GB · 50% · run r1");
    expect(text).toContain("GPU1** 1/80 GB · 50% · free");
    expect(text).toContain("waiting for 2 GPUs");
  });
});

describe("feishu-app targets", () => {
  it("validates the app id and never shows the secret", () => {
    expect(() => NotifyTargetInput.parse({ ...APP, name: "x", appId: "nope" })).toThrow();
    const store = new NotifyStore(join(dir, "store.json"));
    const t = store.put({ ...APP, name: "app" });
    expect(t).toMatchObject({ kind: "feishu-app", urlHint: APP.appId, users: 0 });
    expect(JSON.stringify(store.list())).not.toContain(APP.appSecret);
  });

  it("keeps paired users when the same app is saved again", () => {
    const store = new NotifyStore(join(dir, "keep.json"));
    store.put({ ...APP, name: "app" });
    store.addUser("app", "ou_1");
    store.addUser("app", "ou_1");
    store.put({ ...APP, name: "app", appSecret: "rotated" });
    expect(store.list()[0]?.users).toBe(1);
    store.put({ ...APP, name: "app", appId: "cli_0000000000000000" });
    expect(store.list()[0]?.users).toBe(0);
    expect(readFileSync(join(dir, "keep.json"), "utf8")).toContain("cli_0000000000000000");
  });

  it("sends run cards with curves to paired users only", async () => {
    const store = new NotifyStore(join(dir, "send.json"));
    store.put({ ...APP, name: "app" });
    const { api, sent } = fakeApi();
    const n = new Notifier({
      store,
      groupRuns: () => [],
      logTail: () => "",
      metrics: async () => metrics(["loss"], 10),
    });
    n.feishu = () => api;
    await expect(n.test("app")).rejects.toThrow(/no paired users/);
    store.addUser("app", "ou_1");
    await n.onTerminal(run("a", "failed"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "open_id", id: "ou_1" });
    expect(json(sent[0]?.card ?? {})).toContain('"tag":"chart"');
    expect(runMessage(run("a", "failed"), "tail").log).toBe("tail");
  });
});

describe("feishu bots", () => {
  function setup() {
    const store = new NotifyStore(join(dir, `bots-${Math.random()}.json`));
    store.put({ ...APP, name: "app" });
    const { api, sent } = fakeApi();
    const calls: string[] = [];
    const links: { name: string; closed: boolean }[] = [];
    const bots = new FeishuBots({
      store,
      feishu: () => api,
      log: () => {},
      api: async <T>(path: string) => {
        calls.push(path);
        if (path === "/runs?limit=10") return { runs: [run("a", "running")] } as T;
        throw new Error(`unexpected ${path}`);
      },
      connect: async (t, _onMessage, onState) => {
        const link = { name: t.name, closed: false };
        links.push(link);
        onState("connected");
        return { close: () => (link.closed = true) };
      },
    });
    return { store, bots, sent, calls, links };
  }

  const msg = (
    id: string,
    text: string,
    chat_type = "p2p",
    mentions?: unknown[],
  ): IncomingMessage => ({
    sender: { sender_id: { open_id: "ou_me" } },
    message: {
      message_id: id,
      chat_id: "oc_chat",
      chat_type,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  });

  it("answers unknown users with a pairing code, then commands once paired", async () => {
    const { store, bots, sent, calls } = setup();
    await bots.onMessage("app", msg("m1", "/runs"));
    expect(calls).toEqual([]);
    const code = /notify pair app (\d{6})/.exec(json(sent[0]?.card ?? {}))?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    await expect(bots.pair("app", "000000" === code ? "111111" : "000000")).rejects.toThrow();
    await bots.pair("app", code);
    expect(store.list()[0]?.users).toBe(1);
    expect(json(sent[1]?.card ?? {})).toContain("Paired");
    await expect(bots.pair("app", code)).rejects.toThrow(/expired/);

    await bots.onMessage("app", msg("m2", "/runs"));
    await bots.onMessage("app", msg("m2", "/runs"));
    expect(calls).toEqual(["/runs?limit=10"]);
    expect(sent[2]).toMatchObject({ type: "chat_id", id: "oc_chat" });
    expect(json(sent[2]?.card ?? {})).toContain("n-a");
  });

  it("ignores group messages that do not mention the bot and replies with errors", async () => {
    const { store, bots, sent } = setup();
    store.addUser("app", "ou_me");
    await bots.onMessage("app", msg("g1", "/runs", "group"));
    expect(sent).toHaveLength(0);
    await bots.onMessage("app", msg("g2", "@_user_1 /show missing", "group", [{}]));
    expect(sent[0]?.card.header).toMatchObject({ template: "red" });
    await bots.onMessage("app", msg("g3", "hello", "p2p"));
    expect(json(sent[1]?.card ?? {})).toContain("/gpu");
  });

  it("connects app targets and closes removed or changed ones", async () => {
    const { store, bots, links } = setup();
    await bots.sync();
    expect(bots.connection("app")).toBe("connected");
    await bots.sync();
    expect(links).toHaveLength(1);
    store.put({ ...APP, name: "app", appSecret: "rotated" });
    await bots.sync();
    expect(links.map((l) => l.closed)).toEqual([true, false]);
    store.remove("app");
    await bots.sync();
    expect(bots.connection("app")).toBe("stopped");
    expect(links[1]?.closed).toBe(true);
  });
});

describe("orbit feishu init", () => {
  /** A client over a real store, with the bot connection state set by the test. */
  function fakeClient(connection: NotifyTarget["connection"], testError?: string) {
    const store = new NotifyStore(join(dir, `init-${Math.random()}.json`));
    const calls: string[] = [];
    const client = {
      notifyList: async () =>
        store.list().map((t) => (t.kind === "feishu-app" ? { ...t, connection } : t)),
      notifyPut: async (t: Parameters<NotifyStore["put"]>[0]) => store.put(t),
      notifyReconnect: async (name: string) => {
        calls.push(`reconnect ${name}`);
        return { ok: true };
      },
      notifyTest: async (name: string) => {
        calls.push(`test ${name}`);
        if (testError) throw new Error(testError);
        return { ok: true };
      },
    } as unknown as OrbitClient;
    return { store, client, calls };
  }
  const registered = {
    client_id: "cli_1111111111111111",
    client_secret: "new-secret",
    user_info: { open_id: "ou_scanner", tenant_brand: "feishu" },
  };

  it("creates the app from the QR scan, pairs the scanner and checks the bot", async () => {
    const { store, client, calls } = fakeClient("connected");
    const lines: string[] = [];
    const r = await initFeishu(
      {
        client,
        say: (l) => lines.push(l),
        qr: (url) => `QR(${url})`,
        register: async (onQr) => {
          onQr("https://open.feishu.cn/page/launcher?user_code=X", 600);
          return registered;
        },
      },
      "phone",
      ["failed"],
    );
    expect(lines[0]).toBe("QR(https://open.feishu.cn/page/launcher?user_code=X)");
    expect(r).toEqual({
      name: "phone",
      appId: registered.client_id,
      users: 1,
      connection: "connected",
      test: "sent",
    });
    expect(calls).toEqual(["reconnect phone", "test phone"]);
    const saved = store.targets()[0];
    expect(saved).toMatchObject({ kind: "feishu-app", users: ["ou_scanner"], on: ["failed"] });
    expect(JSON.stringify(store.list())).not.toContain("new-secret");
  });

  it("refuses a taken name and an app bound twice", async () => {
    const { store, client } = fakeClient("connected");
    store.put({ ...APP, name: "phone" });
    const d = { client, say: () => {}, qr: () => "", register: async () => registered };
    await expect(initFeishu(d, "phone", ["failed"])).rejects.toThrow(/exists/);
    expect(() => store.put({ ...APP, name: "other" })).toThrow(/already bound as phone/);
  });

  it("says what to fix when the long connection or sending fails", async () => {
    const { store, client } = fakeClient("failed", "error 99991672: Access denied");
    store.put({ ...APP, name: "phone", users: ["ou_1"] });
    const lines: string[] = [];
    const r = await checkFeishu(
      { client, say: (l) => lines.push(l), sleep: async () => {} },
      "phone",
    );
    expect(r.connection).toBe("failed");
    expect(r.test).toContain("99991672");
    expect(lines.join("\n")).toContain(`https://open.feishu.cn/app/${APP.appId}/event`);
    expect(lines.join("\n")).toContain(`https://open.feishu.cn/app/${APP.appId}/auth`);
  });

  it("reconnects one bot on request", async () => {
    const store = new NotifyStore(join(dir, "reconnect.json"));
    store.put({ ...APP, name: "app" });
    let opened = 0;
    const bots = new FeishuBots({
      store,
      feishu: () => fakeApi().api,
      log: () => {},
      api: async () => ({}) as never,
      connect: async (_t, _m, onState) => {
        opened++;
        onState("connected");
        return { close: () => {} };
      },
    });
    await bots.sync();
    await bots.reconnect("app");
    expect(opened).toBe(2);
    expect(bots.connection("app")).toBe("connected");
  });
});
