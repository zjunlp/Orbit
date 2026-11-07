// `orbit bench calibrate`: ask the daemon for a calibration job (design §9.15) and wait for its
// report. The daemon samples tasks, runs the calibration methods, rescores from saved evidence and
// judges the job; the CLI only prints the report it reads back.
import type { OrbitClient } from "../client/index.ts";
import {
  type CalibrationReport,
  CalibrationRequest,
  type CalibrationRequestInput,
} from "../contracts/index.ts";

type WithoutBenchmark<T> = T extends unknown ? Omit<T, "benchmark"> : never;
export type CalibrateOptions = WithoutBenchmark<CalibrationRequestInput> & {
  waitMin: number;
  progress?: (text: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function calibrate(
  c: OrbitClient,
  benchmark: string,
  { waitMin, progress, ...request }: CalibrateOptions,
): Promise<CalibrationReport> {
  const job = await c.benchCalibrate(CalibrationRequest.parse({ benchmark, ...request }));
  const deadline = Date.now() + waitMin * 60_000;
  let phase = "";
  for (;;) {
    const r = (await c.benchJob(job.id)).calibration;
    if (!r) throw new Error(`job ${job.id} is not a calibration job`);
    const stage = r.phase !== "done" && r.budget?.executionEndedAt ? "cleanup" : r.phase;
    if (stage !== phase) {
      phase = stage;
      progress?.(
        phase === "running"
          ? r.mode === "policy"
            ? `job ${job.id}: ${r.samples} frozen episode(s), policy ${r.policyRef}, ${r.budget?.minutes} minute total budget`
            : `job ${job.id}: ${r.tasks.length} task(s) × ${r.methods.join(", ")} × ${r.seeds} seed(s)`
          : phase === "cleanup"
            ? "execution finished; waiting for resource cleanup"
            : phase === "rescoring"
              ? "rescoring from saved evidence"
              : "",
      );
    }
    if (r.phase === "done") return r;
    if (Date.now() > deadline) throw new Error(`calibration job ${job.id} did not finish in time`);
    await sleep(3000);
  }
}
