import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { visiblePolling } from "./polling.ts";

export interface Async<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount and whenever `deps` change; optionally poll every `pollMs` while `poll` is true.
 * The next poll is scheduled only after the current request settles, so a response slower than
 * the interval is still applied. `resetKey` hides old data immediately on resource changes.
 * Reload, dependency changes and unmount abort the previous request; late responses stay ignored.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number; poll?: boolean; resetKey?: unknown } = {},
): Async<T> {
  const [result, setResult] = useState<{ key: unknown; data?: T; error: string | null }>({
    key: opts.resetKey,
    error: null,
  });
  const request = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const reload = useCallback(() => {
    request.current?.abort();
    setTick((t) => t + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller controls deps
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    request.current = controller;
    const key = opts.resetKey;
    const polling = visiblePolling(reload, () => optsRef.current);
    setLoading(true);
    const load = fnRef.current;
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      })
      .then(
        (data) => {
          if (!live || controller.signal.aborted) return;
          setResult({ key, data, error: null });
          setLoading(false);
          polling.settled();
        },
        (e: Error) => {
          if (!live || controller.signal.aborted) return;
          if (e.name !== "AbortError")
            setResult((previous) => ({
              key,
              data: Object.is(previous.key, key) ? previous.data : undefined,
              error: e.message,
            }));
          setLoading(false);
          polling.settled();
        },
      );
    return () => {
      live = false;
      controller.abort();
      polling.dispose();
    };
  }, [...deps, tick, opts.resetKey]);

  // Polling switched on (or its interval changed) after the last request settled: restart it.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reacts to the poll options
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (opts.poll && opts.pollMs && document.visibilityState !== "hidden") reload();
  }, [opts.poll, opts.pollMs]);

  const current = Object.is(result.key, opts.resetKey);
  return {
    data: current ? result.data : undefined,
    error: current ? result.error : null,
    loading: !current || loading,
    reload,
  };
}

const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}
