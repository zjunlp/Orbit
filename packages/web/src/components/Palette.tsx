import { useEffect, useMemo, useRef, useState } from "react";
import { runPath, runTitle } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { useRuns } from "../lib/runs-store.ts";
import {
  IconBot,
  IconBranch,
  IconChip,
  IconCompare,
  IconDashboard,
  IconFlask,
  IconLayers,
  IconLibrary,
  IconRuns,
  IconSettings,
} from "./icons.tsx";
import { StateIcon } from "./ui.tsx";

interface Item {
  key: string;
  group: string;
  label: React.ReactNode;
  hint?: string;
  icon: React.ReactNode;
  text: string;
  go: string;
}

export function Palette({ onClose }: { onClose: () => void }) {
  const runs = useRuns();
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);

  const items = useMemo(() => {
    const pages: Item[] = [
      {
        key: "p-home",
        group: "Pages",
        label: "Overview",
        icon: <IconDashboard size={15} />,
        text: "overview home",
        go: "/",
      },
      {
        key: "p-benchmarks",
        group: "Pages",
        label: "Benchmarks",
        icon: <IconLibrary size={15} />,
        text: "benchmarks catalog domains categories",
        go: "/benchmarks",
      },
      {
        key: "p-agents",
        group: "Pages",
        label: "Agents",
        icon: <IconBot size={15} />,
        text: "agents harness codex claude",
        go: "/agents",
      },
      {
        key: "p-methods",
        group: "Pages",
        label: "Methods",
        icon: <IconBranch size={15} />,
        text: "methods revisions lineage",
        go: "/methods",
      },
      {
        key: "p-bench",
        group: "Pages",
        label: "Evaluations",
        icon: <IconFlask size={15} />,
        text: "evaluations bench jobs trials",
        go: "/bench",
      },
      {
        key: "p-runs",
        group: "Pages",
        label: "Runs",
        icon: <IconRuns size={15} />,
        text: "runs",
        go: "/runs",
      },
      {
        key: "p-cmp",
        group: "Pages",
        label: "Compare runs",
        icon: <IconCompare size={15} />,
        text: "compare",
        go: "/compare",
      },
      {
        key: "p-res",
        group: "Pages",
        label: "Resources",
        icon: <IconChip size={15} />,
        text: "resources gpu",
        go: "/resources",
      },
      {
        key: "p-set",
        group: "Pages",
        label: "Settings",
        icon: <IconSettings size={15} />,
        text: "settings auth profiles notifications",
        go: "/settings",
      },
    ];
    const groups = [...new Set(runs.map((r) => r.spec.group).filter(Boolean))] as string[];
    const g: Item[] = groups.map((name) => ({
      key: `g-${name}`,
      group: "Groups",
      label: name,
      hint: "compare group",
      icon: <IconLayers size={15} />,
      text: `group ${name}`,
      go: `/compare?group=${encodeURIComponent(name)}`,
    }));
    const r: Item[] = runs.map((run) => ({
      key: run.id,
      group: "Runs",
      label: runTitle(run),
      hint: run.id,
      icon: <StateIcon state={run.state} />,
      text: `${run.id} ${runTitle(run)} ${run.spec.group ?? ""} ${Object.entries(run.spec.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
      go: `${runPath(run.id)}`,
    }));
    const all = [...pages, ...g, ...r];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((i) => terms.every((t) => i.text.toLowerCase().includes(t))).slice(0, 60);
  }, [runs, q]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    navigate(i.go);
    onClose();
  };

  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the selection moves
  useEffect(() => {
    list.current?.querySelector(".item.on")?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          // biome-ignore lint/a11y/noAutofocus: palette opens on explicit shortcut
          autoFocus
          placeholder="Jump to a run, group or page…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCur(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setCur((c) => Math.min(c + 1, items.length - 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setCur((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") choose(items[cur]);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="items" ref={list}>
          {items.length === 0 && <div className="empty">No matches</div>}
          {items.map((i, k) => {
            const header = i.group !== lastGroup ? <div className="group">{i.group}</div> : null;
            lastGroup = i.group;
            return (
              <div key={i.key}>
                {header}
                <div
                  className={`item${k === cur ? " on" : ""}`}
                  onMouseMove={() => setCur(k)}
                  onClick={() => choose(i)}
                >
                  {i.icon}
                  <span className="grow ellipsis">{i.label}</span>
                  {i.hint && <span className="faint mono">{i.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
