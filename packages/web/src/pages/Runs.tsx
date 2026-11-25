import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderSidebar, MoveDialog } from "../components/Folders.tsx";
import { IconCompare, IconFolder, IconLayers, IconX } from "../components/icons.tsx";
import { ConfirmDialog, Empty, Kbd, Link, Loading, toast, useNow } from "../components/ui.tsx";
import { api, type Run, type RunState } from "../lib/api.ts";
import { inFolder } from "../lib/folders.ts";
import { isActive, runPath } from "../lib/format.ts";
import { overlayOpen, useHotkeys } from "../lib/hotkeys.ts";
import { navigate, setQuery, useLocation } from "../lib/router.ts";
import { useRuns, useRunsState } from "../lib/runs-store.ts";
import { useScrollRestore } from "../lib/scroll.ts";
import { useAsync } from "../lib/use.ts";
import { CancelSelected, DeleteSelected } from "./runs/BulkActions.tsx";
import { type Entry, type Job, KINDS, type Kind, matches, matchesJob } from "./runs/filters.tsx";
import { GroupRow } from "./runs/GroupRow.tsx";
import { JobRow } from "./runs/JobRow.tsx";
import { RunRow } from "./runs/RunRow.tsx";
import { RunsToolbar } from "./runs/Toolbar.tsx";

