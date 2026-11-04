import { EpisodeTrajectory, type SessionMessage } from "../contracts/index.ts";

export interface EfeTrajectoryInput {
  goal: string;
  journal: string;
  final: unknown;
  actions?: number[][];
  messages: SessionMessage[];
  video?: string;
  lastFrame?: string;
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** MetaWorld+ standard/2.1 journal and render clock; no filesystem access or grading. */
export function importEfeTrajectory(input: EfeTrajectoryInput): EpisodeTrajectory {
  const events = input.journal
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  const final = record(input.final);
  if (final.protocol !== "eai-standard/2.1" || !String(final.tool).includes("mw_tool"))
    throw new Error("unsupported EFE trajectory protocol or simulator");
  const count = final.control_steps;
  if (!Number.isSafeInteger(count) || !finite(count) || count < 0)
    throw new Error("invalid EFE control step count");
  const actions = input.actions;
  if (
    actions &&
    (actions.length !== count || actions.some((row) => row.length !== 4 || !row.every(finite)))
  )
    throw new Error("EFE recorded actions do not match the final control step count");
  const calls = events.filter(
    (e) => (e.ev === "submit" || e.ev === "observe") && finite(e.control_steps),
  );
  let previous = 0;
  for (const call of calls) {
    const step = call.control_steps as number;
    if (!Number.isSafeInteger(step) || step < previous || step > count || !finite(call.ts))
      throw new Error("invalid EFE journal call ordering");
    previous = step;
  }
  const dt = 0.0125;
  const stride = Math.max(1, Math.ceil(count / 3000));
  const steps = new Set([0, count]);
  for (let step = stride; step < count; step += stride) steps.add(step);
  for (const call of calls) steps.add(call.control_steps as number);
  if (steps.size > 10_000) throw new Error("EFE trajectory has too many call boundaries");
  const messageTimes = input.messages.map((m) => (m.at ? Date.parse(m.at) / 1000 : Number.NaN));
  const refs = new Map<number, number[]>();
  let lastTime = -Infinity;
  for (const call of calls) {
    const indexes = messageTimes.flatMap((time, i) =>
      time > lastTime && time <= (call.ts as number) ? [i] : [],
    );
    const step = call.control_steps as number;
    refs.set(step, [...(refs.get(step) ?? []), ...indexes].slice(-200));
    lastTime = call.ts as number;
  }
  const tail = messageTimes.flatMap((time, i) => (time > lastTime ? [i] : []));
  refs.set(count, [...(refs.get(count) ?? []), ...tail].slice(-200));
  const ended = final.finalized === true;
  const truncated =
    !ended ||
    Boolean(final.finalize_error) ||
    final.infra_error === true ||
    final.infra_error === 1 ||
    ["step limit", "time limit", "timeout", "error"].includes(String(final.reason));
  const samples = [...steps]
    .sort((a, b) => a - b)
    .map((step) => ({
      time: step * dt,
      action: actions && step > 0 ? (actions[step - 1] ?? []) : actions ? [0, 0, 0, 0] : [],
      proprio: [],
      reward: step === count && finite(final.final_reward) ? final.final_reward : null,
      terminated: step === count && ended && !truncated,
      truncated: step === count && truncated,
      ...(refs.has(step) ? { sessionMessageIndexes: refs.get(step) } : {}),
    }));
  previous = 0;
  const chunks = calls.flatMap((call) => {
    const start = previous * dt;
    previous = call.control_steps as number;
    return call.ev === "submit" ? [{ start, end: previous * dt, label: `Call ${call.call}` }] : [];
  });
  const every = Math.max(2, Math.floor(count / 600));
  const renderedSteps = [0];
  for (let step = every; step < count; step += every) renderedSteps.push(step);
  if (count > 0) renderedSteps.push(count);
  const cameras: EpisodeTrajectory["cameras"] = input.video
    ? [
        {
          name: "front",
          source: "render",
          video: {
            path: input.video,
            timeMap: renderedSteps.map((step, index) => ({
              time: step * dt,
              videoTime: index / 25,
            })),
          },
        },
      ]
    : input.lastFrame
      ? [{ name: "front", source: "render", frames: [{ time: count * dt, path: input.lastFrame }] }]
      : [];
  return EpisodeTrajectory.parse({
    version: 1,
    kind: "episode",
    goal: input.goal,
    actionNames: actions ? ["dx", "dy", "dz", "grip"] : [],
    proprioNames: [],
    cameras,
    samples,
    chunks,
    producer: "sidecar",
    trust: "trusted",
    completeness:
      !ended || !actions || input.messages.length >= 5000 || input.messages.some((m) => m.truncated)
        ? "truncated"
        : input.messages.length
          ? "complete"
          : "environment-only",
  });
}

/** Only the stored, little-endian float64 matrix written by numpy.savez is accepted. */
export function efeActions(npz: Buffer): number[][] {
  const end = npz.length - 22;
  if (end < 0 || npz.readUInt32LE(end) !== 0x06054b50 || npz.readUInt16LE(end + 20) !== 0)
    throw new Error("unsupported EFE NumPy archive");
  let offset = npz.readUInt32LE(end + 16);
  const entries = npz.readUInt16LE(end + 10);
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || npz.readUInt32LE(offset) !== 0x02014b50) break;
    const length = npz.readUInt16LE(offset + 28);
    const name = npz.subarray(offset + 46, offset + 46 + length).toString();
    if (name === "actions.npy") {
      if (npz.readUInt16LE(offset + 10) !== 0)
        throw new Error("compressed EFE actions are unsupported");
      const size = npz.readUInt32LE(offset + 24);
      const local = npz.readUInt32LE(offset + 42);
      if (local + 30 > offset || npz.readUInt32LE(local) !== 0x04034b50) break;
      const start = local + 30 + npz.readUInt16LE(local + 26) + npz.readUInt16LE(local + 28);
      if (start + size > offset || size > 64 * 1024 * 1024) break;
      const npy = npz.subarray(start, start + size);
      if (npy.length < 10 || npy.subarray(0, 6).toString("hex") !== "934e554d5059" || npy[6] !== 1)
        throw new Error("unsupported EFE NumPy array");
      const data = 10 + npy.readUInt16LE(8);
      const header = npy.subarray(10, data).toString();
      const shape = /'shape':\s*\((\d+),\s*4\s*,?\)/.exec(header);
      if (!shape || !/'descr':\s*'<f8'/.test(header) || !/'fortran_order':\s*False/.test(header))
        throw new Error("EFE actions must be a float64 matrix with four columns");
      const rows = Number(shape[1]);
      if (data + rows * 32 !== npy.length) throw new Error("truncated EFE actions");
      return Array.from({ length: rows }, (_, row) =>
        Array.from({ length: 4 }, (_, col) => npy.readDoubleLE(data + row * 32 + col * 8)),
      );
    }
    offset += 46 + length + npz.readUInt16LE(offset + 30) + npz.readUInt16LE(offset + 32);
  }
  throw new Error("EFE archive has no readable actions");
}
