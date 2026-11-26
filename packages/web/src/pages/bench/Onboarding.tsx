import type { BenchInitRequest, BenchInitResult } from "@zjunlp/orbit/contracts";
import { useEffect, useRef, useState } from "react";
import { CopyButton, Link } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import "./onboarding.css";

export function onboardingError(name: string, directory: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))
    return "Use a name of 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.";
  if (
    !directory.startsWith("/") ||
    directory.length > 4096 ||
    directory.includes("\0") ||
    directory === "/"
  )
    return "Enter a new absolute directory on the daemon machine, such as /home/me/tutorial.";
  return null;
}

export const tutorialFiles = (template: BenchInitRequest["template"]) => [
  "runtime.py",
  "grader.py",
  "resources.json",
  "benchmark.json",
  "README.md",
  ...(template === "adapter" ? ["adapter.py"] : ["orbit-bench.yaml", "manifest-runtime.py"]),
];

export function OnboardingView() {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [template, setTemplate] = useState<BenchInitRequest["template"]>("adapter");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BenchInitResult | null>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (result) successHeading.current?.focus();
  }, [result]);
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const problem = onboardingError(name, directory);
    if (problem) {
      setError(problem);
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const created = await api.benchInit({ name, directory, template });
      if (mounted.current) setResult(created);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="onboarding-page">
      <header>
        <div className="library-eyebrow">BENCHMARK ONBOARDING</div>
        <h1>Add your own benchmark</h1>
        <p>
          First check the <Link href="/benchmarks">benchmark library</Link> or{" "}
          <Link href="/benchmarks?mode=resources">prepare a supported benchmark</Link>. For a new
          integration, start with a small CPU tutorial.
        </p>
      </header>
      <section aria-label="Integration routes" className="onboarding-routes">
        <div>
          <strong>Harbor</strong>
          <p>Register existing task.toml task directories.</p>
        </div>
        <div>
          <strong>Manifest</strong>
          <p>Describe a trusted native runner and its result files in YAML.</p>
        </div>
        <div>
          <strong>SDK</strong>
          <p>Write an adapter for custom tools or interaction.</p>
        </div>
        <div>
          <strong>Native</strong>
          <p>Keep the original runner and wrap its protocol.</p>
        </div>
      </section>
      {!result ? (
        <form onSubmit={create} className="onboarding-form">
          <h2>Create a synthetic tutorial</h2>
          <p>
            This fixture teaches integration. Tutorial calibration is not real benchmark validation.
          </p>
          <fieldset disabled={pending}>
            <label>
              Template
              <select
                aria-label="Template"
                className="input"
                value={template}
                onChange={(e) => setTemplate(e.target.value as BenchInitRequest["template"])}
              >
                <option value="adapter">Adapter — independent grader</option>
                <option value="manifest">Manifest — runner-owned results</option>
              </select>
            </label>
            <label>
              Benchmark name
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                autoComplete="off"
                required
              />
            </label>
            <label>
              New directory on the daemon machine
              <input
                className="input"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/home/me/benchmark-tutorial"
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
                required
                aria-describedby="onboarding-directory-help"
              />
            </label>
            <p id="onboarding-directory-help">
              The parent directory must exist. The target must be new, outside Orbit home and data
              directories, with no symlink ancestors. Existing files are never overwritten.
            </p>
          </fieldset>
          <section aria-label="Creation preview" className="onboarding-preview">
            <h3>Files to create</h3>
            <ul>
              {tutorialFiles(template).map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
            <p>
              {template === "adapter"
                ? "Solve and verify use separate containers. Only verify receives the private grader; Agent solve receives the task instruction."
                : "Only empty/oracle controls are supported. A trusted runner writes scores; manifest verification checks result evidence and does not rerun the grader. Do not let a model write its own score."}
            </p>
            <p>
              Creation only writes these tutorial files. It does not register, download, start runs
              or calibrate.
            </p>
          </section>
          {error && (
            <div className="callout" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? "Creating tutorial…" : "Create tutorial"}
          </button>
          {pending && (
            <p role="status">
              Writing files on the daemon machine. Leaving this page does not cancel a submitted
              request.
            </p>
          )}
        </form>
      ) : (
        <section className="onboarding-result" aria-label="Tutorial created">
          <h2 ref={successHeading} tabIndex={-1}>
            Tutorial created
          </h2>
          <p>
            Files were created. Nothing has been registered or started. This is a synthetic
            tutorial, not real benchmark validation.
          </p>
          <div className="onboarding-copy">
            <code>{result.directory}</code>
            <CopyButton text={result.directory} label="Copy directory" />
          </div>
          <h3>Created files</h3>
          <ul>
            {result.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <h3>Next steps to run yourself</h3>
          <p>
            Review the generated README, then register and calibrate when ready. Calibration
            requires Docker and the tutorial image.
          </p>
          {result.nextSteps.map((command) => (
            <div className="onboarding-copy" key={command}>
              <code>{command}</code>
              <CopyButton text={command} label="Copy command" />
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setResult(null);
              setDirectory("");
            }}
          >
            Create another tutorial
          </button>
        </section>
      )}
    </div>
  );
}
