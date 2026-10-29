import type { JSX, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

const Svg = ({ title, children, ...props }: IconProps & { children: JSX.Element | JSX.Element[] }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={title ? undefined : true}
    role={title ? "img" : undefined}
    focusable="false"
    {...props}
  >
    {title ? <title>{title}</title> : <></>}
    {children}
  </svg>
);

/** A four-point spark with a small companion: suggested next prompts. */
export const FollowUpSparkIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10 3.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z" />
    <path d="M18 14.5c.3 1.6 1.1 2.4 2.5 2.7-1.4.3-2.2 1.1-2.5 2.8-.3-1.7-1.1-2.5-2.5-2.8 1.4-.3 2.2-1.1 2.5-2.7Z" />
  </Svg>
);

/** A path that bends into a moving dot: steer the running turn. */
export const SteerIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 18c0-6 3.5-9.5 9.5-9.5H17" />
    <path d="m14.5 5.5 3 3-3 3" />
    <circle cx="19.25" cy="17.5" r="2.25" fill="currentColor" stroke="none" />
  </Svg>
);

/** A slanted bolt inside a soft capsule: the fast service tier. */
export const FastTierIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.2 2.75 6.5 13.1h4.6l-1.3 8.15 6.7-10.35h-4.6l1.3-8.15Z" fill="currentColor" fillOpacity={0.18} />
  </Svg>
);

/** A rounded square inside a ring: stop this background task. */
export const StopTaskIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

/** A terminal prompt: a shell command the agent started. */
export const ShellTaskIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="m7 9.5 3 2.5-3 2.5" />
    <path d="M12.5 15h4.5" />
  </Svg>
);

/** Two linked nodes: a sub-agent working in parallel. */
export const AgentTaskIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="7" cy="8" r="3" />
    <circle cx="17" cy="16" r="3" />
    <path d="M9.4 9.9 14.6 14" />
    <path d="M16.5 4.5v3M15 6h3" />
  </Svg>
);

/** A pulse line: a monitor or watch the agent keeps running. */
export const MonitorTaskIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 12h4l2-5 3.5 10 2.5-6 1.5 1H21" />
  </Svg>
);

/** A lens over changed lines: review the workspace changes. */
export const ReviewChangesIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 5.5h9M4 9.5h6M4 13.5h4" />
    <circle cx="15.5" cy="14.5" r="4" />
    <path d="m18.5 17.5 2.75 2.75" />
    <path d="M14 14.5h3M15.5 13v3" />
  </Svg>
);

/** A speech bubble holding a question mark: the agent is asking. */
export const AgentQuestionIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-6.5L8 20.5v-3.5H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
    <path d="M10 9a2.1 2.1 0 1 1 3.1 1.85c-.7.37-1.1.9-1.1 1.65" />
    <circle cx="12" cy="14.6" r="0.6" fill="currentColor" />
  </Svg>
);

/** An arrow leaving a corner: send this suggestion right away. */
export const SendNowIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5 19 19 5" />
    <path d="M9 5h10v10" />
  </Svg>
);

/** Plan step states: open ring, half-filled ring, checked ring. */
export const PlanStepIcon = ({
  status,
  ...props
}: IconProps & { status: "pending" | "in_progress" | "completed" }) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8" />
    {status === "completed" ? (
      <path d="m8.5 12.2 2.3 2.3 4.7-4.9" />
    ) : status === "in_progress" ? (
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    ) : (
      <></>
    )}
  </Svg>
);

/** A ring that fills with the share of the context window in use. */
export const ContextGauge = ({
  ratio,
  size = 28,
  label,
}: {
  ratio: number;
  size?: number;
  label: string;
}) => {
  const clamped = Math.min(1, Math.max(0, ratio));
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const tone =
    clamped >= 0.9
      ? "text-rose-300"
      : clamped >= 0.75
        ? "text-amber-300"
        : "text-sky-300";
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={tone}
    >
      <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={3} />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
};
