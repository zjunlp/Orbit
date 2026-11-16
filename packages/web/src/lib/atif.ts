import type { AtifStep, AtifTrajectory } from "@zjunlp/orbit/contracts";

export function trajectoryTree(root: AtifTrajectory) {
  const rows: { path: string; trace: AtifTrajectory; depth: number }[] = [];
  const visit = (trace: AtifTrajectory, path: string, depth: number): void => {
    rows.push({ path, trace, depth });
    trace.subagent_trajectories?.forEach((child, i) => {
      visit(child, path ? `${path}/${i}` : `${i}`, depth + 1);
    });
  };
  visit(root, "", 0);
  return rows;
}

export const atifText = (content: AtifStep["message"] | null | undefined): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");

export function trajectoryMediaUrl(run: string, path: string): string | null {
  if (!/^media\/[a-f0-9]{64}\.(png|jpg|gif|webp|wav|mp3|m4a|aac|ogg|flac|weba|aiff)$/.test(path))
    return null;
  return `/api/v1/runs/${encodeURIComponent(run)}/trajectory/files/${path}`;
}

/** Timestamp gaps are not model or tool execution durations. */
export function stepInterval(step: AtifStep, next?: AtifStep): number | null {
  if (!step.timestamp || !next?.timestamp) return null;
  const gap = Date.parse(next.timestamp) - Date.parse(step.timestamp);
  return Number.isFinite(gap) && gap >= 0 ? gap / 1000 : null;
}

export interface ReplayControl {
  index: number;
  select: (index: number) => void;
}

export function linkedRecords(rows: { sessionStepIds?: number[] }[], step: number) {
  return rows.flatMap((row, i) => (row.sessionStepIds?.includes(step) ? [i] : []));
}
