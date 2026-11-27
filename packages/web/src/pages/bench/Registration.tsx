import type { Benchmark, BenchmarkInput, BenchRegistrationCheck } from "@zjunlp/orbit/contracts";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Link } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { DEFINITION_LIMIT, parseDefinition } from "./registration-input.ts";
import "./registration.css";

export function RegistrationForm({ definition }: { definition?: BenchmarkInput }) {
  const [text, setText] = useState(() => (definition ? JSON.stringify(definition, null, 2) : ""));
  const [review, setReview] = useState<BenchRegistrationCheck | null>(null);
  const [registered, setRegistered] = useState<Benchmark | null>(null);
  const [pending, setPending] = useState<"check" | "file" | "register" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (registered) successHeading.current?.focus();
    else if (review) reviewHeading.current?.focus();
  }, [review, registered]);
  const version = useRef(0);
  const lock = useRef<"check" | "file" | "register" | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, []);
  function invalidate() {
    version.current++;
    setReview(null);
    setError(null);
    lock.current = null;
    setPending(null);
    return version.current;
  }
  async function readFile(file: File | undefined) {
    if (lock.current === "register") return;
    const token = invalidate();
    if (!file) return;
    setText("");
    if (file.size > DEFINITION_LIMIT) {
      setError("Definition JSON must be at most 1 MiB.");
      return;
    }
    lock.current = "file";
    setPending("file");
    try {
      const contents = await file.text();
      if (mounted.current && token === version.current) setText(contents);
    } catch {
      if (mounted.current && token === version.current)
        setError("Could not read this file. Choose it again or paste JSON.");
    } finally {
      if (mounted.current && token === version.current) {
        lock.current = null;
        setPending(null);
      }
    }
  }
  async function check() {
    if (lock.current) return;
    setReview(null);
    setError(null);
    const token = version.current;
    let input: BenchmarkInput;
    try {
      input = parseDefinition(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    lock.current = "check";
    setPending("check");
    try {
      const result = await api.benchRegistrationCheck(input);
      if (mounted.current && token === version.current) setReview(result);
    } catch (cause) {
      if (mounted.current && token === version.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && token === version.current) {
        lock.current = null;
        setPending(null);
      }
    }
  }
  async function register() {
    if (!review || review.existing || lock.current) return;
    lock.current = "register";
    setPending("register");
    setError(null);
    try {
      const result = await api.benchRegister(review.definition);
      if (mounted.current) setRegistered(result);
    } catch (cause) {
      if (mounted.current) {
        setError(
          `${cause instanceof Error ? cause.message : String(cause)} Check the definition again before registering.`,
        );
        setReview(null);
      }
    } finally {
      lock.current = null;
      if (mounted.current) setPending(null);
    }
  }
  if (registered)
    return (
      <section className="registration-result" aria-label="Benchmark registered">
        <h2 ref={successHeading} tabIndex={-1}>
          Local setup registered
        </h2>
        <p>
          <strong>{registered.name}</strong> was registered. No evaluation or calibration was
          started.
        </p>
        <p>Task listing checks do not establish runtime availability or benchmark calibration.</p>
        <div className="registration-actions">
          <Link className="btn primary" href={setupPath(registered.name)}>
            View setup and task coverage
          </Link>
          <Link
            className="btn"
            href={`/bench/new?benchmark=${encodeURIComponent(registered.name)}`}
          >
            Evaluate
          </Link>
        </div>
      </section>
    );
  return (
    <section className="registration-form" aria-label="Import benchmark definition">
      <h2>Import an existing definition</h2>
      <p>
        Upload or paste a benchmark JSON definition (up to 1 MiB). Paths refer to the daemon
        machine, including adapter and resource files.
      </p>
      <p>
        Checking invokes the adapter to enumerate tasks. Only check definitions and adapters you
        trust. Config and env contain non-secret settings; passEnv contains environment variable
        names, never credentials.
      </p>
      <label>
        Definition JSON file
        <input
          type="file"
          accept=".json,application/json"
          disabled={pending === "register"}
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      <label>
        Definition JSON
        <textarea
          className="input mono"
          rows={12}
          value={text}
          spellCheck={false}
          autoComplete="off"
          disabled={pending === "register"}
          onChange={(event) => {
            invalidate();
            setText(event.target.value);
          }}
          placeholder={'{"name":"mine","adapter":"/path/to/adapter.py","path":"/path/to/tasks"}'}
        />
      </label>
      {review && <RegistrationReview review={review} headingRef={reviewHeading} />}
      <div className="registration-actions">
        <button
          type="button"
          className="btn"
          disabled={pending !== null || !text.trim()}
          onClick={() => void check()}
        >
          {pending === "check" ? "Checking definition…" : "Check definition"}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!review || review.existing || pending !== null}
          onClick={() => void register()}
        >
          {pending === "register" ? "Registering…" : "Register local setup"}
        </button>
      </div>
      {pending && (
        <p role="status">
          {pending === "file"
            ? "Reading the selected JSON file."
            : pending === "check"
              ? "Enumerating tasks on the daemon. Checking does not register or start an evaluation."
              : "Registering the reviewed definition. Leaving this page does not cancel a submitted request."}
        </p>
      )}
      {error && (
        <div className="callout" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

const setupPath = (name: string) =>
  `/benchmarks?mode=local&setup=${encodeURIComponent(name)}&open=${encodeURIComponent(name)}&ptab=coverage`;

function RegistrationReview({
  review,
  headingRef,
}: {
  review: BenchRegistrationCheck;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { definition, coverage } = review;
  return (
    <section className="registration-review" aria-label="Checked definition">
      <h3 ref={headingRef} tabIndex={-1}>
        Checked definition
      </h3>
      {review.existing && (
        <div className="callout" role="alert">
          A setup named {definition.name} already exists. Choose another name and check again.{" "}
          <Link href={setupPath(definition.name)}>View existing setup</Link>
        </div>
      )}
      <dl>
        {Object.entries({
          Name: definition.name,
          Adapter: definition.adapter,
          Path: definition.path,
          Resources: definition.resources ?? "Adapter defaults",
          "Config keys": Object.keys(definition.config ?? {}).join(", ") || "None",
          "Environment variable names": Object.keys(definition.env ?? {}).join(", ") || "None",
          "Pass-through names": definition.passEnv?.join(", ") || "None",
        }).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        <b>
          {coverage.supported} supported / {coverage.total} listed tasks
        </b>
      </p>
      {coverage.supported === 0 && (
        <p>
          0 supported tasks. You can save this setup, but no supported task is available for
          evaluation.
        </p>
      )}
      <details>
        <summary>Suite coverage ({coverage.suites.length})</summary>
        <ul>
          {coverage.suites.map((suite) => (
            <li key={suite.suite}>
              {suite.suite}: {suite.supported} supported / {suite.total} listed
            </li>
          ))}
        </ul>
      </details>
      {coverage.reasons.length > 0 && (
        <details>
          <summary>Unsupported reasons ({coverage.reasons.length})</summary>
          <ul>
            {coverage.reasons.map((reason) => (
              <li key={reason.reason}>
                {reason.reason}: {reason.tasks} tasks
                {reason.suites.length ? ` · ${reason.suites.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p>Declared methods: {review.capabilities?.methods?.join(", ") || "Not declared"}</p>
      <p>
        Declared metrics: {review.metrics.map((metric) => metric.name).join(", ") || "Not declared"}
      </p>
      <p>
        Review these facts, then register explicitly. Task support is declared by the adapter;
        runtime checks and calibration remain separate.
      </p>
    </section>
  );
}
