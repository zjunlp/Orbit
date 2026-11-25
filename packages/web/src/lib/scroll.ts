import { useEffect, useRef } from "react";

const storageKey = (id: string) => `orbit.scroll:${id}`;

/**
 * Saves the scroll offsets of the mounted views. The router calls this right before it changes
 * the location, while the rows are still in place: once the next page renders, the browser clamps
 * the old container to the top and the position is lost.
 */
export function rememberScroll() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    const key = el.dataset.scrollKey;
    if (key) sessionStorage.setItem(storageKey(key), String(el.scrollTop));
  }
}

/**
 * Restores the offset saved by `rememberScroll`, so coming back from a detail page lands on the
 * row the user was reading instead of the top of the list.
 *
 * Restoring waits for `ready`: a view whose rows are still loading has no scrollable height yet.
 */
export function useScrollRestore<T extends HTMLElement>(id: string, ready: boolean) {
  const ref = useRef<T>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!ready || !el || done.current) return;
    const saved = Number(sessionStorage.getItem(storageKey(id)) ?? "");
    if (!Number.isFinite(saved) || saved <= 0) {
      done.current = true;
      return;
    }
    // Rows can arrive over several frames (store update, then a fetch), so keep applying the
    // offset until the container is tall enough to hold it.
    let frames = 0;
    let frame = 0;
    const apply = () => {
      if (done.current) return;
      el.scrollTop = saved;
      if (el.scrollTop > 0) {
        done.current = true;
        return;
      }
      if (++frames > 60) {
        done.current = true;
        return;
      }
      frame = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [id, ready]);

  return ref;
}
