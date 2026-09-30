import type { ReactNode } from "react";

function StrokeIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconFlask() {
  return (
    <StrokeIcon>
      <path d="M9 3h6" />
      <path d="M10 3v6.3L4.7 19a2 2 0 0 0 1.8 2.9h11a2 2 0 0 0 1.8-2.9L14 9.3V3" />
      <path d="M7.5 15h9" />
    </StrokeIcon>
  );
}

export function IconFolder() {
  return (
    <StrokeIcon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </StrokeIcon>
  );
}

export function IconCpu() {
  return (
    <StrokeIcon>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <rect x="10.5" y="10.5" width="3" height="3" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </StrokeIcon>
  );
}

export function IconGear() {
  return (
    <StrokeIcon>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
    </StrokeIcon>
  );
}

export function IconGauge() {
  return (
    <StrokeIcon>
      <path d="M4 14a8 8 0 1 1 16 0" />
      <path d="M12 14l4-4.5" />
      <path d="M4 18h16" />
    </StrokeIcon>
  );
}

export function IconAlert() {
  return (
    <StrokeIcon>
      <path d="M12 3.5 21 20H3L12 3.5Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.3v.01" />
    </StrokeIcon>
  );
}

export function IconCheck() {
  return (
    <StrokeIcon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.3l2.4 2.4 4.6-5" />
    </StrokeIcon>
  );
}

export function IconCircleX() {
  return (
    <StrokeIcon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </StrokeIcon>
  );
}
