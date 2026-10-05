import type { ReactElement } from "react";
import { ComposerSvg, type ComposerIconProps } from "./composer-icons";

type ReasoningLevel =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "aeon";

const EFFORT = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
} satisfies Record<
  Exclude<ReasoningLevel, "default" | "none" | "ultra" | "aeon">,
  number
>;

const BAR_HEIGHTS = [6, 9, 12, 15, 18];

function ReasoningIcon({
  level,
  ...props
}: ComposerIconProps & { level: ReasoningLevel }): ReactElement {
  if (level === "aeon") {
    return (
      <ComposerSvg {...props}>
        <path d="M12 12c-3-7-9-7-9 0s6 7 9 0 9-7 9 0-6 7-9 0Z" />
      </ComposerSvg>
    );
  }

  if (level === "ultra") {
    return (
      <ComposerSvg {...props}>
        <path d="m14 2-11 12h8l-1 8 11-12h-8Z" fill="currentColor" />
      </ComposerSvg>
    );
  }

  if (level === "default" || level === "none") {
    return (
      <ComposerSvg {...props}>
        <path d="M8 17v-2c0-2-3-3-3-7a7 7 0 0 1 14 0c0 4-3 5-3 7v2Z" />
        <path d="M9 21h6m-3-4v-6m-2-2 2 2 2-2" />
        {level === "none" ? <path d="m3 3 18 18" /> : null}
      </ComposerSvg>
    );
  }

  return (
    <ComposerSvg {...props}>
      {BAR_HEIGHTS.map((height, step) => (
        <rect
          key={step}
          x={2 + step * 4}
          y={21 - height}
          width="3"
          height={height}
          rx=".5"
          fill="currentColor"
          opacity={step < EFFORT[level] ? 1 : 0.25}
          stroke="none"
        />
      ))}
      {level === "minimal" ? (
        <rect
          x="2"
          y="18"
          width="3"
          height="3"
          rx=".5"
          fill="currentColor"
          stroke="none"
        />
      ) : null}
    </ComposerSvg>
  );
}

export const ReasoningIcons = {
  default: (props: ComposerIconProps) => (
    <ReasoningIcon level="default" {...props} />
  ),
  none: (props: ComposerIconProps) => <ReasoningIcon level="none" {...props} />,
  minimal: (props: ComposerIconProps) => (
    <ReasoningIcon level="minimal" {...props} />
  ),
  low: (props: ComposerIconProps) => <ReasoningIcon level="low" {...props} />,
  medium: (props: ComposerIconProps) => (
    <ReasoningIcon level="medium" {...props} />
  ),
  high: (props: ComposerIconProps) => <ReasoningIcon level="high" {...props} />,
  xhigh: (props: ComposerIconProps) => (
    <ReasoningIcon level="xhigh" {...props} />
  ),
  max: (props: ComposerIconProps) => <ReasoningIcon level="max" {...props} />,
  ultra: (props: ComposerIconProps) => (
    <ReasoningIcon level="ultra" {...props} />
  ),
  aeon: (props: ComposerIconProps) => <ReasoningIcon level="aeon" {...props} />,
};
