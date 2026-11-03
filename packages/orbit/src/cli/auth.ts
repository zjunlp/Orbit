import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import type {
  AuthKind,
  AuthProfile,
  Harness,
  NotifyEvent,
  NotifyTarget,
} from "../contracts/index.ts";
import { readStdinSecret } from "./confirm.ts";
import { compactTable as table } from "./format.ts";
import { kv } from "./options.ts";

export type Print = (json: boolean | undefined, value: unknown, text: () => string) => void;

interface AddOpts {
  harness: Harness;
  kind: AuthKind;
  baseUrl?: string;
  model?: string;
  env: string[];
  hostNetwork?: boolean;
  keyEnv?: string;
  keyStdin?: boolean;
  from?: string;
  fromEnv?: boolean;
  json?: boolean;
}

/** Claude Code settings may carry the relay variables instead of the shell. */
function claudeSettingsEnv(): Record<string, string> {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  try {
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
      env?: Record<string, string>;
    };
    return s.env ?? {};
  } catch {
    return {};
  }
}

/** Non-secret model settings copied from the environment for Claude Code profiles. */
const CLAUDE_MODEL_VARS = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

const SECRET_VAR: Record<string, Partial<Record<AuthKind, string>>> = {
  codex: { login: "", "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
  "claude-code": {
    login: "CLAUDE_CODE_OAUTH_TOKEN",
    "api-key": "ANTHROPIC_API_KEY",
    relay: "ANTHROPIC_AUTH_TOKEN",
  },
};

/** Log in with `codex login --device-auth` into a private temporary CODEX_HOME; returns auth.json. */
async function codexLogin(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "orbit-codex-login-"));
  try {
    const code = await new Promise<number>((resolve) => {
      const p = spawn("codex", ["login", "--device-auth"], {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: home },
      });
      p.on("error", () => resolve(127));
      p.on("close", (c) => resolve(c ?? 1));
    });
    const file = join(home, "auth.json");
    if (code !== 0 || !existsSync(file)) throw new Error(`codex login failed (exit ${code})`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function readSecret(o: AddOpts, env: Record<string, string>): Promise<string> {
  if (o.keyStdin) return readStdinSecret(`Paste the ${o.harness} ${o.kind} secret`);
  if (o.keyEnv) {
    const v = process.env[o.keyEnv];
    if (!v?.trim()) throw new Error(`${o.keyEnv} is not set`);
    return v.trim();
  }
  if (o.from) {
    if (o.harness === "codex" && o.kind === "login") {
      console.error(
        "note: this profile shares the refresh token with the copied login; when one side refreshes,\n" +
          "      the other may have to log in again. `orbit auth add` without --from logs in separately.",
      );
    }
    return readFileSync(o.from, "utf8").trim();
  }
  if (o.fromEnv) {
    const name = SECRET_VAR[o.harness]?.[o.kind];
    const v = name ? env[name] : undefined;
    if (!v)
      throw new Error(`--from-env: ${name || "no variable"} is not set for ${o.harness} ${o.kind}`);
    return v;
  }
  if (o.harness === "codex" && o.kind === "login") return codexLogin();
  throw new Error(
    "give the secret with --key-stdin, --key-env VAR or --from-env (never on the command line)",
  );
}

export { kv } from "./options.ts";

function formatProfiles(ps: AuthProfile[]): string {
  if (ps.length === 0) return "no auth profiles; add one with `orbit auth add`";
  const rows = ps.map((p) => [
    p.name,
    p.harness,
    p.kind,
    p.secretHint ?? "",
    [p.baseUrl, p.model, p.hostNetwork ? "host network" : ""].filter(Boolean).join(" · "),
  ]);
  return table([["NAME", "HARNESS", "KIND", "SECRET", "DETAILS"], ...rows]);
}

function formatTargets(ts: NotifyTarget[]): string {
  if (ts.length === 0) return "no notification targets; add one with `orbit notify add`";
  return table([
    ["NAME", "KIND", "ON", "URL / APP", "USERS", "CONNECTION"],
    ...ts.map((t) => [
      t.name,
      t.kind,
      t.on.join(","),
      t.urlHint,
      t.users === undefined ? "" : String(t.users),
      t.connection ?? "",
    ]),
  ]);
}

export function registerAuth(program: Command, client: () => Promise<OrbitClient>, print: Print) {
  const auth = program
    .command("auth")
    .description(
      "credential profiles for Codex / Claude Code inside containers (run --auth <name>)",
    );

  auth
    .command("add <name>")
    .description("create or replace a profile; the secret never goes on the command line")
    .requiredOption("--harness <harness>", "codex | claude-code")
    .requiredOption("--kind <kind>", "login | api-key | relay")
    .option(
      "--base-url <url>",
      "relay base URL (OpenAI Responses API for codex, Anthropic API for claude-code)",
    )
    .option("--model <model>", "default model")
    .option(
      "-e, --env <KEY=VALUE>",
      "extra non-secret variable, e.g. HTTPS_PROXY",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option("--host-network", "runs share the host network (e.g. for a proxy on 127.0.0.1)")
    .option("--key-stdin", "read the API key / token from stdin")
    .option("--key-env <VAR>", "read the API key / token from this environment variable")
    .option("--from <file>", "read the secret from a file (codex login: a Codex auth.json)")
    .option(
      "--from-env",
      "take the secret, base URL and models from the environment / Claude settings",
    )
    .option("--json", "print JSON")
    .action(async (name: string, o: AddOpts) => {
      const env: Record<string, string> = {
        ...claudeSettingsEnv(),
        ...(process.env as Record<string, string>),
      };
      const extra = kv(o.env, "--env");
      let baseUrl = o.baseUrl;
      let model = o.model;
      if (o.fromEnv && o.harness === "claude-code") {
        baseUrl ??= o.kind === "relay" ? env.ANTHROPIC_BASE_URL : undefined;
        model ??= env.ANTHROPIC_MODEL;
        for (const k of CLAUDE_MODEL_VARS) if (env[k] && !(k in extra)) extra[k] = env[k];
      }
      const secret = await readSecret(o, env);
      const p = await (await client()).authPut({
        name,
        harness: o.harness,
        kind: o.kind,
        baseUrl,
        model,
        env: extra,
        hostNetwork: Boolean(o.hostNetwork),
        secret,
      });
      print(o.json, p, () => `saved ${p.name}: ${p.harness} ${p.kind} ${p.secretHint ?? ""}`);
    });

  auth
    .command("list")
    .description("list profiles (secrets are never shown)")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const ps = await (await client()).authList();
      print(o.json, ps, () => formatProfiles(ps));
    });

  auth
    .command("rm <name>")
    .description("delete a profile")
    .action(async (name: string) => {
      await (await client()).authRemove(name);
      console.log(`removed ${name}`);
    });

  auth
    .command("test <name>")
    .description("run the Agent in a small container with this profile and check that it answers")
    .option("--image <image>", "image for the test run", "python:3.12-slim")
    .option("--json", "print JSON")
    .action(async (name: string, o: { image: string; json?: boolean }) => {
      const r = await (await client()).authTest(name, o.image);
      print(o.json, r, () => `${r.ok ? "ok" : "FAILED"}  run ${r.runId}\n${r.detail}`);
      if (!r.ok) process.exitCode = 1;
    });
}

