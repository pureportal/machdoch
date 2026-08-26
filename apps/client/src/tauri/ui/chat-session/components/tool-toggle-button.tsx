import type { ComponentProps, JSX, ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { ControlTooltip, TooltipContent } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";

type ToolToggleDisabledMode = "aria" | "native";

type ButtonProps = ComponentProps<typeof Button>;
type TooltipContentProps = ComponentProps<typeof TooltipContent>;

export interface ToolToggleButtonProps {
  label: string;
  title?: string;
  icon: ReactNode;
  pressed: boolean;
  disabled?: boolean;
  disabledMode?: ToolToggleDisabledMode;
  onPressedChange: (pressed: boolean) => void;
  buttonVariant?: ButtonProps["variant"];
  buttonSize?: ButtonProps["size"];
  tooltipSide?: TooltipContentProps["side"];
  baseClassName?: string;
  activeClassName?: string;
  disabledClassName?: string;
  className?: string;
}

const DEFAULT_BASE_CLASS_NAME =
  "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 text-slate-400 shadow-none hover:bg-slate-900 hover:text-slate-100";
const DEFAULT_DISABLED_CLASS_NAME =
  "cursor-not-allowed border-dashed bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600";
export const ToolToggleButton = ({
  label,
  title,
  icon,
  pressed,
  disabled = false,
  disabledMode = "aria",
  onPressedChange,
  buttonVariant = "outline",
  buttonSize = "icon",
  tooltipSide = "top",
  baseClassName,
  activeClassName,
  disabledClassName,
  className,
}: ToolToggleButtonProps): JSX.Element => {
  const nativeDisabled = disabled && disabledMode === "native";
  const ariaDisabled = disabled && disabledMode === "aria";
  const effectiveBaseClassName = baseClassName ?? DEFAULT_BASE_CLASS_NAME;
  const effectiveDisabledClassName =
    disabledClassName ??
    (baseClassName ? undefined : DEFAULT_DISABLED_CLASS_NAME);
  const stateClassName = disabled
    ? effectiveDisabledClassName
    : pressed
      ? activeClassName
      : undefined;
  const button = (
    <Button
      type="button"
      variant={buttonVariant}
      size={buttonSize}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={ariaDisabled || undefined}
      disabled={nativeDisabled || undefined}
      tooltip={null}
      onClick={() => {
        if (!disabled) {
          onPressedChange(!pressed);
        }
      }}
      className={cn(effectiveBaseClassName, stateClassName, className)}
    >
      {icon}
    </Button>
  );

  return (
    <ControlTooltip content={title ?? label} side={tooltipSide}>
      {nativeDisabled ? <span className="inline-flex">{button}</span> : button}
    </ControlTooltip>
  );
};
