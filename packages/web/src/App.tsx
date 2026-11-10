import { Component, useEffect, useState, useSyncExternalStore } from "react";
import {
  IconBot,
  IconChip,
  IconDashboard,
  IconFlask,
  IconKeyboard,
  IconLayers,
  IconLibrary,
  IconLogo,
  IconMoon,
  IconRuns,
  IconSettings,
  IconSidebar,
  IconSun,
} from "./components/icons.tsx";
import { Palette } from "./components/Palette.tsx";
import { Empty, Kbd, Link, Toaster } from "./components/ui.tsx";
import { authState } from "./lib/api.ts";
import { useHotkeys } from "./lib/hotkeys.ts";
import { legacyHref, navigate, safeDecode, useLocation } from "./lib/router.ts";
import { startRunsStore, useRunsState } from "./lib/runs-store.ts";
import { AgentsPage } from "./pages/Agents.tsx";
import { BenchComparePage, BenchJobDetail, BenchJobs, NewBenchJob } from "./pages/Bench.tsx";
import { BenchmarksPage } from "./pages/Benchmarks.tsx";
import { Compare } from "./pages/Compare.tsx";
import { ConfigurationsPage } from "./pages/Configurations.tsx";
import { Overview } from "./pages/Overview.tsx";
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
  const [railTip, setRailTip] = useState<{ text: string; top: number } | null>(null);
  const showRailTip = (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
    if (e.currentTarget.getBoundingClientRect().width > 60 || !(e.target instanceof Element))
      return;
    const item = e.target.closest("a, button");
    const text = item?.querySelector(".tip")?.textContent;
    if (!item || !text) return;
    const rect = item.getBoundingClientRect();
    setRailTip({ text, top: rect.top + rect.height / 2 });
  };
  useEffect(() => {
    const hide = () => setRailTip(null);
    window.addEventListener("resize", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);
  const [theme, toggleTheme] = useTheme();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("orbit.rail") === "collapsed",
  );
  const toggleRail = () => {
    localStorage.setItem("orbit.rail", collapsed ? "expanded" : "collapsed");
    setCollapsed(!collapsed);
  };

  useEffect(() => startRunsStore(), []);

  useHotkeys({
    "mod+k": () => setPalette(true),
    "?": () => setHelp((h) => !h),
    "g o": () => navigate("/"),
    "g b": () => navigate("/benchmarks"),
    "g a": () => navigate("/agents"),
    "g m": () => navigate("/configurations"),
    "g e": () => navigate("/bench"),
    "g r": () => navigate("/runs"),
    "g c": () => navigate("/compare"),
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
  const redirect = legacyHref(loc.path, loc.query, loc.hash);
  if (redirect) page = <Redirect to={redirect} />;
  else if (m) page = <RunDetail key={m[1]} id={safeDecode(m[1] as string)} />;
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
  else if (loc.path === "/benchmarks") page = <BenchmarksPage />;
  else if (loc.path === "/agents") page = <AgentsPage />;
  else if (loc.path === "/configurations") page = <ConfigurationsPage />;
  else if (loc.path === "/runs") page = <Runs />;
  else if (loc.path === "/compare") page = <Compare />;
  else if (loc.path === "/resources") page = <Resources />;
  else if (loc.path === "/settings") page = <Settings />;
  else page = <Overview />;

  const nav = (
    href: string,
    label: string,
    icon: React.ReactNode,
    active: boolean,
    key: string,
  ) => (
    <Link href={href} className={active ? "active" : ""} aria-label={label}>
      {icon}
      <span className="label">{label}</span>
      <span className="tip">
        {label} <span className="faint">g {key}</span>
      </span>
    </Link>
  );
  const path = loc.path;
  const runsActive = path === "/runs" || path.startsWith("/runs/") || path === "/compare";
  const evalActive = path === "/bench" || path.startsWith("/bench/");

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
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <nav
        className="rail"
        aria-label="Main"
        onMouseOver={showRailTip}
        onFocus={showRailTip}
        onMouseLeave={() => setRailTip(null)}
        onBlur={() => setRailTip(null)}
        onClick={() => setRailTip(null)}
      >
        <div className="logo" title="Orbit">
          <IconLogo size={28} />
          <span className="label brand">Orbit</span>
        </div>
        {nav("/", "Overview", <IconDashboard />, path === "/", "o")}
        <div className="rail-group">Evaluate</div>
        {nav("/benchmarks", "Benchmarks", <IconLibrary />, path === "/benchmarks", "b")}
        {nav("/agents", "Agents", <IconBot />, path === "/agents", "a")}
        {nav("/configurations", "Configurations", <IconLayers />, path === "/configurations", "m")}
        {nav("/bench", "Evaluations", <IconFlask />, evalActive, "e")}
        <div className="rail-group">Operate</div>
        {nav("/runs", "Runs", <IconRuns />, runsActive, "r")}
        {nav("/resources", "Resources", <IconChip />, path === "/resources", "s")}
        <div className="spacer" />
        {nav("/settings", "Settings", <IconSettings />, path === "/settings", "p")}
        <button type="button" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
          <IconKeyboard />
          <span className="label">Shortcuts</span>
          <span className="tip">
            Shortcuts <span className="faint">?</span>
          </span>
        </button>
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? <IconSun /> : <IconMoon />}
          <span className="label">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
          <span className="tip">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
        </button>
        <button
          type="button"
          onClick={toggleRail}
          className="rail-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <IconSidebar />
          <span className="label">Collapse</span>
          <span className="tip">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
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
          <span className="label">{connected ? "Connected" : "Disconnected"}</span>
          <span className="tip">
            {connected ? "Live — connected to daemon" : "Disconnected — retrying"}
          </span>
        </button>
      </nav>
      {railTip && (
        <span className="rail-tooltip" role="tooltip" style={{ top: railTip.top }}>
          {railTip.text}
        </span>
      )}
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
  [
    "g o · g b · g a · g m · g e",
    "Go to Overview · Benchmarks · Agents · Configurations · Evaluations",
  ],
  ["g r · g c · g s · g p", "Go to Runs · Compare · Resources · Settings"],
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

/** Old addresses keep working: replace the location instead of rendering a page. */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
