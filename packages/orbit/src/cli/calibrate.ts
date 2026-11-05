// `orbit bench calibrate`: ask the daemon for a calibration job (design §9.15) and wait for its
// report. The daemon samples tasks, runs the calibration methods, rescores from saved evidence and
// judges the job; the CLI only prints the report it reads back.
import type { OrbitClient } from "../client/index.ts";
import type { CalibrationReport, CalibrationRequestInput } from "../contracts/index.ts";

export interface CalibrateOptions extends Omit<CalibrationRequestInput, "benchmark"> {
  waitMin: number;
  progress?: (text: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function calibrate(
  c: OrbitClient,
  benchmark: string,
  { waitMin, progress, ...request }: CalibrateOptions,
): Promise<CalibrationReport> {
  const job = await c.benchCalibrate({ benchmark, ...request });
  const deadline = Date.now() + waitMin * 60_000;
  let phase = "";
  for (;;) {
    const r = (await c.benchJob(job.id)).calibration;
    if (!r) throw new Error(`job ${job.id} is not a calibration job`);
    if (r.phase !== phase) {
      phase = r.phase;
      progress?.(
        phase === "running"
          ? `job ${job.id}: ${r.tasks.length} task(s) × ${r.methods.join(", ")} × ${r.seeds} seed(s)`
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
