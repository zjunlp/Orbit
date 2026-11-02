import { Component, useEffect, useState, useSyncExternalStore } from "react";
import {
  IconChip,
  IconCompare,
  IconFlask,
  IconKeyboard,
  IconLogo,
  IconMoon,
  IconRuns,
  IconSettings,
  IconSun,
} from "./components/icons.tsx";
import { Palette } from "./components/Palette.tsx";
import { Empty, Kbd, Link, Toaster } from "./components/ui.tsx";
import { authState } from "./lib/api.ts";
import { useHotkeys } from "./lib/hotkeys.ts";
import { navigate, safeDecode, useLocation } from "./lib/router.ts";
import { startRunsStore, useRunsState } from "./lib/runs-store.ts";
import { BenchComparePage, BenchJobDetail, BenchJobs, NewBenchJob } from "./pages/Bench.tsx";
import { Compare } from "./pages/Compare.tsx";
import { Resources } from "./pages/Resources.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Settings } from "./pages/Settings.tsx";
import { TrialPage } from "./pages/Trial.tsx";

function useUnauthorized() {
  return useSyncExternalStore(
    (l) => {
      authState.listeners.add(l);
      return () => authState.listeners.delete(l);
    },
    () => authState.unauthorized,
  );
}

function useTheme(): [string, () => void] {
  const [theme, set] = useState(document.documentElement.dataset.theme ?? "dark");
  const toggle = () => {
    const t = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    localStorage.setItem("orbit.theme", t);
    set(t);
  };
  return [theme, toggle];
}

export function App() {
  const loc = useLocation();
  const unauthorized = useUnauthorized();
  const { connected, loaded } = useRunsState();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => startRunsStore(), []);

  useHotkeys({
    "mod+k": () => setPalette(true),
    "?": () => setHelp((h) => !h),
    "g r": () => navigate("/"),
    "g c": () => navigate("/compare"),
    "g b": () => navigate("/bench"),
    "g s": () => navigate("/resources"),
    "g p": () => navigate("/settings"),
    Escape: () => {
      setHelp(false);
      setPalette(false);
    },
  });

  let page: React.ReactNode;
  const m = /^\/runs\/([^/]+)\/?$/.exec(loc.path);
  const bj = /^\/bench\/([^/]+)\/?$/.exec(loc.path);
  const bt = /^\/bench\/([^/]+)\/trials\/([^/]+)\/?$/.exec(loc.path);
  if (m) page = <RunDetail key={m[1]} id={safeDecode(m[1] as string)} />;
  else if (bt)
    page = (
      <TrialPage
        key={bt[2]}
        jobId={safeDecode(bt[1] as string)}
        trialId={safeDecode(bt[2] as string)}
      />
    );
  else if (loc.path === "/bench/compare") page = <BenchComparePage />;
  else if (loc.path === "/bench/new") page = <NewBenchJob />;
  else if (bj) page = <BenchJobDetail key={bj[1]} id={safeDecode(bj[1] as string)} />;
  else if (loc.path === "/bench" || loc.path === "/bench/") page = <BenchJobs />;
  else if (loc.path === "/compare") page = <Compare />;
  else if (loc.path === "/resources") page = <Resources />;
  else if (loc.path === "/settings") page = <Settings />;
  else page = <Runs />;

  const nav = (
    href: string,
    label: string,
    icon: React.ReactNode,
    active: boolean,
    key: string,
  ) => (
    <Link href={href} className={active ? "active" : ""} aria-label={label}>
      {icon}
      <span className="tip">
        {label} <span className="faint">g {key}</span>
      </span>
    </Link>
  );

  if (unauthorized)
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Empty title="Sign in to this Orbit daemon" icon={<IconLogo size={40} />}>
          <p>To sign in, run this command in a terminal on this machine:</p>
          <p>
            <code>orbit web --open</code>
          </p>
          <p>
            To copy a login link instead, run <code>orbit web</code> and open the printed URL.
          </p>
        </Empty>
      </div>
    );

  return (
    <div className="shell">
      <nav className="rail">
        <div className="logo" title="Orbit">
          <IconLogo size={32} />
        </div>
        {nav("/", "Runs", <IconRuns />, loc.path === "/" || loc.path.startsWith("/runs"), "r")}
        {nav("/compare", "Compare", <IconCompare />, loc.path === "/compare", "c")}
        {nav("/bench", "Bench", <IconFlask />, loc.path.startsWith("/bench"), "b")}
        {nav("/resources", "Resources", <IconChip />, loc.path === "/resources", "s")}
        {nav("/settings", "Settings", <IconSettings />, loc.path === "/settings", "p")}
        <div className="spacer" />
        <button type="button" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
          <IconKeyboard />
          <span className="tip">
            Shortcuts <span className="faint">?</span>
          </span>
        </button>
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? <IconSun /> : <IconMoon />}
          <span className="tip">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
        </button>
        <button type="button" aria-label="Daemon connection" style={{ cursor: "default" }}>
          <span
            className={`dot${connected ? " pulse" : ""}`}
            style={
              {
                "--c": connected
                  ? "var(--st-succeeded)"
                  : loaded
                    ? "var(--st-failed)"
                    : "var(--st-queued)",
              } as React.CSSProperties
            }
          />
          <span className="tip">
            {connected ? "Live — connected to daemon" : "Disconnected — retrying"}
          </span>
        </button>
      </nav>
      <main className="main">
        <PageBoundary key={loc.path}>{page}</PageBoundary>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} />}
      {help && <Help onClose={() => setHelp(false)} />}
      <Toaster />
    </div>
  );
}

/** Keeps a render error in one page from blanking the whole UI; navigating away resets it. */
class PageBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Empty title="This page failed to render">
        <p className="mono">{error.message}</p>
        <p>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </p>
      </Empty>
    );
  }
}

const SHORTCUTS: [string, string][] = [
  ["⌘K / Ctrl K", "Command palette: jump to any run or page"],
  ["g r · g c · g b · g s · g p", "Go to Runs · Compare · Bench · Resources · Settings"],
  ["j / k", "Move down / up in lists"],
  ["Enter / o", "Open the selected run"],
  ["x", "Select run (for compare)"],
  ["c", "Compare selected runs"],
  ["/", "Focus search / log filter"],
  ["1 – 7", "Run tabs: Overview, Logs, Metrics, Artifacts, Code, Session, Events"],
  ["n / N", "Next / previous log match"],
  ["e", "Jump to first error in logs"],
  ["f", "Toggle log follow"],
  ["h / l", "Previous / next step in session"],
  ["?", "This help"],
];

// Keys are character offsets in the shortcut text ("g r · g c" repeats tokens).
function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="card-h">Keyboard shortcuts</div>
        <div className="help-grid">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} style={{ display: "contents" }}>
              <span>
                {[...k.matchAll(/\S+/g)].map(({ 0: p, index: at }) =>
                  /^[·/–]$/.test(p) ? (
                    <span key={at} className="faint">
                      {" "}
                      {p}{" "}
                    </span>
                  ) : (
                    <Kbd key={at}>{p}</Kbd>
                  ),
                )}
              </span>
              <span className="muted">{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