export function registerNotify(program: Command, client: () => Promise<OrbitClient>, print: Print) {
  const notify = program
    .command("notify")
    .description(
      "send run completion / failure notifications to Feishu, DingTalk, WeCom, Slack or a webhook; " +
        "a Feishu app (feishu-app) also answers /gpu, /runs and /show in Feishu",
    );

  notify
    .command("add <name>")
    .description("create or replace a target")
    .requiredOption("--kind <kind>", "feishu | dingtalk | wecom | slack | webhook | feishu-app")
    .option("--url <url>", "webhook URL (visible in process arguments; prefer --url-stdin)")
    .option("--url-stdin", "read the webhook URL from stdin (hidden at a terminal)")
    .option("--url-env <VAR>", "read the webhook URL from this environment variable")
    .option("--app-id <id>", "feishu-app: the app id (cli_...)")
    .option("--secret-env <VAR>", "feishu-app: read the app secret from this environment variable")
    .option("--secret-stdin", "feishu-app: read the app secret from stdin")
    .option("--on <events>", "comma-separated: succeeded,failed,group", "succeeded,failed,group")
    .option("--json", "print JSON")
    .action(
      async (
        name: string,
        o: {
          kind: NotifyTarget["kind"];
          url?: string;
          urlEnv?: string;
          urlStdin?: boolean;
          appId?: string;
          secretEnv?: string;
          secretStdin?: boolean;
          on: string;
          json?: boolean;
        },
      ) => {
        const on = o.on.split(",").filter(Boolean) as NotifyEvent[];
        if (o.url !== undefined)
          console.error(
            "warning: --url exposes the webhook URL in process arguments; use --url-stdin or --url-env",
          );
        let t: NotifyTarget;
        if (o.kind === "feishu-app") {
          if (!o.appId) throw new Error("give --app-id");
          const appSecret = o.secretStdin
            ? await readStdinSecret("Paste the Feishu app secret")
            : o.secretEnv
              ? process.env[o.secretEnv]?.trim()
              : undefined;
          if (!appSecret)
            throw new Error(
              "give the secret with --secret-stdin or --secret-env VAR (it must be set)",
            );
          t = await (await client()).notifyPut({
            name,
            kind: o.kind,
            appId: o.appId,
            appSecret,
            on,
          });
        } else {
          const url = o.urlStdin
            ? await readStdinSecret("Paste the webhook URL")
            : (o.url ?? (o.urlEnv ? process.env[o.urlEnv]?.trim() : undefined));
          if (!url) throw new Error("give --url-stdin or --url-env VAR (it must be set), or --url");
          t = await (await client()).notifyPut({ name, kind: o.kind, url, on });
        }
        print(o.json, t, () =>
          t.kind === "feishu-app"
            ? `saved ${t.name}: ${t.kind} on ${t.on.join(",")}; message the bot in Feishu to pair (${t.users ?? 0} paired)`
            : `saved ${t.name}: ${t.kind} on ${t.on.join(",")}`,
        );
      },
    );

  notify
    .command("pair <name> <code>")
    .description("allow the Feishu user who got this code from the bot")
    .action(async (name: string, code: string) => {
      await (await client()).notifyPair(name, code);
      console.log(`paired with ${name}`);
    });

  notify
    .command("list")
    .description("list targets")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const ts = await (await client()).notifyList();
      print(o.json, ts, () => formatTargets(ts));
    });

  notify
    .command("rm <name>")
    .description("delete a target")
    .action(async (name: string) => {
      await (await client()).notifyRemove(name);
      console.log(`removed ${name}`);
    });

  notify
    .command("test <name>")
    .description("send a test message")
    .action(async (name: string) => {
      await (await client()).notifyTest(name);
      console.log(`sent to ${name}`);
    });
}