export function Runs() {
  const runs = useRuns();
  const { loaded, error } = useRunsState();
  const loc = useLocation();
  const q = loc.query.get("q") ?? "";
  const stateParam = loc.query.get("state") ?? "";
  const stateFilter = useMemo(
    () => stateParam.split(",").filter(Boolean) as RunState[],
    [stateParam],
  );
  const flat = loc.query.get("flat") === "1";
  const folder = loc.query.get("folder") ?? "";
  const folders = useAsync(() => api.folders(), [], { poll: true, pollMs: 10_000 });
  const [moving, setMoving] = useState<string[] | null>(null);
  const kind = (
    KINDS.includes(loc.query.get("kind") as Kind) ? loc.query.get("kind") : "all"
  ) as Kind;
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 10_000 });
  const jobByGroup = useMemo(
    () => new Map((jobs.data ?? []).map((j) => [`bench-${j.id}`, j])),
    [jobs.data],
  );
  const isBench = useCallback(
    (r: Run) => Boolean(r.spec.group && (jobByGroup.has(r.spec.group) || r.spec.tags.bench)),
    [jobByGroup],
  );
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [deletingJob, setDeletingJob] = useState<Job | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const anyActive = runs.some((r) => isActive(r.state));
  const now = useNow(1000, anyActive);
  const list = useScrollRestore<HTMLDivElement>("runs", loaded && runs.length > 0);

  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const visible = useMemo(
    () =>
      runs.filter(
        (r) =>
          inFolder(r.folder, folder) &&
          (stateFilter.length ? stateFilter.includes(r.state) : true) &&
          (kind === "all" || (kind === "bench") === isBench(r)) &&
          (matches(r, terms) || matchesJob(jobByGroup.get(r.spec.group ?? ""), terms)),
      ),
    [runs, folder, stateFilter, terms, kind, isBench, jobByGroup],
  );

  const counts = useMemo(() => {
    const c: Partial<Record<RunState, number>> = {};
    for (const r of runs.filter((r) => inFolder(r.folder, folder) && matches(r, terms)))
      c[r.state] = (c[r.state] ?? 0) + 1;
    return c;
  }, [runs, folder, terms]);

  // A state filter names runs the user is looking for, so groups open by default there too;
  // a group the user collapsed by hand stays collapsed.
  const isExpanded = useCallback(
    (name: string, list: Run[]) =>
      open.has(name) ||
      (!closed.has(name) &&
        (list.some((r) => isActive(r.state)) || terms.length > 0 || stateFilter.length > 0)),
    [open, closed, terms.length, stateFilter.length],
  );

  // Group runs by spec.group; a group sits where its newest run would be.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const seen = new Map<string, Run[]>();
    for (const r of visible) {
      const g = !flat && r.spec.group;
      if (!g) {
        out.push({ kind: "run", run: r, inGroup: false, key: r.id });
        continue;
      }
      let list = seen.get(g);
      if (!list) {
        list = [];
        seen.set(g, list);
        out.push({ kind: "group", name: g, runs: list, key: `g:${g}` });
      }
      list.push(r);
    }
    const rows: Entry[] = [];
    for (const e of out) {
      rows.push(e);
      if (e.kind !== "group") continue;
      if (isExpanded(e.name, e.runs) && !jobByGroup.has(e.name))
        for (const r of [...e.runs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)))
          rows.push({ kind: "run", run: r, inGroup: true, key: r.id });
    }
    return rows;
  }, [visible, flat, isExpanded, jobByGroup]);

  const toggleGroup = (name: string, list: Run[]) => {
    const exp = isExpanded(name, list);
    setOpen((s) => {
      const n = new Set(s);
      if (exp) n.delete(name);
      else n.add(name);
      return n;
    });
    setClosed((s) => {
      const n = new Set(s);
      if (exp) n.add(name);
      else n.delete(name);
      return n;
    });
  };

  const toggleSel = (ids: string[]) =>
    setSelected((s) => {
      const n = new Set(s);
      const all = ids.every((id) => n.has(id));
      for (const id of ids) {
        if (all) n.delete(id);
        else n.add(id);
      }
      return n;
    });

  useEffect(() => {
    if (cursor >= entries.length) setCursor(Math.max(0, entries.length - 1));
  }, [entries.length, cursor]);

  // Scroll the keyboard cursor into view on every move except the first: on mount the saved
  // position from the last visit decides where the list sits.
  const cursorSettled = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the cursor moves
  useEffect(() => {
    if (!cursorSettled.current) {
      cursorSettled.current = true;
      return;
    }
    document.querySelector("tr.cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const current = entries[cursor];
  const compareHref = `/compare?ids=${[...selected].map(encodeURIComponent).join(",")}`;
  useHotkeys({
    j: () => setCursor((c) => Math.min(c + 1, entries.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    ArrowDown: () => setCursor((c) => Math.min(c + 1, entries.length - 1)),
    ArrowUp: () => setCursor((c) => Math.max(c - 1, 0)),
    Enter: () => open_(current),
    o: () => open_(current),
    x: () =>
      current &&
      toggleSel(current.kind === "run" ? [current.run.id] : current.runs.map((r) => r.id)),
    c: () => selected.size && navigate(compareHref),
    "/": () => search.current?.focus(),
    Escape: () => {
      if (!overlayOpen()) setSelected(new Set());
    },
  });

  function open_(e: Entry | undefined) {
    if (!e) return;
    if (e.kind === "run") navigate(`${runPath(e.run.id)}`);
    else toggleGroup(e.name, e.runs);
  }

  const setStates = (s: RunState[]) => setQuery({ state: s.join(",") || null });

  return (
    <>
      <RunsToolbar
        q={q}
        search={search}
        stateFilter={stateFilter}
        counts={counts}
        setStates={setStates}
        kind={kind}
        flat={flat}
      />
      <div className="runs-body">
        <FolderSidebar
          stats={folders.data ?? []}
          total={runs.length}
          value={folder}
          onChange={(f) => setQuery({ folder: f || null })}
        />
        <div className="page" ref={list} data-scroll-key="runs">
          {!loaded ? (
            <Loading what="Loading runs" />
          ) : error ? (
            <Empty title="Could not load runs">{error}</Empty>
          ) : runs.length === 0 ? (
            <Empty title="No runs yet" icon={<IconLayers size={32} />}>
              <p>Ask your agent to launch an experiment, or run one yourself:</p>
              <p>
                <code>orbit run --gpus 1 --image python:3.12 -- python train.py</code>
              </p>
            </Empty>
          ) : entries.length === 0 ? (
            <Empty
              title={folder ? `Nothing in ${folder} matches` : "No runs match these filters"}
            />
          ) : (
            <table className="table runs-table">
              {/* Widths live in the stylesheet so container queries can shrink and drop columns. */}
              <colgroup>
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th>State</th>
                  <th>Run</th>
                  <th>Params</th>
                  <th>Resources</th>
                  <th>Agent</th>
                  <th>Code</th>
                  <th>Created</th>
                  <th className="r">Duration</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) =>
                  e.kind === "group" && jobByGroup.has(e.name) ? (
                    <JobRow
                      key={e.key}
                      job={jobByGroup.get(e.name) as Job}
                      runs={e.runs}
                      expanded={isExpanded(e.name, e.runs)}
                      cursor={i === cursor}
                      selected={e.runs.every((r) => selected.has(r.id))}
                      onToggle={() => toggleGroup(e.name, e.runs)}
                      onSelect={() => toggleSel(e.runs.map((r) => r.id))}
                      onHover={() => setCursor(i)}
                      now={now}
                    />
                  ) : e.kind === "group" ? (
                    <GroupRow
                      key={e.key}
                      name={e.name}
                      runs={e.runs}
                      expanded={isExpanded(e.name, e.runs)}
                      cursor={i === cursor}
                      selected={e.runs.every((r) => selected.has(r.id))}
                      onToggle={() => toggleGroup(e.name, e.runs)}
                      onSelect={() => toggleSel(e.runs.map((r) => r.id))}
                      onHover={() => setCursor(i)}
                      now={now}
                    />
                  ) : (
                    <RunRow
                      key={e.key}
                      run={e.run}
                      inGroup={e.inGroup}
                      cursor={i === cursor}
                      selected={selected.has(e.run.id)}
                      onSelect={() => toggleSel([e.run.id])}
                      onHover={() => setCursor(i)}
                      now={now}
                    />
                  ),
                )}
              </tbody>
            </table>
          )}
          {selected.size > 0 && (
            <div className="selbar">
              <b>{selected.size}</b> selected
              <Link className="btn primary sm" href={compareHref}>
                <IconCompare size={13} /> Compare <Kbd>c</Kbd>
              </Link>
              <button type="button" className="btn sm" onClick={() => setMoving([...selected])}>
                <IconFolder size={13} /> Move to folder
              </button>
              <CancelSelected ids={[...selected]} runs={runs} />
              <DeleteSelected
                ids={[...selected]}
                runs={runs}
                isBench={isBench}
                jobs={[...jobByGroup.values()]}
                onDelete={(ids) => setDeleting(ids)}
                onDeleteJob={(job) => setDeletingJob(job)}
              />
              <button
                type="button"
                className="btn ghost sm icon"
                onClick={() => setSelected(new Set())}
                title="Clear (Esc)"
              >
                <IconX size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
      {moving && (
        <MoveDialog
          ids={moving}
          folders={folders.data ?? []}
          initial={folder}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setSelected(new Set());
            folders.reload();
          }}
        />
      )}
      {deletingJob && (
        <ConfirmDialog
          title={`Delete bench job ${deletingJob.spec.name ?? deletingJob.id}`}
          expected={deletingJob.id}
          action="Delete this job"
          onClose={() => setDeletingJob(null)}
          onConfirm={async () => {
            const r = await api.benchDeleteJob(deletingJob.id);
            setSelected(new Set());
            jobs.reload();
            toast(
              `Deleted job and ${r.deleted.length} run(s)${r.leftovers.length ? `; ${r.leftovers.length} folder(s) left on disk` : ""}`,
            );
          }}
        >
          <p>
            This deletes the job <b>{deletingJob.spec.name ?? deletingJob.id}</b> (
            {deletingJob.spec.benchmark}), its trials and all of their solve and verify runs: logs,
            outputs, reports, Agent sessions and scores.
          </p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.length} run${deleting.length > 1 ? "s" : ""}`}
          expected={
            deleting.length === 1 ? (deleting[0] as string) : `delete ${deleting.length} runs`
          }
          action={`Delete ${deleting.length} run${deleting.length > 1 ? "s" : ""}`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await api.deleteRuns(deleting);
            setSelected(new Set());
            toast(
              `Deleted ${r.deleted.length} run(s)${r.leftovers.length ? `; ${r.leftovers.length} folder(s) left on disk` : ""}`,
            );
          }}
        >
          <p>
            Their records, logs, metrics, outputs, code snapshots and Agent sessions are removed
            from this machine.
          </p>
          <ul
            className="mono faint"
            style={{ margin: 0, paddingLeft: 18, maxHeight: 140, overflow: "auto" }}
          >
            {deleting.slice(0, 20).map((id) => (
              <li key={id}>{id}</li>
            ))}
            {deleting.length > 20 && <li>… {deleting.length - 20} more</li>}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}
