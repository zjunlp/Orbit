import { Empty, Loading } from "../../components/ui.tsx";
import { api, type Run } from "../../lib/api.ts";
import { dateTime, duration, isActive, utcOffset } from "../../lib/format.ts";
import { useAsync } from "../../lib/use.ts";

export function EventsTab({ run }: { run: Run }) {
  const ev = useAsync(() => api.events(run.id), [run.id, run.state, run.cleanup], {
    poll: isActive(run.state),
    pollMs: 3000,
  });
  if (!ev.data)
    return ev.error ? <Empty title="Could not load events">{ev.error}</Empty> : <Loading />;
  const t0 = Date.parse(run.createdAt);
  // Runs almost always stay inside one zone, so label it once in the header; a run that crosses a
  // DST switch keeps a per-row label instead.
  const zones = [...new Set(ev.data.map((e) => utcOffset(e.at)))];
  const oneZone = zones.length === 1 ? zones[0] : null;
  return (
    <div className="page-pad">
      <table className="table compact">
        <thead>
          <tr>
            <th style={{ width: 50 }}>#</th>
            <th style={{ width: 170 }}>
              Time{oneZone && <span className="faint"> {oneZone}</span>}
            </th>
            <th style={{ width: 90 }} className="r">
              Offset
            </th>
            <th style={{ width: 120 }}>Kind</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {ev.data.map((e) => (
            <tr key={e.seq}>
              <td className="faint mono">{e.seq}</td>
              <td className="mono muted" title={e.at}>
                {dateTime(e.at)}
                {!oneZone && <span className="faint"> {utcOffset(e.at)}</span>}
              </td>
              <td className="r mono faint">+{duration(Date.parse(e.at) - t0)}</td>
              <td className="mono">{e.kind}</td>
              <td style={{ whiteSpace: "normal" }}>{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
