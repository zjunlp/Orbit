import type { ReactNode } from "react";

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Notice({
  error,
  loading = false,
}: {
  error?: string;
  loading?: boolean;
}) {
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : loading ? (
    <p role="status" className="muted">
      正在读取本机数据…
    </p>
  ) : null;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "muted";

export function statusVariant(status: string): BadgeVariant {
  const value = status.toLowerCase();
  if (
    /completed|complete|succeeded|success|scored|archived|done|ok|已完成|成功/.test(
      value,
    )
  )
    return "success";
  if (/failed|error|conflict|quota_exhausted|失败|异常|冲突/.test(value))
    return "danger";
  if (/timed?_?out|cancel|stale|deferred|waiting|超时|取消|等待/.test(value))
    return "warning";
  if (
    /running|accepted|queued|pending|submitted|progress|进行中|运行|排队/.test(
      value,
    )
  )
    return "info";
  return "muted";
}

export function Badge({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: BadgeVariant;
}) {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}
