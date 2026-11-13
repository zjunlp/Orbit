// HTTP client for another node's cluster API (`/cluster/v1`, bearer token).
import type { Readable } from "node:stream";
import type { z } from "zod";
import {
  type Artifacts,
  AtifSource,
  AtifTrajectory,
  CLUSTER_PREFIX,
  NodeInfo,
  type RemoteSubmit,
  Run,
  RunEvent,
} from "../contracts/index.ts";

/** `status` is the HTTP status when the node answered, null when it could not be reached. */
export class NodeError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const INFO_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

export class NodeClient {
  readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${CLUSTER_PREFIX}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new NodeError(
        `${this.url}: ${cause?.code ?? cause?.message ?? (e as Error).message}`,
        null,
      );
    }
    if (!res.ok && res.status !== 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new NodeError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
    }
    return res;
  }

  private async json<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T | null> {
    const res = await this.request(path, init);
    if (res.status === 404) return null;
    return schema.parse(await res.json());
  }

  async info(): Promise<NodeInfo> {
    const res = await this.request("/info", { timeoutMs: INFO_TIMEOUT_MS });
    if (res.status === 404) throw new NodeError(`${this.url} is not an Orbit node`, 404);
    return NodeInfo.parse(await res.json());
  }

  async hasBundle(hash: string): Promise<boolean> {
    const res = await this.request(`/bundles/${hash}`, { method: "HEAD" });
    return res.status === 200;
  }

  async putBundle(hash: string, body: Readable): Promise<void> {
    await this.request(`/bundles/${hash}`, {
      method: "PUT",
      body: body as unknown as RequestInit["body"],
      headers: { "content-type": "application/gzip" },
      // Node's fetch needs this for a streamed request body.
      ...({ duplex: "half" } as object),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }

  async submit(input: RemoteSubmit): Promise<Run> {
    const res = await this.request("/runs", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
    if (res.status === 404) throw new NodeError("cluster API not found", 404);
    return Run.parse(await res.json());
  }

  run(id: string): Promise<Run | null> {
    return this.json(Run, `/runs/${encodeURIComponent(id)}`);
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  async events(id: string, after: number): Promise<RunEvent[]> {
    const res = await this.request(`/runs/${encodeURIComponent(id)}/events?after=${after}`);
    if (res.status === 404) return [];
    const body = (await res.json()) as { events: unknown[] };
    return body.events.map((e) => RunEvent.parse(e));
  }

  /** Raw bytes of the run's log or metrics file from `offset`, and the file's current size. */
  async raw(
    id: string,
    kind: "log" | "metrics",
    offset: number,
    limit: number,
  ): Promise<{ data: Buffer; size: number } | null> {
    const res = await this.request(
      `/runs/${encodeURIComponent(id)}/raw/${kind}?offset=${offset}&limit=${limit}`,
      { timeoutMs: 120_000 },
    );
    if (res.status === 404) return null;
    return {
      data: Buffer.from(await res.arrayBuffer()),
      size: Number(res.headers.get("x-orbit-size") ?? 0),
    };
  }

  async artifacts(id: string): Promise<Artifacts | null> {
    const res = await this.request(`/runs/${encodeURIComponent(id)}/artifacts`);
    if (res.status === 404) return null;
    return (await res.json()) as Artifacts;
  }

  async trajectory(
    id: string,
    rebuild = false,
    source?: AtifSource,
  ): Promise<AtifTrajectory | null> {
    const response = await this.request(
      `/runs/${encodeURIComponent(id)}/trajectory${rebuild ? "/rebuild" : ""}`,
      rebuild
        ? {
            method: "POST",
            body: JSON.stringify({ source }),
            headers: { "content-type": "application/json" },
          }
        : undefined,
    );
    if (response.status === 404)
      throw new NodeError("worker trajectory endpoint or run is unavailable", 404);
    const trajectory = AtifTrajectory.nullable().parse(await response.json());
    if (source) {
      const adopted = AtifSource.safeParse(trajectory?.extra?.orbit?.metadata?.source);
      if (!adopted.success || adopted.data.path !== source.path)
        throw new NodeError(
          "worker did not adopt the requested ATIF source; update the worker",
          409,
        );
    }
    return trajectory;
  }
  trajectoryFile(id: string, rel: string): Promise<Response> {
    return this.request(
      `/runs/${encodeURIComponent(id)}/trajectory/files/${rel.split("/").map(encodeURIComponent).join("/")}`,
    );
  }

  /** A file under the run's output directory, streamed (404 passes through). */
  file(id: string, rel: string): Promise<Response> {
    const path = rel.split("/").map(encodeURIComponent).join("/");
    return this.request(`/runs/${encodeURIComponent(id)}/files/${path}`, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }
}
