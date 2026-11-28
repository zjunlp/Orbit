import type { CompatibilityCell } from "@zjunlp/orbit/contracts";
import { Link } from "../../components/ui.tsx";
import { isCliAgent, type MethodDraft } from "./new-job.ts";
import "./compatibility-status.css";

export function CompatibilityStatus({
  draft,
  cell,
  loading,
  error,
  blocker,
  registryNotice,
}: {
  draft: MethodDraft;
  cell?: CompatibilityCell;
  loading: boolean;
  error: string | null;
  blocker: string | null;
  registryNotice?: string;
}) {
  const cli = isCliAgent(draft.agent);
  let message: string;
  if (!cli)
    message =
      draft.agent === "external"
        ? "External policies use an installed entrypoint. CLI Agent compatibility does not apply; environment and policy checks remain necessary."
        : draft.agent === "policy"
          ? "Native policies require a frozen sample plan and a registered policy."
          : "This baseline is a control, not a CLI Agent. Its admission follows the benchmark’s declared methods.";
  else if (blocker) message = `Cannot submit this configuration: ${blocker}`;
  else if (loading)
    message = "Checking current Agent compatibility. No compatibility result is available yet.";
  else if (error)
    message = `Compatibility unavailable: ${error}. Submission still uses the daemon’s checks.`;
  else if (!cell || cell.state === "unknown")
    message = `Compatibility unknown${cell?.reason ? `: ${cell.reason}` : ". No current result for this Agent"}. Submission still uses the daemon’s checks.`;
  else if (cell.state === "needs-auth")
    message = `${cell.reason ?? "The compatibility check found no compatible auth profile"}. Review the selected profile or refresh after updating credentials.`;
  else
    message =
      "Declared configuration checks allow this Agent. Runtime resources, installation and model connectivity are checked separately.";
  return (
    <section
      className={`bench-compatibility${blocker ? " blocked" : ""}`}
      aria-label={`Compatibility for ${draft.name || draft.agent}`}
    >
      <p role={blocker ? "alert" : "status"}>{message}</p>
      {cli && registryNotice && <p>{registryNotice}</p>}
      {cli && (
        <div className="bench-compatibility-links">
          <Link href="/agents">Agent configuration</Link>
          <Link href="/settings">Credential settings</Link>
        </div>
      )}
    </section>
  );
}

export function CompatibilityRefresh({
  loading,
  onRefresh,
}: {
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="bench-compatibility-refresh">
      <button type="button" className="btn sm" disabled={loading} onClick={onRefresh}>
        Refresh configuration checks
      </button>
      <p className="muted">
        Refresh lists tasks on the daemon and reloads Agent definitions and credential profiles.
        Draft configurations are kept.
      </p>
    </div>
  );
}
