// Feishu app bots: one outbound long connection per `feishu-app` notify target. Paired users get
// read-only answers built from the daemon's own HTTP API; unknown users get a pairing code.
import { randomInt } from "node:crypto";
import {
  FEISHU_APP,
  type Ledger,
  type LogChunk,
  type Metrics,
  type NotifyTarget,
  type Run,
} from "../contracts/index.ts";
import {
  type Card,
  type FeishuApi,
  resourcesCard,
  runCard,
  runsCard,
  textCard,
} from "../notify/feishu.ts";
import type { FeishuAppTarget, NotifyStore } from "../notify/index.ts";

type Connection = NonNullable<NotifyTarget["connection"]>;

/** The parts of `im.message.receive_v1` the bot reads. */
export interface IncomingMessage {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: unknown[];
  };
}

/** A started long connection. */
export interface Link {
  close(): void;
}

export type Connect = (
  t: FeishuAppTarget,
  onMessage: (m: IncomingMessage) => void,
  onState: (s: Connection) => void,
  log: (msg: string) => void,
) => Promise<Link>;

export interface FeishuBotsDeps {
  store: NotifyStore;
  /** GET a daemon API path (e.g. `/ledger`) as the daemon itself. */
  api<T>(path: string): Promise<T>;
  /** OpenAPI client of a target (shared with the notifier's token cache). */
  feishu(t: FeishuAppTarget): FeishuApi;
  log(msg: string): void;
  /** Opens the long connection; tests replace the SDK. */
  connect?: Connect;
}

const PAIR_TTL_MS = 10 * 60_000;
const SEEN_MAX = 1000;

const HELP = [
  "`/gpu` GPUs, CPU, memory and the queue",
  "`/runs` recent runs",
  "`/show <run id>` one run with its curves",
].join("\n");

interface Bot {
  key: string;
  link: Link | null;
  state: Connection;
}

export class FeishuBots {
  private readonly deps: FeishuBotsDeps;
  private readonly bots = new Map<string, Bot>();
  private readonly codes = new Map<
    string,
    { target: string; openId: string; chatId: string; until: number }
  >();
  private readonly seen = new Set<string>();

  constructor(deps: FeishuBotsDeps) {
    this.deps = deps;
  }

  /** Connect new or changed app targets and close removed ones. */
  async sync(): Promise<void> {
    const apps = this.deps.store
      .targets()
      .filter((t): t is FeishuAppTarget => t.kind === FEISHU_APP);
    for (const [name, bot] of this.bots) {
      const t = apps.find((a) => a.name === name);
      if (!t || keyOf(t) !== bot.key) {
        bot.link?.close();
        this.bots.delete(name);
      }
    }
    await Promise.all(apps.filter((t) => !this.bots.has(t.name)).map((t) => this.start(t)));
  }

  private async start(t: FeishuAppTarget): Promise<void> {
    const bot: Bot = { key: keyOf(t), link: null, state: "connecting" };
    this.bots.set(t.name, bot);
    try {
      const link = await (this.deps.connect ?? connectSdk)(
        t,
        (m) => void this.onMessage(t.name, m),
        (s) => {
          bot.state = s;
        },
        (msg) => this.deps.log(`feishu ${t.name}: ${msg}`),
      );
      if (this.bots.get(t.name) === bot) bot.link = link;
      else link.close();
    } catch (e) {
      bot.state = "failed";
      this.deps.log(`feishu ${t.name}: ${(e as Error).message}`);
    }
  }

  /** Close and reopen one bot's connection (e.g. after its settings changed in Feishu). */
  async reconnect(name: string): Promise<void> {
    this.bots.get(name)?.link?.close();
    this.bots.delete(name);
    await this.sync();
  }

  connection(name: string): Connection {
    return this.bots.get(name)?.state ?? "stopped";
  }

  stop(): void {
    for (const bot of this.bots.values()) bot.link?.close();
    this.bots.clear();
  }

  /** Pair the user who received `code`; tells them in Feishu. */
  async pair(target: string, code: string): Promise<void> {
    const p = this.codes.get(code);
    if (!p || p.target !== target || Date.now() > p.until)
      throw new Error("unknown or expired code: message the bot again for a new one");
    this.codes.delete(code);
    this.deps.store.addUser(target, p.openId);
    await this.reply(
      target,
      p.chatId,
      textCard("✅ Paired", `You can now ask Orbit.\n\n${HELP}`, "green"),
    ).catch((e: Error) => this.deps.log(`feishu ${target}: ${e.message}`));
  }

