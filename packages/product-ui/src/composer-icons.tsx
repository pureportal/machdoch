import type { ReactElement, ReactNode, SVGProps } from "react";

export type ComposerIconProps = Omit<SVGProps<SVGSVGElement>, "children">;

export function ComposerSvg({
  children,
  ...props
}: ComposerIconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ModelIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" />
      <path d="m12 8 4 4-4 4-4-4Z" />
    </ComposerSvg>
  );
}

export function WorkspaceIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v1M3 7h6l3 3h7a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 1H5a2 2 0 0 1-2-2Z" />
    </ComposerSvg>
  );
}

export function LockedWorkspaceIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" />
      <rect x="12" y="14" width="10" height="8" rx="2" />
      <path d="M14 14v-2a3 3 0 0 1 6 0v2m-3 3v2" />
    </ComposerSvg>
  );
}

export function ExecuteIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M14 3a6 6 0 0 0-7 8L3 15a3.5 3.5 0 0 0 5 5l5-5a6 6 0 0 0 8-7l-4 4-5-5Z" />
      <circle cx="5.5" cy="17.5" r=".8" fill="currentColor" stroke="none" />
    </ComposerSvg>
  );
}

export function AskIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z" />
      <path d="M9.5 8a2.5 2.5 0 1 1 4 2l-1.5 1v1" />
      <circle cx="12" cy="15" r=".8" fill="currentColor" stroke="none" />
    </ComposerSvg>
  );
}

export function AdaptiveControlIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M20 7a9 9 0 1 0 1 8M20 3v4h-4" />
      <path d="M5 12h1m6-6v1m6 8h1m-7-2 4-4" />
      <circle cx="12" cy="13" r="1.5" />
    </ComposerSvg>
  );
}

export function ParallelAgentsIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <circle cx="6" cy="7" r="3" />
      <circle cx="18" cy="7" r="3" />
      <path d="M2 21v-3a4 4 0 0 1 8 0v3m4 0v-3a4 4 0 0 1 8 0v3" />
    </ComposerSvg>
  );
}

export function ReadOnlyIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </ComposerSvg>
  );
}

export function FullAccessIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </ComposerSvg>
  );
}

export function OffIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m6 6 12 12" />
    </ComposerSvg>
  );
}

export function GoalIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M14 3a9 9 0 1 0 7 7M12 7a5 5 0 1 0 5 5m-5 0 9-9m-5 0h5v5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </ComposerSvg>
  );
}

export function PromptEnhancementIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7M7 8h3m-3 4h3m-3 4h1" />
      <path d="m13 20-1 2 3-1 7-7-2-2Zm5-6 2 2M18 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" />
    </ComposerSvg>
  );
}

export function SearchIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 7 7" />
    </ComposerSvg>
  );
}

export function ContextPacksIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M8 3h11a2 2 0 0 1 2 2v11M5 6h11a2 2 0 0 1 2 2v11" />
      <rect x="2" y="9" width="13" height="13" rx="2" />
      <path d="M6 14h5m-5 4h3" />
    </ComposerSvg>
  );
}

function MemoryRibbon(): ReactElement {
  return <path d="M15 11h7v11l-3.5-2L15 22Z" />;
}

export function SessionMemoryIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v17l6-4h2" />
      <path d="M7 8h9m-9 5h4" />
      <MemoryRibbon />
    </ComposerSvg>
  );
}

export function WorkspaceMemoryIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M21 10V8a2 2 0 0 0-2-2h-7L9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
      <MemoryRibbon />
    </ComposerSvg>
  );
}

export function GlobalMemoryIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M11 21a9 9 0 1 1 10-12M3 12h8M12 3c-5 5-5 13 0 18m0-18a14 14 0 0 1 3 6" />
      <MemoryRibbon />
    </ComposerSvg>
  );
}

export function InterviewIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M17 10V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12l4-3h3m-3-6h7" />
      <path d="M12 11h8a2 2 0 0 1 2 2v9l-4-3h-6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Zm2 4h4" />
    </ComposerSvg>
  );
}

export function UiControlIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M10 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5M8 17v4m-3 0h7" />
      <path d="m14 10 8 6-4 1-2 4Z" />
    </ComposerSvg>
  );
}

export function DropdownIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="m7 10 5 5 5-5" />
    </ComposerSvg>
  );
}

export function WorkspaceDefaultIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path
        d="M2 6a2 2 0 0 1 2-2h5l3 3h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"
        fill="currentColor"
        stroke="none"
      />
    </ComposerSvg>
  );
}

export function SteerIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <path d="M5 3v7a4 4 0 0 0 4 4h12m-6-6 6 6-6 6" />
    </ComposerSvg>
  );
}

export function StopIcon(props: ComposerIconProps): ReactElement {
  return (
    <ComposerSvg {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </ComposerSvg>
  );
}
