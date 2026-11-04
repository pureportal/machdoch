import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  WholeWord,
  X,
} from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { FIND_BAR_ATTRIBUTE, getFindBarTop } from "./find-dom";
import { formatFindStatus, type FindOptions } from "./find-text-matches";

export interface FindBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  scopeElement: HTMLElement;
  label: string;
  query: string;
  options: FindOptions;
  count: number;
  activeIndex: number;
  limited: boolean;
  onQueryChange: (query: string) => void;
  onOptionsChange: (options: FindOptions) => void;
  onMove: (direction: 1 | -1) => void;
  onClose: () => void;
}

const BUTTON_CLASS = "text-slate-400 hover:bg-slate-800 hover:text-slate-100";
const PRESSED_CLASS = "bg-sky-500/15 text-sky-200 hover:bg-sky-500/20";

export const FindBar = ({
  inputRef,
  scopeElement,
  label,
  query,
  options,
  count,
  activeIndex,
  limited,
  onQueryChange,
  onOptionsChange,
  onMove,
  onClose,
}: FindBarProps): JSX.Element => {
  const barRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const placeholder = `Find in ${label}`;
  const status = formatFindStatus(query, count, activeIndex, limited);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let frame = 0;
    const place = (): void => {
      frame = 0;
      setTop(getFindBarTop(bar, scopeElement));
    };
    const schedulePlace = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(schedulePlace);
    observer.observe(scopeElement);
    scopeElement.addEventListener("scroll", schedulePlace, {
      capture: true,
      passive: true,
    });
    return () => {
      observer.disconnect();
      scopeElement.removeEventListener("scroll", schedulePlace, {
        capture: true,
      });
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [scopeElement]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      onMove(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      {...{ [FIND_BAR_ATTRIBUTE]: "" }}
      ref={barRef}
      role="search"
      style={top === null ? undefined : { top }}
      className="absolute top-3 right-14 z-40 flex w-[min(24rem,calc(100%-4.5rem))] items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-900/95 p-1 text-slate-200 shadow-xl shadow-black/40 backdrop-blur-md"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:ring-0"
      />
      <span
        aria-live="polite"
        className={cn(
          "shrink-0 px-1 text-[11px] whitespace-nowrap tabular-nums text-slate-500",
          status && count === 0 && "text-rose-300",
        )}
      >
        {status}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Match case"
        aria-pressed={options.matchCase}
        onClick={() =>
          onOptionsChange({ ...options, matchCase: !options.matchCase })
        }
        className={cn(BUTTON_CLASS, options.matchCase && PRESSED_CLASS)}
      >
        <CaseSensitive className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Match whole word"
        aria-pressed={options.wholeWord}
        onClick={() =>
          onOptionsChange({ ...options, wholeWord: !options.wholeWord })
        }
        className={cn(BUTTON_CLASS, options.wholeWord && PRESSED_CLASS)}
      >
        <WholeWord className="size-3.5" />
      </Button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-slate-700" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={() => onMove(-1)}
        className={BUTTON_CLASS}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={count === 0}
        onClick={() => onMove(1)}
        className={BUTTON_CLASS}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close find"
        onClick={onClose}
        className={BUTTON_CLASS}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
};
