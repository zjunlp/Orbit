import type { OrbitPaths, RunDirs } from "../config/paths.ts";
import type {
  AfterStatus,
  AtifTrajectory,
  DoctorCheck,
  NodeResources,
  RemoteSubmit,
  Run,
  RunEvent,
  RunSpec,
  RunState,
  ServiceSpec,
} from "../contracts/index.ts";
import type * as docker from "../executor/docker.ts";
import type { Prepared } from "../harness/index.ts";
import type { Redactor } from "../lib/redact.ts";
import type { Store } from "../store/index.ts";
import type { Control } from "./execution.ts";
import type { RemoteNode, RemotePlacement } from "./placement.ts";
import type { RunServiceDeps } from "./service.ts";
import type { Targets, UsageSampler } from "./usage.ts";

export interface RunContext {
  readonly active: Map<string, Control>;
  armTimeout(run: Run): void;
  buildFile(run: Run, dirs: RunDirs): string;
  bundleTag(df: string, name: string): string | null;
  readonly cgroupDirs: Map<string, string>;
  changed(run: Run, event?: RunEvent): void;
  cleanup(run: Run): Promise<void>;
  trajectory(id: string, finalized?: boolean): Promise<AtifTrajectory | null>;
  cleanupProcess(run: Run): Promise<boolean>;
  cleanupServices(run: Run): Promise<boolean>;
  captureCheckpoint(id: string, containerId: string, executionMin: number): Promise<void>;
  collect(run: Run, containerId: string): Promise<void>;
  containerCgroups(ids: string[]): Promise<string[]>;
  containerSpec(run: Run, dirs: RunDirs, image: string): docker.ContainerSpec;
  control(id: string): Control;
  readonly deps: RunServiceDeps;
  dirs(id: string): RunDirs;
  disarmTimeout(id: string): void;
  dispatchRemote(id: string): Promise<void>;
  ensureImage(run: Run, dirs: RunDirs): Promise<string>;
  envFile(id: string): string;
  finalize(run: Run, state: RunState, exitCode: number | null, reason: string | null): Promise<Run>;
  finishAuth(run: Run): void;
  readonly gpuMode: docker.GpuMode;
  readonly homeLabel: string;
  launchProcess(run: Run, dirs: RunDirs, ctl: Control): Promise<void>;
  localBlocker(spec: RunSpec): Promise<string | null>;
  loseRemote(id: string, why: string): void;
  measure(id: string): Promise<void>;
  mirrors(): Run[];
  mustGet(id: string): Run;
  networkNames(run: Run): { short: string; name: string; internal: boolean }[];
  readonly node: string;
  passEnv(run: Run): Record<string, string>;
  readonly paths: OrbitPaths;
  prepareAuth(run: Run, dirs: RunDirs): Promise<Prepared>;
  receiveRemote(input: RemoteSubmit): Promise<Run>;
  readonly receiving: Map<string, Promise<Run>>;
  redactLog(run: Run): Promise<void>;
  redactor(run?: Run): Redactor;
  readonly refused: Map<string, { why: string; until: number }>;
  readonly remote: RemotePlacement | null;
  remoteNodes(): RemoteNode[];
  requeueRemote(id: string, why: string): void;
  resources(force?: boolean): Promise<NodeResources>;
  runAfter(id: string, containerId: string, ctl: Control): Promise<void>;
  runHooks(id: string, containerId: string, which: "main" | "services"): Promise<void>;
  readonly samplers: Map<string, UsageSampler>;
  save(run: Run, kind?: string, message?: string): void;
  serviceContainer(run: Run, s: ServiceSpec, image: string): docker.ContainerSpec;
  serviceImage(run: Run, dirs: RunDirs, s: ServiceSpec): Promise<string>;
  setAfter(id: string, status: AfterStatus, message: string): void;
  skipAfter(id: string, why: string): void;
  specError(spec: RunSpec): string | null;
  startCheck(spec: RunSpec, here: boolean, candidates: RemoteNode[]): Promise<DoctorCheck>;
  startServices(id: string, dirs: RunDirs, ctl: Control): Promise<void>;
  startUsage(id: string, targets: () => Promise<Targets>): void;
  stopProcess(run: Run): Promise<void>;
  stopServices(id: string): Promise<void>;
  stopUsage(run: Run, oomKilled: boolean): Promise<void>;
  readonly stopped: boolean;
  readonly store: Store;
  tick(): Promise<void>;
  waitMain(id: string, containerId: string): Promise<{ exitCode: number; running: boolean }>;
  waitServices(id: string, names: string[], ctl: Control): Promise<void>;
  waitStopped(containerId: string): Promise<number>;
  watch(id: string, containerId: string, recovered: boolean): Promise<void>;
  watchProcess(id: string, exited: Promise<number | null> | null): Promise<void>;
}
