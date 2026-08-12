import { ArrowDown, TerminalSquare } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type UIEvent,
} from "react";
import type { WorkspaceRunConfigurationStatus } from "../../../shared/workspace-run.js";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  collectWorkspaceRunLogs,
  workspaceRunConfigurationLabel,
} from "./workspace-run-model";

const OUTPUT_BOTTOM_THRESHOLD = 24;
const MAX_COMBINED_OUTPUT_ENTRIES = 400;

export const WorkspaceRunOutput = ({
  status,
  compact,
}: {
  status: WorkspaceRunConfigurationStatus;
  compact: boolean;
}): JSX.Element => {
  const outputRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [configurationFilter, setConfigurationFilter] = useState("all");
  const logs = useMemo(() => collectWorkspaceRunLogs(status), [status]);
  const showsTaskLabels = status.configuration.kind === "composite";
  const visibleLogs = useMemo(() => {
    if (configurationFilter !== "all") {
      return logs.filter(
        (entry) => entry.configurationId === configurationFilter,
      );
    }
    return showsTaskLabels ? logs.slice(-MAX_COMBINED_OUTPUT_ENTRIES) : logs;
  }, [configurationFilter, logs, showsTaskLabels]);
  const latestSequence = visibleLogs.at(-1)?.entry.sequence ?? 0;

  useLayoutEffect(() => {
    followingRef.current = true;
    setConfigurationFilter("all");
    setFollowing(true);
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [status.configuration.id]);

  useLayoutEffect(() => {
    followingRef.current = true;
    setFollowing(true);
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [configurationFilter]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output && followingRef.current) output.scrollTop = output.scrollHeight;
  }, [latestSequence, logs.length]);

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const output = event.currentTarget;
    const nextFollowing =
      output.scrollHeight - output.scrollTop - output.clientHeight <=
      OUTPUT_BOTTOM_THRESHOLD;
    followingRef.current = nextFollowing;
    setFollowing((current) =>
      current === nextFollowing ? current : nextFollowing,
    );
  };

  const scrollToLatest = (): void => {
    const output = outputRef.current;
    if (!output) return;
    followingRef.current = true;
    setFollowing(true);
    output.scrollTop = output.scrollHeight;
  };

  return (
    <div className="border-t border-slate-800">
      <div className="flex h-9 items-center gap-2 px-3 text-xs text-slate-400">
        <TerminalSquare aria-hidden="true" className="size-3.5" />
        <span>Output</span>
        {status.configuration.kind === "composite" &&
        status.children.length > 1 ? (
          <select
            aria-label="Output task"
            value={configurationFilter}
            onChange={(event) =>
              setConfigurationFilter(event.currentTarget.value)
            }
            className="h-6 min-w-0 max-w-40 rounded border border-slate-700 bg-slate-950 px-1.5 text-[11px] text-slate-300 outline-none focus-visible:border-sky-500"
          >
            <option value="all">All tasks</option>
            {status.children.map((child) => (
              <option
                key={child.configuration.id}
                value={child.configuration.id}
              >
                {workspaceRunConfigurationLabel(child, status.children)}
              </option>
            ))}
          </select>
        ) : null}
        {!following ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={scrollToLatest}
          >
            <ArrowDown aria-hidden="true" className="size-3" />
            Latest
          </Button>
        ) : null}
      </div>
      <div
        ref={outputRef}
        role="log"
        aria-label={`${status.configuration.name} output`}
        aria-live="off"
        tabIndex={0}
        onScroll={handleScroll}
        className={cn(
          "overflow-y-auto border-t border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/70",
          compact
            ? "max-h-[min(13rem,32vh)] min-h-24"
            : "max-h-[min(22rem,42vh)] min-h-32",
        )}
      >
        {visibleLogs.length === 0 ? (
          <span className="text-slate-600">No output yet</span>
        ) : (
          visibleLogs.map(({ configurationId, label, entry }) => (
            <div
              key={entry.sequence}
              className="flex min-w-0 items-start gap-1.5"
            >
              {showsTaskLabels ? (
                <span className="shrink-0 text-slate-600">[{label}]</span>
              ) : null}
              {entry.stream !== "stdout" ? (
                <span
                  className={cn(
                    "shrink-0",
                    entry.stream === "stderr"
                      ? "text-red-400"
                      : "text-slate-600",
                  )}
                >
                  [{entry.stream}]
                </span>
              ) : null}
              <span
                data-configuration-id={configurationId}
                data-stream={entry.stream}
                className={cn(
                  "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
                  entry.stream === "stderr"
                    ? "text-red-300"
                    : entry.stream === "system"
                      ? "text-slate-500"
                      : "text-slate-300",
                )}
              >
                {entry.line || " "}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
