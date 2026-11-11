import { useState } from "react";
import { IconBell, IconBot, IconCheck, IconKey, IconLoader, IconX } from "../components/icons.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { CopyButton, Link, toast } from "../components/ui.tsx";
import { type AuthProfile, api, type NotifyTarget } from "../lib/api.ts";
import { browserNotify } from "../lib/browser-notify.ts";
import { ago, harnessLabel, runPath } from "../lib/format.ts";
import { useAsync } from "../lib/use.ts";

// Secrets never reach the Web UI: profiles and targets are added with the CLI (stdin / env vars),
// and listed here with masked hints.
const ADD_PROFILE = [
  "# Claude Code through a relay (reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)",
  "orbit auth add claude --harness claude-code --kind relay --from-env",
  "# Codex with a separate ChatGPT login",
  "orbit auth add codex --harness codex --kind login",
  "# API key from stdin",
  "orbit auth add oa --harness codex --kind api-key --key-stdin < key.txt",
].join("\n");
const ADD_TARGET = "orbit notify add team --kind feishu --url-env FEISHU_HOOK --on failed,group";

export function Settings() {
  const doctor = useAsync(() => api.doctor(), []);
  const profiles = useAsync(() => api.authProfiles(), []);
  const targets = useAsync(() => api.notifyTargets(), []);
  const storage = doctor.data?.checks.filter(
    (c) => c.name === "orbit data" || c.name === "docker data",
  );

  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }]} />
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <PageHeader
            title="Settings"
            description="Storage, credential profiles and notifications of this daemon. Secrets are added from the CLI and never shown here."
          />
          <section className="card">
            <div className="card-h">
              <IconBot size={14} /> Agents
            </div>
            <div className="card-b muted">
              Agents, their capabilities, credentials and evidence are on the{" "}
              <Link href="/agents">Agents</Link> page. Credential profiles are below.
            </div>
          </section>

          {storage && storage.length > 0 && (
            <section className="card">
              <div className="card-h">
                Storage{" "}
                <span className="sub">
                  run data and Docker images; keep them off the system disk
                </span>
              </div>
              <div className="card-b">
                <dl className="kv">
                  {storage.map((c) => (
                    <div key={c.name} style={{ display: "contents" }}>
                      <dt>{c.name}</dt>
                      <dd className="mono" style={{ fontSize: 12 }}>
                        {c.warn && <span className="chip warn">check</span>} {c.detail}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-h">
              <IconKey size={14} /> Auth profiles
              <span className="sub">{profiles.data?.length ?? ""}</span>
            </div>
            {profiles.data && profiles.data.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Agent</th>
                    <th>Kind</th>
                    <th>Secret</th>
                    <th>Details</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {profiles.data.map((p) => (
                    <ProfileRow key={p.name} p={p} onChange={profiles.reload} />
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-b muted">
                {profiles.error ?? (profiles.loading ? "Loading…" : "No profiles yet.")}
              </div>
            )}
            <Hint text={ADD_PROFILE} />
          </section>

          <section className="card">
            <div className="card-h">
              <IconBell size={14} /> Notifications
              <span className="sub">
                single runs by result · groups once when their last run ends
              </span>
            </div>
            <div className="card-b">
              <BrowserToggle />
            </div>
            {targets.data && targets.data.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>On</th>
                    <th>URL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {targets.data.map((t) => (
                    <TargetRow key={t.name} t={t} onChange={targets.reload} />
                  ))}
                </tbody>
              </table>
            )}
            <Hint text={ADD_TARGET} />
          </section>
        </div>
      </div>
    </>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <div className="card-b" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <pre
          className="mono faint"
          style={{ margin: 0, fontSize: 12, flex: 1, whiteSpace: "pre-wrap" }}
        >
          {text}
        </pre>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

type TestState = { busy: boolean; ok?: boolean; runId?: string; detail?: string };

function ProfileRow({ p, onChange }: { p: AuthProfile; onChange: () => void }) {
  const [test, setTest] = useState<TestState>({ busy: false });
  const run = async () => {
    setTest({ busy: true });
    try {
      const r = await api.authTest(p.name);
      setTest({ busy: false, ok: r.ok, runId: r.runId, detail: r.detail });
    } catch (e) {
      setTest({ busy: false, ok: false, detail: (e as Error).message });
    }
  };
  const remove = async () => {
    if (!confirm(`Delete auth profile ${p.name}? Runs that use it will fail to start.`)) return;
    await api.authRemove(p.name).catch((e: Error) => toast(e.message));
    onChange();
  };
  const details = [p.baseUrl, p.model, p.hostNetwork ? "host network" : null].filter(Boolean);
  return (
    <tr>
      <td className="mono">{p.name}</td>
      <td>{harnessLabel(p.harness)}</td>
      <td>
        <span className="chip">{p.kind}</span>
      </td>
      <td className="mono faint">{p.secretHint ?? "—"}</td>
      <td className="faint" style={{ fontSize: 12 }}>
        {details.join(" · ") || "—"}
        {Object.keys(p.env).length > 0 && (
          <div className="mono" title={Object.keys(p.env).join(", ")}>
            +{Object.keys(p.env).length} env
          </div>
        )}
      </td>
      <td className="faint">{ago(p.updatedAt)}</td>
      <td className="r" style={{ whiteSpace: "nowrap" }}>
        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
          {test.busy && (
            <span className="faint row" style={{ gap: 4 }}>
              <IconLoader className="spin" size={13} /> running agent…
            </span>
          )}
          {test.ok !== undefined && !test.busy && (
            <span
              className={`chip ${test.ok ? "good" : "bad"}`}
              title={test.detail}
              style={{ gap: 4 }}
            >
              {test.ok ? <IconCheck size={12} /> : <IconX size={12} />}
              {test.runId ? (
                <Link href={`${runPath(test.runId)}`}>{test.ok ? "ok" : "failed"}</Link>
              ) : (
                "failed"
              )}
            </span>
          )}
          <button type="button" className="btn sm" disabled={test.busy} onClick={run}>
            Test
          </button>
          <button type="button" className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function TargetRow({ t, onChange }: { t: NotifyTarget; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      await api.notifyTest(t.name);
      toast(`Sent a test message to ${t.name}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete notification target ${t.name}?`)) return;
    await api.notifyRemove(t.name).catch((e: Error) => toast(e.message));
    onChange();
  };
  return (
    <tr>
      <td className="mono">{t.name}</td>
      <td>{t.kind}</td>
      <td>
        {t.on.map((e) => (
          <span key={e} className="chip" style={{ marginRight: 4 }}>
            {e}
          </span>
        ))}
      </td>
      <td className="mono faint">{t.urlHint}</td>
      <td className="r">
        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
          <button type="button" className="btn sm" disabled={busy} onClick={test}>
            Send test
          </button>
          <button type="button" className="btn sm ghost danger" onClick={remove}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function BrowserToggle() {
  const [on, setOn] = useState(browserNotify.enabled());
  if (!browserNotify.supported())
    return <span className="faint">This browser does not support desktop notifications.</span>;
  const toggle = async () => {
    if (on) {
      browserNotify.disable();
      setOn(false);
      return;
    }
    const ok = await browserNotify.enable();
    if (!ok) toast("Notifications are blocked for this site in the browser settings");
    setOn(ok);
  };
  return (
    <div className="row" style={{ gap: 10 }}>
      <button type="button" className={`btn sm${on ? " on" : ""}`} onClick={toggle}>
        <IconBell size={13} /> Browser notifications {on ? "on" : "off"}
      </button>
      <span className="faint" style={{ fontSize: 12 }}>
        While this page is open, this browser shows finished runs and groups.
      </span>
    </div>
  );
}
