import { ChevronDown, FileText, Terminal } from "lucide-react";
import type { JSX } from "react";

import type {
  RalphRunRecordBlock,
  RalphRunRecordBlockProgressEvent,
} from "../../../../core/ralph.js";
import { cn } from "../../lib/utils";
import {
  formatRalphProgressTimestamp,
  getRalphProgressKindLabel,
  getRalphProgressToneClassName,
  getRunEventToneClassName,
  type ActiveRalphRunBlockDetail,
} from "../_helpers/ralph-active-run-progress.helper";
import { getOutputChipClassName } from "../_helpers/ralph-run-presentation.helper";

interface RalphBlockProgressListProps {
  progress: readonly RalphRunRecordBlockProgressEvent[] | undefined;
}

const RalphBlockProgressList = ({
  progress,
}: RalphBlockProgressListProps): JSX.Element => {
  if (!progress || progress.length === 0) {
    return (
      <div className="text-xs text-slate-500">
        No streamed model or tool detail was captured for this block.
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {progress.map((event, index) => {
        const body = event.content ?? event.detail ?? "";

        return (
          <div
            key={`${event.timestamp}-${event.kind}-${index}`}
            className="grid gap-1 rounded border border-slate-800 bg-slate-950/80 p-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold",
                  getRalphProgressToneClassName(event),
                )}
              >
                {getRalphProgressKindLabel(event)}
              </span>
              <span className="min-w-0 truncate text-xs font-medium text-slate-300">
                {event.label}
              </span>
              {event.toolName ? (
                <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
                  {event.toolName}
                </span>
              ) : null}
              {event.complete ? (
                <span className="rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[0.62rem] font-semibold text-emerald-100">
                  complete
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-[0.62rem] text-slate-600">
                {formatRalphProgressTimestamp(event.timestamp)}
              </span>
            </div>
            {body ? (
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-900 bg-black/30 p-2 font-mono text-[0.7rem] leading-4 text-slate-300">
                {body}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

interface RalphOutputSectionsListProps {
  sections: RalphRunRecordBlock["outputSections"];
}

const RalphOutputSectionsList = ({
  sections,
}: RalphOutputSectionsListProps): JSX.Element => {
  if (!sections || sections.length === 0) {
    return (
      <div className="text-xs text-slate-500">
        No structured output sections were recorded.
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {sections.map((section, index) => (
        <details
          key={`${section.title}-${index}`}
          className="group rounded border border-slate-800 bg-slate-950/80 p-2"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-slate-200 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 truncate">{section.title}</span>
            <span className="flex shrink-0 items-center gap-1">
              {section.audience ? (
                <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-500">
                  {section.audience}
                </span>
              ) : null}
              <ChevronDown className="h-3.5 w-3.5 text-slate-500 transition group-open:rotate-180" />
            </span>
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-900 bg-black/30 p-2 font-mono text-[0.7rem] leading-4 text-slate-300">
            {section.lines.join("\n")}
          </pre>
        </details>
      ))}
    </div>
  );
};

interface RalphRunRecordBlockCardProps {
  block: RalphRunRecordBlock;
}

export const RalphRunRecordBlockCard = ({
  block,
}: RalphRunRecordBlockCardProps): JSX.Element => {
  const hasExpandedContent = Boolean(
    block.markdown ||
      block.response?.markdown ||
      block.reason ||
      block.outputSections?.length ||
      block.progress?.length ||
      block.executedTools?.length ||
      block.data !== undefined,
  );

  return (
    <details className="group rounded border border-slate-800 bg-slate-950 p-2">
      <summary className="grid cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-slate-200">
            {block.blockId}
          </span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold",
              getOutputChipClassName(block.output),
            )}
          >
            {block.output}
          </span>
          <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
            {block.status}
          </span>
          <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
            attempt {block.attempt}
          </span>
          {block.executionStatus ? (
            <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
              {block.executionStatus}
            </span>
          ) : null}
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-500 transition group-open:rotate-180" />
        </div>
        <div className="break-words text-xs text-slate-400">
          {block.summary}
        </div>
      </summary>

      <div className="mt-3 grid gap-3 border-t border-slate-800 pt-3">
        {block.error ? (
          <div className="break-words rounded border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-100">
            {block.error}
          </div>
        ) : null}
        {block.reason ? (
          <div className="break-words rounded border border-amber-400/30 bg-amber-500/10 p-2 text-xs text-amber-100">
            {block.reason}
          </div>
        ) : null}
        {block.executedTools && block.executedTools.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {block.executedTools.map((tool) => (
              <span
                key={tool}
                className="rounded border border-sky-400/30 bg-sky-500/10 px-1.5 py-0.5 text-[0.62rem] font-semibold text-sky-100"
              >
                {tool}
              </span>
            ))}
          </div>
        ) : null}
        {block.response?.markdown || block.markdown ? (
          <div className="grid gap-1">
            <div className="text-xs font-semibold text-slate-300">
              Final output
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-black/30 p-2 font-mono text-[0.72rem] leading-5 text-slate-300">
              {block.response?.markdown ?? block.markdown}
            </pre>
          </div>
        ) : null}
        {block.data !== undefined ? (
          <div className="grid gap-1">
            <div className="text-xs font-semibold text-slate-300">Data</div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-black/30 p-2 font-mono text-[0.7rem] leading-4 text-slate-300">
              {JSON.stringify(block.data, null, 2)}
            </pre>
          </div>
        ) : null}
        {hasExpandedContent ? (
          <div className="grid gap-2 md:grid-cols-2">
            <div className="grid gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                <Terminal className="h-3.5 w-3.5 text-slate-500" />
                Inside the node
              </div>
              <RalphBlockProgressList progress={block.progress} />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                Output sections
              </div>
              <RalphOutputSectionsList sections={block.outputSections} />
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            No deeper execution detail was recorded for this block.
          </div>
        )}
      </div>
    </details>
  );
};

interface ActiveRalphBlockDetailCardProps {
  detail: ActiveRalphRunBlockDetail;
}

export const ActiveRalphBlockDetailCard = ({
  detail,
}: ActiveRalphBlockDetailCardProps): JSX.Element => {
  return (
    <details className="group rounded border border-slate-800 bg-slate-950/80 p-2">
      <summary className="grid cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-slate-200">
            {detail.blockTitle ?? detail.blockId}
          </span>
          <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-500">
            {detail.blockId}
          </span>
          {detail.output ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold",
                getOutputChipClassName(detail.output),
              )}
            >
              {detail.output}
            </span>
          ) : null}
          {detail.attempt !== undefined ? (
            <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
              attempt {detail.attempt}
            </span>
          ) : null}
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-500 transition group-open:rotate-180" />
        </div>
        <div className="break-words text-xs text-slate-400">
          {detail.summary ??
            detail.progress.at(-1)?.label ??
            detail.events.at(-1)?.label ??
            "Waiting for node activity."}
        </div>
      </summary>
      <div className="mt-3 grid gap-3 border-t border-slate-800 pt-3">
        {detail.events.length > 0 ? (
          <div className="grid gap-1.5">
            <div className="text-xs font-semibold text-slate-300">
              Node events
            </div>
            {detail.events.slice(-8).map((event) => (
              <div
                key={event.id}
                className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-300"
              >
                <span
                  className={cn(
                    "mr-1 rounded border px-1 py-0.5 text-[0.62rem] font-semibold",
                    getRunEventToneClassName(event.tone),
                  )}
                >
                  {event.eventType}
                </span>
                {event.label}
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
            <Terminal className="h-3.5 w-3.5 text-slate-500" />
            Live inside the node
          </div>
          <RalphBlockProgressList progress={detail.progress} />
        </div>
      </div>
    </details>
  );
};
