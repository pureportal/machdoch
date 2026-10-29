import type { JSX } from "react";
import { FollowUpSparkIcon, SendNowIcon } from "./agent-live-icons";

export interface FollowUpSuggestionsProps {
  suggestions: readonly string[];
  /** Puts the suggestion into the composer so it can be edited first. */
  onPick: (suggestion: string) => void;
  /** Sends the suggestion as the next message right away. */
  onSend?: (suggestion: string) => void;
  disabled?: boolean;
}

/** One-click prompts the agent suggested for the next message. */
export const FollowUpSuggestions = ({
  suggestions,
  onPick,
  onSend,
  disabled = false,
}: FollowUpSuggestionsProps): JSX.Element | null => {
  if (suggestions.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggested follow-ups"
      className="app-follow-up-suggestions flex max-w-[90%] min-w-0 flex-wrap items-center gap-2"
    >
      <FollowUpSparkIcon className="h-3.5 w-3.5 shrink-0 text-violet-300/80" />
      {suggestions.map((suggestion) => (
        <span
          key={suggestion}
          className="group inline-flex max-w-full items-stretch overflow-hidden rounded-full border border-violet-400/25 bg-violet-500/[0.08] text-xs text-violet-50 transition-colors hover:border-violet-300/45 hover:bg-violet-500/15"
        >
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion)}
            title="Edit in the composer"
            className="min-w-0 truncate py-1 pl-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {suggestion}
          </button>
          {onSend ? (
            <button
              type="button"
              disabled={disabled}
              aria-label={`Send: ${suggestion}`}
              title="Send now"
              onClick={() => onSend(suggestion)}
              className="flex items-center border-l border-violet-400/20 px-2 text-violet-200/70 transition-colors hover:bg-violet-400/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SendNowIcon className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
};
