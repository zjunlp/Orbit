import type { Hono } from "hono";
import {
  type AgentDefinition,
  AgentDefinitionInput,
  type AgentInfo,
  type AgentList,
  type AuthProfile,
  type AuthTestResult,
  type Ledger,
  NotifyPairInput,
  type NotifyTarget,
} from "../../contracts/index.ts";
import { AgentError } from "../../harness/registry.ts";
import { NotFoundError, UserError } from "../../runs/service.ts";
import type { AppDeps } from "../app.ts";
import { runDoctor } from "../doctor.ts";

export function registerSettingsRoutes(api: Hono, deps: AppDeps): void {
  const { runs, auth, agents, notifyStore, notifier, feishu, cluster } = deps;
  api.get("/resources", async (c) => c.json(await runs.resources(true)));
  api.get("/doctor", async (c) => c.json(await runDoctor(deps.paths, deps.agents)));
  api.get("/ledger", async (c) =>
    c.json<Ledger>({
      resources: await runs.resources(),
      ...runs.ledger(),
      nodes: cluster.nodeStatus(),
    }),
  );

  // Agents: definitions this node can run; built-ins cannot be replaced.
  api.get("/agents", async (c) => {
    const list = await Promise.all(agents.list().map((d) => agents.info(d)));
    return c.json<AgentList>({ agents: list });
  });
  api.get("/agents/:name", async (c) => {
    const def = agents.get(c.req.param("name"));
    if (!def) throw new NotFoundError(`Agent not found: ${c.req.param("name")}`);
    return c.json<AgentInfo>(await agents.info(def));
  });
  api.post("/agents", async (c) => {
    const parsed = AgentDefinitionInput.safeParse(await c.req.json());
    if (!parsed.success)
      throw new UserError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    try {
      return c.json<AgentDefinition>(agents.put(parsed.data), 201);
    } catch (e) {
      if (e instanceof AgentError) throw new UserError(e.message);
      throw e;
    }
  });
  api.delete("/agents/:name", (c) => {
    try {
      if (!agents.remove(c.req.param("name"))) throw new NotFoundError("Agent not found");
    } catch (e) {
      if (e instanceof AgentError) throw new UserError(e.message);
      throw e;
    }
    return c.json({ ok: true });
  });

  // Credentials: secrets go in once and never come back out.
  api.get("/auth", (c) => c.json<{ profiles: AuthProfile[] }>({ profiles: auth.list() }));
  api.post("/auth", async (c) => c.json(auth.put(await c.req.json()), 201));
  api.delete("/auth/:name", (c) => {
    if (!auth.remove(c.req.param("name"))) throw new NotFoundError("auth profile not found");
    return c.json({ ok: true });
  });
  api.post("/auth/:name/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { image?: string };
    return c.json<AuthTestResult>(await runs.testAuth(c.req.param("name"), body.image));
  });

  const withConnection = (t: NotifyTarget): NotifyTarget =>
    t.kind === "feishu-app" ? { ...t, connection: feishu.connection(t.name) } : t;
  api.get("/notify", (c) =>
    c.json<{ targets: NotifyTarget[] }>({ targets: notifyStore.list().map(withConnection) }),
  );
  api.post("/notify", async (c) => {
    const t = notifyStore.put(await c.req.json());
    void feishu.sync();
    return c.json(withConnection(t), 201);
  });
  api.delete("/notify/:name", (c) => {
    if (!notifyStore.remove(c.req.param("name")))
      throw new NotFoundError("notify target not found");
    void feishu.sync();
    return c.json({ ok: true });
  });
  api.post("/notify/:name/reconnect", (c) => {
    const t = notifyStore.targets().find((x) => x.name === c.req.param("name"));
    if (t?.kind !== "feishu-app") throw new NotFoundError("feishu-app target not found");
    void feishu.reconnect(t.name);
    return c.json({ ok: true });
  });
  api.post("/notify/:name/pair", async (c) => {
    const { code } = NotifyPairInput.parse(await c.req.json());
    try {
      await feishu.pair(c.req.param("name"), code);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    return c.json({ ok: true });
  });
  api.post("/notify/:name/test", async (c) => {
    const name = c.req.param("name");
    if (!notifyStore.targets().some((t) => t.name === name))
      throw new NotFoundError("notify target not found");
    try {
      await notifier.test(name);
    } catch (e) {
      throw new UserError(`sending failed: ${(e as Error).message}`);
    }
    return c.json({ ok: true });
  });
}
