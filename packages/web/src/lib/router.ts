// Minimal history router: all view state lives in the URL (path + query + hash) so every view is
// shareable and survives reloads.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
window.addEventListener("popstate", notify);

/** `decodeURIComponent` that returns the input unchanged for a malformed escape. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const cur = location.pathname + location.search + location.hash;
  if (to === cur) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => location.pathname + location.search + location.hash;

export interface Location {
  path: string;
  query: URLSearchParams;
  hash: string;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(subscribe, snapshot);
  const u = new URL(href, location.origin);
  return { path: u.pathname, query: u.searchParams, hash: u.hash.slice(1) };
}

/** Update query params in place (null deletes) and keep the path. */
export function setQuery(
  patch: Record<string, string | null>,
  opts: { replace?: boolean; hash?: string } = {},
) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  const hash = opts.hash === undefined ? location.hash : opts.hash ? `#${opts.hash}` : "";
  navigate(`${location.pathname}${s ? `?${s}` : ""}${hash}`, { replace: opts.replace ?? true });
}

export function setHash(hash: string) {
  navigate(`${location.pathname}${location.search}${hash ? `#${hash}` : ""}`, { replace: true });
}

/** Intercepts plain left clicks on internal links. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  const a = e.currentTarget;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  if (a.target || a.origin !== location.origin || a.hasAttribute("download")) return;
  e.preventDefault();
  navigate(a.pathname + a.search + a.hash);
}

/** Preserve saved views when moving the old home and Catalog into their own pages. */
export function legacyHref(path: string, query: URLSearchParams, hash = ""): string | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  const q = new URLSearchParams(query);
  let destination = normalized;
  if (normalized === "/bench" && q.get("tab") === "catalog") {
    destination = "/benchmarks";
    q.delete("tab");
    const evidence: Record<string, string> = {
      passed: "calibrated",
      failed: "failed",
      none: "uncalibrated",
      running: "running",
      real: "no-real",
    };
    const cal = q.get("cal");
    if (cal && evidence[cal] && !q.has("ev")) q.set("ev", evidence[cal]);
    q.delete("cal");
  } else if (normalized === "/" && ["q", "state", "flat", "folder", "kind"].some((k) => q.has(k))) {
    destination = "/runs";
  }
  if (destination === path) return null;
  return `${destination}${q.size ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
}
