import { PromptEnhancementIndicator } from "@machdoch/product-ui";
import type { JSX } from "react";

export interface PromptEnhancementPendingProps {
  className?: string;
  onCancel?: () => void;
}

export const PromptEnhancementPending = ({
  className,
  onCancel,
}: PromptEnhancementPendingProps): JSX.Element => {
  return (
    <PromptEnhancementIndicator className={className} onCancel={onCancel} />
  );
};