  /** Handle one message; never throws (errors go to the daemon log). */
  async onMessage(target: string, m: IncomingMessage): Promise<void> {
    const id = m.message?.message_id;
    const openId = m.sender?.sender_id?.open_id;
    const chatId = m.message?.chat_id;
    if (!id || !openId || !chatId || this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const t = this.deps.store.targets().find((x) => x.name === target);
    if (t?.kind !== FEISHU_APP) return;
    const p2p = m.message?.chat_type === "p2p";
    // In groups only messages that @-mention the bot are meant for it.
    if (!p2p && !m.message?.mentions?.length) return;
    try {
      if (!t.users?.includes(openId)) {
        if (p2p) await this.reply(target, chatId, this.pairingCard(target, openId, chatId));
        return;
      }
      await this.reply(target, chatId, await this.answer(textOf(m)));
    } catch (e) {
      this.deps.log(`feishu ${target}: ${(e as Error).message}`);
      await this.reply(target, chatId, textCard("Error", (e as Error).message, "red")).catch(
        () => {},
      );
    }
  }

  private pairingCard(target: string, openId: string, chatId: string): Card {
    for (const [c, p] of this.codes)
      if (p.openId === openId || Date.now() > p.until) this.codes.delete(c);
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (this.codes.has(code));
    this.codes.set(code, { target, openId, chatId, until: Date.now() + PAIR_TTL_MS });
    return textCard(
      "🔒 Not paired yet",
      `On the machine running Orbit:\n\`\`\`\norbit notify pair ${target} ${code}\n\`\`\`\nThe code is valid for 10 minutes.`,
      "orange",
    );
  }

  /** Read-only commands; anything else gets the help. */
  async answer(text: string): Promise<Card> {
    const [cmd = "", arg] = text.trim().replace(/^\//, "").split(/\s+/);
    switch (cmd.toLowerCase()) {
      case "gpu":
      case "gpus":
      case "resources":
        return resourcesCard(await this.deps.api<Ledger>("/ledger"));
      case "runs":
      case "ps": {
        const { runs } = await this.deps.api<{ runs: Run[] }>("/runs?limit=10");
        return runsCard(runs);
      }
      case "show": {
        if (!arg) return textCard("Usage", "`/show <run id>`");
        const enc = encodeURIComponent(arg);
        const run = await this.deps.api<Run>(`/runs/${enc}`);
        const metrics = await this.deps.api<Metrics>(`/runs/${enc}/metrics`).catch(() => null);
        return runCard(run, metrics, await this.logTail(enc, run));
      }
      default:
        return textCard("Orbit", HELP);
    }
  }

  private async logTail(enc: string, run: Run): Promise<string> {
    if (run.state === "succeeded" || run.state === "queued") return "";
    const chunk = await this.deps
      .api<LogChunk>(`/runs/${enc}/logs?offset=-4096&limit=4096`)
      .catch(() => null);
    if (!chunk?.text) return "";
    return chunk.text.trimEnd().split("\n").slice(-15).join("\n");
  }

  private reply(target: string, chatId: string, card: Card): Promise<void> {
    const t = this.deps.store.targets().find((x) => x.name === target);
    if (t?.kind !== FEISHU_APP) return Promise.resolve();
    return this.deps.feishu(t).sendCard("chat_id", chatId, card);
  }
}

const keyOf = (t: FeishuAppTarget) => `${t.appId}:${t.appSecret}`;

/** Text of a text message without the `@_user_1` mention placeholders. */
function textOf(m: IncomingMessage): string {
  if (m.message?.message_type && m.message.message_type !== "text") return "";
  try {
    const { text } = JSON.parse(m.message?.content ?? "{}") as { text?: string };
    return (text ?? "").replace(/@_user_\d+/g, "").trim();
  } catch {
    return "";
  }
}

/** The official SDK's long connection, loaded only when an app target exists. */
const connectSdk: Connect = async (t, onMessage, onState, log) => {
  const lark = await import("@larksuiteoapi/node-sdk");
  const quiet = () => {};
  const logger = {
    error: (...a: unknown[]) => log(a.flat().map(String).join(" ")),
    warn: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
  };
  const dispatcher = new lark.EventDispatcher({ logger }).register({
    "im.message.receive_v1": async (data: IncomingMessage) => {
      // Return at once: Feishu redelivers events that are not acknowledged within a few seconds.
      onMessage(data);
    },
  });
  const ws = new lark.WSClient({
    appId: t.appId,
    appSecret: t.appSecret,
    logger,
    // Reconnect when pongs stop arriving instead of waiting for a socket error (as OpenClaw does).
    wsConfig: { pingTimeout: 3 },
    handshakeTimeoutMs: 15_000,
    onReady: () => onState("connected"),
    onReconnecting: () => onState("connecting"),
    onReconnected: () => onState("connected"),
    onError: (e: Error) => {
      onState("failed");
      log(e.message);
    },
  });
  await ws.start({ eventDispatcher: dispatcher });
  return { close: () => ws.close({ force: true }) };
};
