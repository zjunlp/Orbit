import { Component, useEffect, useState, useSyncExternalStore } from "react";
import { IconKeyboard, IconLogo, IconMoon, IconSidebar, IconSun } from "./components/icons.tsx";
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
import {
  matchRoute,
  PAGES,
  type PageDef,
  pageShortcuts,
  type RouteName,
  railActive,
} from "./routes.ts";

/** The component of every route; `params` are the decoded path parameters. */
const VIEWS: Record<RouteName, (params: string[]) => React.ReactNode> = {
  overview: () => <Overview />,
  benchmarks: () => <BenchmarksPage />,
  agents: () => <AgentsPage />,
  configurations: () => <ConfigurationsPage />,
  bench: () => <BenchJobs />,
  runs: () => <Runs />,
  compare: () => <Compare />,
  resources: () => <Resources />,
  settings: () => <Settings />,
  run: ([id]) => <RunDetail key={id} id={id as string} />,
  trial: ([job, trial]) => (
    <TrialPage key={trial} jobId={job as string} trialId={trial as string} />
  ),
  benchCompare: () => <BenchComparePage />,
  benchNew: () => <NewBenchJob />,
  benchJob: ([id]) => <BenchJobDetail key={id} id={id as string} />,
};

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
  const [railTip, setRailTip] = useState<{ text: string; top: number; left: number } | null>(null);
  // Names show beside the item when the rail is an icon bar, and always for the footer tools.
  const showRailTip = (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
    if (!(e.target instanceof Element)) return;
    const item = e.target.closest("a, button, .rail-status");
    const iconOnly =
      e.currentTarget.getBoundingClientRect().width <= 60 || item?.closest(".rail-tools");
    const text = item?.querySelector(".tip")?.textContent;
    if (!item || !text || !iconOnly) return;
    const rect = item.getBoundingClientRect();
    setRailTip({ text, top: rect.top + rect.height / 2, left: rect.right + 8 });
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
    ...Object.fromEntries(PAGES.map((p) => [`g ${p.key}`, () => navigate(p.path)])),
    Escape: () => {
      setHelp(false);
      setPalette(false);
    },
  });

  const redirect = legacyHref(loc.path, loc.query, loc.hash);
  const route = matchRoute(loc.path);
  const page = redirect ? (
    <Redirect to={redirect} />
  ) : route ? (
    VIEWS[route.name](route.params.map(safeDecode))
  ) : (
    <NotFound path={loc.path} />
  );

  const nav = (p: PageDef) => (
    <Link
      key={p.name}
      href={p.path}
      className={railActive(p, loc.path) ? "active" : ""}
      aria-label={p.label}
    >
      <p.icon />
      <span className="label">{p.label}</span>
      <span className="tip">
        {p.label} <span className="faint">g {p.key}</span>
      </span>
    </Link>
  );
  const rail = (group: PageDef["rail"]) => PAGES.filter((p: PageDef) => p.rail === group).map(nav);

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
        {rail("top")}
        <div className="rail-group">Evaluate</div>
        {rail("Evaluate")}
        <div className="rail-group">Operate</div>
        {rail("Operate")}
        <div className="spacer" />
        <div className="rail-footer">
          {rail("bottom")}
          <div className="rail-tools">
            <div className="rail-status" role="status" aria-label="Daemon connection">
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
              <span className="label">
                {connected ? "Live" : loaded ? "Offline" : "Connecting"}
              </span>
              <span className="tip">
                {connected ? "Live — connected to daemon" : "Disconnected — retrying"}
              </span>
            </div>
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
            <button
              type="button"
              onClick={toggleRail}
              className="rail-toggle"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
            >
              <IconSidebar />
              <span className="tip">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
            </button>
          </div>
        </div>
      </nav>
      {railTip && (
        <span
          className="rail-tooltip"
          role="tooltip"
          style={{ top: railTip.top, left: railTip.left }}
        >
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
  ...pageShortcuts(),
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

function NotFound({ path }: { path: string }) {
  return (
    <Empty title="Page not found">
      <p>
        Nothing lives at <code>{path}</code>.
      </p>
      <p>
        <Link href="/">Go to Overview →</Link>
      </p>
    </Empty>
  );
}

/** Old addresses keep working: replace the location instead of rendering a page. */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
