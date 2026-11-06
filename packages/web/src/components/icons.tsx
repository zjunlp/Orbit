// Inline 16px stroke icons (Lucide-style geometry) so the bundle has no icon font or CDN.
import type { ImgHTMLAttributes, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const logoUrl = new URL("../../../../assets/orbit-icon.png", import.meta.url).href;

function I({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconLogo = ({
  size = 16,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { size?: number }) => (
  <img src={logoUrl} alt="Orbit" width={size} height={size} className="brand-logo" {...rest} />
);
export const IconRuns = (p: P) => (
  <I {...p}>
    <path d="M3 6h18M3 12h18M3 18h12" />
  </I>
);
export const IconCompare = (p: P) => (
  <I {...p}>
    <path d="M3 3v18h18" />
    <path d="m7 15 4-5 3 3 6-7" />
  </I>
);
export const IconChip = (p: P) => (
  <I {...p}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </I>
);
export const IconSearch = (p: P) => (
  <I {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </I>
);
export const IconChevron = (p: P) => (
  <I {...p}>
    <path d="m9 6 6 6-6 6" />
  </I>
);
export const IconChevronDown = (p: P) => (
  <I {...p}>
    <path d="m6 9 6 6 6-6" />
  </I>
);
export const IconCheck = (p: P) => (
  <I {...p}>
    <path d="M20 6 9 17l-5-5" />
  </I>
);
export const IconX = (p: P) => (
  <I {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </I>
);
export const IconCircle = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8" />
  </I>
);
export const IconBan = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.7 5.7 12.6 12.6" />
  </I>
);
export const IconHelp = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
  </I>
);
export const IconLoader = (p: P) => (
  <I {...p}>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
  </I>
);
export const IconCopy = (p: P) => (
  <I {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </I>
);
export const IconDownload = (p: P) => (
  <I {...p}>
    <path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16" />
  </I>
);
export const IconFile = (p: P) => (
  <I {...p}>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <path d="M14 3v5h5" />
  </I>
);
export const IconFolder = (p: P) => (
  <I {...p}>
    <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </I>
);
export const IconImage = (p: P) => (
  <I {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </I>
);
export const IconGit = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5c0 4-6 3-10.5 6" />
  </I>
);
export const IconTerminal = (p: P) => (
  <I {...p}>
    <path d="m4 17 6-5-6-5M12 19h8" />
  </I>
);
export const IconBot = (p: P) => (
  <I {...p}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4M9 13v1M15 13v1" />
  </I>
);
export const IconUser = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </I>
);
export const IconWrench = (p: P) => (
  <I {...p}>
    <path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.3-1.3a4 4 0 0 1-5-5L13 2z" />
  </I>
);
export const IconBrain = (p: P) => (
  <I {...p}>
    <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />
  </I>
);
export const IconClock = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </I>
);
export const IconAlert = (p: P) => (
  <I {...p}>
    <path d="M12 3 2 20h20z" />
    <path d="M12 10v4M12 17h.01" />
  </I>
);
export const IconInfo = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </I>
);
export const IconSun = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </I>
);
export const IconMoon = (p: P) => (
  <I {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
  </I>
);
export const IconKeyboard = (p: P) => (
  <I {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </I>
);
export const IconArrowDown = (p: P) => (
  <I {...p}>
    <path d="M12 5v14m0 0-6-6m6 6 6-6" />
  </I>
);
export const IconWrap = (p: P) => (
  <I {...p}>
    <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h7" />
  </I>
);
export const IconStar = (p: P) => (
  <I {...p}>
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />
  </I>
);
export const IconLink = (p: P) => (
  <I {...p}>
    <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </I>
);
export const IconLayers = (p: P) => (
  <I {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </I>
);
export const IconBox = (p: P) => (
  <I {...p}>
    <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
    <path d="m3 8 9 5 9-5M12 13v8" />
  </I>
);
export const IconBroom = (p: P) => (
  <I {...p}>
    <path d="M19 3 11 11M8 11l5 5-2 5c-3-1-6-4-7-7z" />
  </I>
);
export const IconExternal = (p: P) => (
  <I {...p}>
    <path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </I>
);
export const IconFilter = (p: P) => (
  <I {...p}>
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </I>
);
export const IconEdit = (p: P) => (
  <I {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </I>
);
export const IconSettings = (p: P) => (
  <I {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </I>
);
export const IconBell = (p: P) => (
  <I {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </I>
);
export const IconKey = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
  </I>
);
export const IconFlask = (p: P) => (
  <I {...p}>
    <path d="M9 3h6" />
    <path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
    <path d="M7 15h10" />
  </I>
);
export const IconDashboard = (p: P) => (
  <I {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </I>
);
export const IconLibrary = (p: P) => (
  <I {...p}>
    <path d="M4 4v16M9 4v16" />
    <path d="m14 4.5 4.5 15.5" />
  </I>
);
export const IconBranch = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="12" r="2.2" />
    <path d="M6 7.2v9.6M8 6.5c5 .5 8 2.5 8.2 3.6M8 17.5c5-.5 8-2.5 8.2-3.6" />
  </I>
);
export const IconSidebar = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </I>
);
