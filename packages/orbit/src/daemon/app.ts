import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AuthStore } from "../auth/index.ts";
import type { BenchmarkRegistry } from "../bench/registry.ts";
import type { BenchService } from "../bench/service.ts";
import type { ClusterService } from "../cluster/service.ts";
import type { OrbitPaths } from "../config/paths.ts";
import { API_PREFIX, type Health, type LoginCode } from "../contracts/index.ts";
import type { FeishuBots } from "../feishu/index.ts";
import type { AgentRegistry } from "../harness/registry.ts";
import { sameSecret, tokenMatches } from "../lib/tokens.ts";
import { VERSION } from "../lib/version.ts";
import type { Notifier, NotifyStore } from "../notify/index.ts";
import type { RunService } from "../runs/service.ts";
import type { Store } from "../store/index.ts";
import type { DatasetRegistry } from "../workspace/datasets.ts";
import { errorResponse } from "./http.ts";
import { registerBenchRoutes } from "./routes/bench.ts";
import { registerClusterRoutes } from "./routes/cluster.ts";
import { registerFoldersRoutes } from "./routes/folders.ts";
import { registerRunsRoutes } from "./routes/runs.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerTrajectoryExportRoutes } from "./routes/trajectory-export.ts";

export interface AppDeps {
  token: string;
  startedAt: string;
  runs: RunService;
  auth: AuthStore;
  agents: AgentRegistry;
  notifyStore: NotifyStore;
  notifier: Notifier;
  feishu: FeishuBots;
  bench: BenchService;
  benchmarks: BenchmarkRegistry;
  cluster: ClusterService;
  datasets: DatasetRegistry;
  store: Store;
  paths: OrbitPaths;
  /** Built Web UI directory, or null when not built. */
  webDir: string | null;
}

const COOKIE = "orbit_token";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();
  const loginCodes = new Map<string, number>();
  api.use("*", async (c, next) => {
    if (tokenMatches(c.req.header("authorization"), deps.token)) return next();
    if (!sameSecret(getCookie(c, COOKIE), deps.token))
      return c.json({ error: "unauthorized" }, 401);
    // The cookie also rides on requests from other localhost ports (SameSite ignores ports):
    // changes must come from the Web UI's own origin.
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c))
      return c.json({ error: "cross-origin request refused" }, 403);
    await next();
  });

  api.get("/health", (c) =>
    c.json<Health>({ ok: true, version: VERSION, pid: process.pid, startedAt: deps.startedAt }),
  );
  api.post("/login-code", (c) => {
    if (!tokenMatches(c.req.header("authorization"), deps.token))
      return c.json({ error: "bearer token required" }, 401);
    const now = Date.now();
    for (const [code, expires] of loginCodes) if (expires <= now) loginCodes.delete(code);
    const code = randomBytes(24).toString("hex");
    const expires = now + 30_000;
    loginCodes.set(code, expires);
    c.header("cache-control", "no-store");
    return c.json<LoginCode>({ code, expiresAt: new Date(expires).toISOString() });
  });
  registerRunsRoutes(api, deps);
  registerTrajectoryExportRoutes(api, deps);
  registerFoldersRoutes(api, deps);
  registerClusterRoutes(api, deps);
  registerSettingsRoutes(api, deps);
  registerBenchRoutes(api, deps);

  app.route(API_PREFIX, api);

  app.get("/login", (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const code = c.req.query("code");
    const expires = code ? loginCodes.get(code) : undefined;
    if (code) loginCodes.delete(code);
    const valid = code
      ? expires !== undefined && expires > Date.now()
      : sameSecret(c.req.query("token"), deps.token);
    if (!valid) return c.text("invalid or expired login; run `orbit web`", 401);
    setCookie(c, COOKIE, deps.token, { httpOnly: true, sameSite: "Strict", path: "/" });
    // Only same-origin paths, so the login link cannot redirect elsewhere.
    const next = c.req.query("next") ?? "/";
    const origin = new URL(c.req.url).origin;
    const to = URL.canParse(next, origin) ? new URL(next, origin) : null;
    return c.redirect(
      to?.origin === origin && !to.pathname.startsWith("//") && !next.includes("\\")
        ? to.pathname + to.search + to.hash
        : "/",
    );
  });
  if (deps.webDir && existsSync(deps.webDir)) {
    const root = deps.webDir;
    app.use("/assets/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("Orbit Web UI is not built. Run `pnpm build` in the repository."));
  }

  app.onError((err, c) => errorResponse(c, err));
  return app;
}

/** A request from the Web UI itself (browsers send these headers on every POST/PUT/DELETE). */
function sameOrigin(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = c.req.header("origin");
  return !origin || origin === new URL(c.req.url).origin;
}
