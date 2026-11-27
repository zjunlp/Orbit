import type { PreparationRecipe, PreparationStatus } from "@zjunlp/orbit/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import "./preparation.css";

export function PreparationView() {
  const { query } = useLocation();
  const catalog = useAsync(() => api.benchResources(), []);
  const family = query.get("family") ?? "";
  const recipe = catalog.data?.recipes.find((r) => r.id === family);
  if (!catalog.data)
    return catalog.error ? (
      <div className="callout" role="alert">
        {catalog.error}
      </div>
    ) : (
      <Loading what="Loading benchmark resources" />
    );
  return (
    <div className="preparation-page">
      <header>
        <div className="library-eyebrow">BENCHMARK RESOURCES</div>
        <h1>Prepare a benchmark</h1>
        <p>
          Download from official sources, reuse files you already have, and register a local setup.
        </p>
      </header>
      <label className="preparation-field">
        Benchmark
        <select
          className="input"
          value={family}
          onChange={(e) => setQuery({ family: e.target.value || null, preparation: null })}
        >
          <option value="">Choose from {catalog.data.recipes.length} supported benchmarks</option>
          {[...catalog.data.recipes]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      {recipe && (
        <PreparationForm
          key={recipe.id}
          recipe={recipe}
          directory={`${catalog.data.directory}/${recipe.id}`}
        />
      )}
    </div>
  );
}

export function PreparationForm({
  recipe,
  directory,
}: {
  recipe: PreparationRecipe;
  directory: string;
}) {
  const { query } = useLocation();
  const [reuse, setReuse] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [authorized, setAuthorized] = useState<string[]>([]);
  const [destination, setDestination] = useState(directory);
  const [name, setName] = useState("");
  const [registrationFile, setRegistrationFile] = useState("");
  const [proxy, setProxy] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = query.get("preparation");
  const [poll, setPoll] = useState(true);
  const loaded = useRef<string | null>(null);
  const status = useAsync(
    () => (runId ? api.benchPreparation(runId) : Promise.resolve(null)),
    [runId],
    { poll: Boolean(runId) && poll, pollMs: 3000 },
  );
  const current =
    status.data?.run.id === runId && status.data.family === recipe.id ? status.data : null;
  const active = Boolean(runId) && (!current || current.state === "running");
  useEffect(() => {
    setPoll(Boolean(runId));
  }, [runId]);
  useEffect(() => {
    if (!current) return;
    if (current.state !== "running") setPoll(false);
    if (loaded.current === current.run.id) return;
    loaded.current = current.run.id;
    const input = current.input;
    if (!input) return;
    setReuse(input.reuse ?? {});
    setValues(input.values ?? {});
    setAuthorized(input.authorized ?? []);
    setDestination(input.directory ?? directory);
    setName(input.name ?? "");
    setRegistrationFile(input.registrationFile ?? "");
    setProxy(input.proxy ?? "");
    setTokenEnv(input.tokenEnv ?? "");
  }, [current, directory]);
  const nonempty = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value.trim()));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.benchPrepare(recipe.id, {
        directory: destination,
        name: name || undefined,
        reuse: nonempty(reuse),
        values: nonempty(values),
        authorized,
        registrationFile: registrationFile || undefined,
        proxy: proxy || undefined,
        tokenEnv: tokenEnv || undefined,
      });
      setQuery({ preparation: run.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="preparation-intro">
        <h2>{recipe.name}</h2>
        <p>{recipe.description}</p>
        <a href={recipe.guide} target="_blank" rel="noreferrer">
          Preparation guide ↗
        </a>
        <p className="muted">
          Paths refer to the machine running Orbit. Existing files are checked and reused in place.
        </p>
        {recipe.steps.length > 0 && (
          <ol>
            {[...new Set(recipe.steps)].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </div>
      <section aria-label="Official resources" className="preparation-resources">
        {recipe.resources.map((resource) => (
          <article key={resource.id} className="preparation-resource">
            <div className="preparation-resource-title">
              <h3>{resource.label}</h3>
              <span className="chip">
                {resource.access === "authorization"
                  ? "Access required"
                  : resource.kind === "manual"
                    ? "Follow official setup"
                    : "Official download"}
              </span>
            </div>
            <a href={resource.url} target="_blank" rel="noreferrer">
              View official source ↗
            </a>
            {resource.revision && (
              <p className="muted">
                Version: <code>{resource.revision}</code>
              </p>
            )}
            <p>{resource.instructions}</p>
            {resource.access === "authorization" && (
              <div className="preparation-access">
                <a
                  href={resource.authorizationUrl ?? resource.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open access / license instructions ↗
                </a>
                {resource.kind !== "manual" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={authorized.includes(resource.id)}
                      onChange={(e) =>
                        setAuthorized(
                          e.target.checked
                            ? [...authorized, resource.id]
                            : authorized.filter((id) => id !== resource.id),
                        )
                      }
                    />{" "}
                    I have completed the official access requirements
                  </label>
                )}
              </div>
            )}
            <label className="preparation-field">
              {resource.kind === "manual"
                ? "Prepared local path"
                : "Reuse an existing local path (optional)"}
              <input
                className="input"
                value={reuse[resource.id] ?? ""}
                placeholder="/absolute/path"
                onChange={(e) => setReuse({ ...reuse, [resource.id]: e.target.value })}
              />
            </label>
          </article>
        ))}
      </section>
      {recipe.fields.length > 0 && (
        <section className="preparation-settings" aria-label="Preparation inputs">
          <h3>Environment and preparation inputs</h3>
          <p>
            Missing inputs appear as next steps. Public downloads can finish while you prepare these
            prerequisites.
          </p>
          {recipe.fields.map((field) => (
            <label className="preparation-field" key={field.id}>
              {field.label}
              <input
                className="input"
                value={values[field.id] ?? field.default ?? ""}
                placeholder={
                  field.kind === "path"
                    ? "/absolute/path"
                    : field.kind === "image"
                      ? "Image name or digest"
                      : "Value"
                }
                onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}
              />
              <span className="muted">{field.help}</span>
            </label>
          ))}
        </section>
      )}
      <label className="preparation-field">
        Download directory
        <input
          className="input"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </label>
      <details className="preparation-settings">
        <summary>Existing registration and download settings</summary>
        <label className="preparation-field">
          Import an existing benchmark JSON definition
          <input
            className="input"
            value={registrationFile}
            placeholder="/absolute/benchmark.json"
            onChange={(e) => setRegistrationFile(e.target.value)}
          />
        </label>
        <label className="preparation-field">
          Registration name (optional)
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="preparation-field">
          Download proxy (optional)
          <input
            className="input"
            value={proxy}
            placeholder="http://127.0.0.1:17890"
            onChange={(e) => setProxy(e.target.value)}
          />
        </label>
        <label className="preparation-field">
          Token environment variable name (optional)
          <input
            className="input"
            value={tokenEnv}
            placeholder="HF_TOKEN"
            onChange={(e) => setTokenEnv(e.target.value)}
          />
          <span className="muted">
            Set this variable in the daemon's environment. Enter its name here, never the token.
          </span>
        </label>
      </details>
      {(error ?? status.error) && (
        <div className="callout" role="alert">
          {error ?? status.error}
        </div>
      )}
      <div className="preparation-actions">
        <button className="btn primary" type="submit" disabled={busy || active}>
          {busy ? "Starting…" : runId ? "Continue preparation" : "Download, prepare and register"}
        </button>
        {active && runId && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              void api
                .cancel(runId)
                .then(status.reload)
                .catch((e: Error) => setError(e.message));
            }}
          >
            Cancel preparation
          </button>
        )}
      </div>
      {current && <PreparationResult status={current} />}
    </form>
  );
}

export function PreparationResult({ status }: { status: PreparationStatus }) {
  const labels = {
    running: "Preparing resources",
    needs_input: "Action needed",
    registered: "Registered",
    failed: "Preparation failed",
    cancelled: "Preparation cancelled",
  };
  return (
    <section className="preparation-result" aria-live="polite">
      <h3>{labels[status.state]}</h3>
      <Link href={`/runs/${status.run.id}`}>View progress and logs</Link>
      {status.pending.length > 0 && (
        <ul>
          {status.pending.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {status.registrations.map((name) => (
        <p key={name}>
          <strong>{name}</strong>{" "}
          <Link
            className="btn sm"
            href={`/benchmarks?mode=local&setup=${encodeURIComponent(name)}&open=${encodeURIComponent(name)}&ptab=coverage`}
          >
            View setup and task coverage
          </Link>
        </p>
      ))}
      {status.state === "registered" && (
        <p>
          Registration validates the task listing. Runtime availability and benchmark calibration
          remain separate checks.
        </p>
      )}
      {status.state === "needs_input" && (
        <p>Completed downloads are retained. Fill in the missing inputs above and continue.</p>
      )}
    </section>
  );
}
