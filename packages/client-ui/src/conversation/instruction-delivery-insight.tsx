import type { JSX } from "react";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const records = (value: unknown): UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const text = (value: unknown, fallback = "unknown"): string =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const sourceLocation = (source: UnknownRecord): string => {
  if (typeof source.assignmentPath === "string") {
    if (source.assignmentPath === "global") return "Global";
    if (source.assignmentPath === "tags") return "Tag match";
    if (source.assignmentPath === ".") return "Workspace";
    return `Workspace path ${source.assignmentPath}`;
  }
  if (typeof source.profileId === "string") {
    return `file:${source.profileId}`;
  }
  return text(source.scopePath, ".");
};

export interface InstructionDeliveryInsightProps {
  metadata: Record<string, unknown> | undefined;
}

export const InstructionDeliveryInsight = ({
  metadata,
}: InstructionDeliveryInsightProps): JSX.Element | null => {
  if (!metadata || typeof metadata.instructionResolutionId !== "string") {
    return null;
  }

  const sources = records(metadata.instructionSources);

  return (
    <details className="app-instruction-delivery-insight basis-full rounded-lg border border-cyan-400/20 bg-slate-950/75 px-3 py-2 text-xs text-slate-300">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 font-semibold text-cyan-100 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 [&::-webkit-details-marker]:hidden">
        <span>Instructions used</span>
        <span className="font-normal text-slate-500">{sources.length}</span>
      </summary>

      <div className="mt-3 border-t border-slate-800 pt-3">
        {sources.length > 0 ? (
          <ol className="grid list-decimal gap-2 pl-5">
            {sources.map((source, index) => (
              <li
                key={`${text(source.id, "source")}:${index}`}
                className="pl-1 text-slate-400"
              >
                <span className="text-slate-200">
                  {text(source.name, text(source.kind))}
                </span>
                <span className="block text-[10px] text-slate-500">
                  {sourceLocation(source)} · scope {text(source.scopePath, ".")}
                  {number(source.precedence) === undefined
                    ? ""
                    : ` · precedence ${number(source.precedence)}`}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-slate-500">No instructions were used.</p>
        )}
      </div>
    </details>
  );
};
