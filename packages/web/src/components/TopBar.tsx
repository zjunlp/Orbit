import { Link } from "./ui.tsx";
import "./topbar.css";

export interface Crumb {
  label: React.ReactNode;
  href?: string;
}

export function TopBar({
  crumbs,
  children,
  className,
}: {
  crumbs: Crumb[];
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={className ? `topbar ${className}` : "topbar"}>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={String(i)} className="row" style={{ gap: 6, minWidth: 0 }}>
            {i > 0 && <span className="sep">/</span>}
            {c.href ? (
              <Link href={c.href}>{c.label}</Link>
            ) : (
              <span className="here ellipsis">{c.label}</span>
            )}
          </span>
        ))}
      </div>
      <div className="spacer" />
      {children}
    </header>
  );
}
