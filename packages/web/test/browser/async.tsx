import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../../src/lib/api.ts";
import { readRunFile } from "../../src/lib/run-file.ts";
import { useAsync } from "../../src/lib/use.ts";

function Probe({ id }: { id: string }) {
  const file = new URLSearchParams(location.search).has("file");
  const result = useAsync(
    (signal) =>
      file
        ? readRunFile(id, "probe.txt", "probe", 1024, signal)
        : api.session(id, signal).then(JSON.stringify),
    [id, file],
    { resetKey: id },
  );
  return (
    <>
      <button type="button" onClick={result.reload}>
        Refresh
      </button>
      <output data-testid="value">{result.data ?? "loading"}</output>
      <output data-testid="error">{result.error}</output>
    </>
  );
}
function App() {
  const [id, setId] = useState("probe-A");
  const [shown, setShown] = useState(true);
  return (
    <>
      <p>SYNTHETIC hook regression probe</p>
      <button type="button" onClick={() => setId("probe-A")}>
        Trial A
      </button>
      <button type="button" onClick={() => setId("probe-B")}>
        Trial B
      </button>
      <button type="button" onClick={() => setShown(false)}>
        Leave
      </button>
      {shown && <Probe id={id} />}
    </>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
