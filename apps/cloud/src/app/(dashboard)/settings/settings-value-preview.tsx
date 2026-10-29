"use client";

import { useMemo, useState } from "react";
import { diffLines } from "@/lib/merge-settings";
import { canonicalJson } from "@/lib/settings-items";

const fieldLabels: Record<string, string> = {
  name: "Name",
  body: "Instruction",
  enabled: "Enabled",
  global: "Global",
  tags: "Tags",
  instructions: "Instructions",
  prompt: "Prompt",
  provider: "Provider",
  model: "Model",
  mode: "Mode",
  reasoning: "Reasoning",
  variables: "Variables",
  defaultValue: "Default",
  triggerPhrases: "Triggers",
  pathPatterns: "Paths",
  promptEnhancementMode: "Prompt enhancement",
  interviewEnabled: "Interview",
  sessionMemoryEnabled: "Session memory",
  useGlobalMemory: "Global memory",
  uiControlEnabled: "UI control",
  relativePath: "Path",
  content: "Prompt",
  title: "Title",
  transport: "Transport",
  type: "Type",
  command: "Command",
  args: "Arguments",
  env: "Environment",
  url: "URL",
  headers: "Headers",
  contextWindow: "Context window",
  temporary: "Temporary",
  useWorkspaceMemory: "Workspace memory",
};
const longTextFields = new Set(["body", "instructions", "prompt", "content"]);
/** Unchanged lines kept around each change in a text diff. */
const diffContext = 2;

export function fieldLabel(field: string): string {
  return fieldLabels[field] ?? field;
}

/** Labelled fields of an item, for example to list what stayed the same. */
export function labelledFields(value: unknown): string[] {
  return isRecord(value)
    ? Object.keys(value).filter((key) => fieldLabels[key])
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function SettingsValuePreview({
  value,
  comparison,
  fields,
  omitName = false,
  mapping = false,
}: {
  value: unknown;
  /** Hides fields that are equal in this value. */
  comparison?: unknown;
  /** Shows only these fields. */
  fields?: string[];
  omitName?: boolean;
  /** Render every key, as for environment variables or headers. */
  mapping?: boolean;
}): React.ReactElement {
  if (mapping && isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return <p>—</p>;
    return (
      <dl className="grid gap-1 font-mono text-xs">
        {entries.map(([key, entry]) => (
          <div key={key} className="break-words [overflow-wrap:anywhere]">
            <dt className="inline font-semibold">{key}: </dt>
            <dd className="inline">{String(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (Array.isArray(value)) {
    if (!value.length) return <p>—</p>;
    return (
      <div className="grid gap-1">
        {value.map((entry, index) => (
          <SettingsValuePreview key={index} value={entry} />
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    const compared = isRecord(comparison) ? comparison : null;
    return (
      <dl className="grid gap-2">
        {Object.entries(value)
          .filter(
            ([key, entry]) =>
              fieldLabels[key] &&
              (!fields || fields.includes(key)) &&
              (!omitName || (key !== "name" && key !== "relativePath")) &&
              (!compared ||
                canonicalJson(entry) !== canonicalJson(compared[key])),
          )
          .map(([key, entry]) => (
            <div key={key} className="min-w-0">
              <dt className="font-medium">{fieldLabels[key]}</dt>
              <dd className="min-w-0">
                <SettingsValuePreview
                  value={entry}
                  comparison={compared?.[key]}
                  mapping={key === "env" || key === "headers"}
                />
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {value === null || value === undefined
        ? "—"
        : typeof value === "boolean"
          ? value
            ? "On"
            : "Off"
          : String(value)}
    </p>
  );
}

/**
 * Shows only what `value` changes compared with `base`: long texts as line
 * diffs, other fields as their new values.
 */
export function SettingsChanges({
  value,
  base,
}: {
  value: unknown;
  base: unknown;
}): React.ReactElement {
  if (!isRecord(value) || !isRecord(base))
    return <SettingsValuePreview value={value} />;
  const changed = [
    ...new Set([...Object.keys(base), ...Object.keys(value)]),
  ].filter(
    (key) =>
      fieldLabels[key] &&
      canonicalJson(value[key]) !== canonicalJson(base[key]),
  );
  if (!changed.length)
    return <p className="text-muted-foreground">No differences.</p>;
  return (
    <dl className="grid min-w-0 gap-2">
      {changed.map((key) => {
        const before = base[key];
        const after = value[key];
        return (
          <div key={key} className="grid min-w-0 gap-1">
            <dt className="font-medium">{fieldLabels[key]}</dt>
            <dd className="min-w-0">
              {longTextFields.has(key) &&
              typeof before === "string" &&
              typeof after === "string" ? (
                <TextDiff before={before} after={after} />
              ) : (
                <SettingsValuePreview
                  value={after}
                  comparison={before}
                  mapping={key === "env" || key === "headers"}
                />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Collapsed list of fields that are the same in every version. */
export function UnchangedFields({
  value,
  fields,
}: {
  value: unknown;
  fields: string[];
}): React.ReactElement | null {
  const shown = fields.filter((field) => fieldLabels[field]);
  if (!shown.length) return null;
  return (
    <details className="min-w-0 text-sm">
      <summary className="cursor-pointer break-words text-xs text-muted-foreground">
        Unchanged: {shown.map(fieldLabel).join(", ")}
      </summary>
      <div className="mt-2 max-h-60 min-w-0 overflow-auto rounded-md bg-muted/40 p-2">
        <SettingsValuePreview value={value} fields={shown} />
      </div>
    </details>
  );
}

export function TextDiff({
  before,
  after,
}: {
  before: string;
  after: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  if (!diff)
    return (
      <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
        {after}
      </p>
    );
  const changed = diff.map((line) => line.type !== "same");
  const shown = diff.map(
    (_, index) =>
      expanded ||
      changed
        .slice(Math.max(0, index - diffContext), index + diffContext + 1)
        .some(Boolean),
  );
  const hidden = shown.filter((visible) => !visible).length;
  const rows: React.ReactNode[] = [];
  for (let index = 0; index < diff.length; index++) {
    if (!shown[index]) {
      let end = index;
      while (end + 1 < diff.length && !shown[end + 1]) end++;
      const count = end - index + 1;
      rows.push(
        <div key={index} className="px-2 text-muted-foreground">
          ⋯ {count} unchanged line{count === 1 ? "" : "s"}
        </div>,
      );
      index = end;
      continue;
    }
    const line = diff[index]!;
    rows.push(
      <div
        key={index}
        className={
          line.type === "added"
            ? "whitespace-pre-wrap break-words bg-emerald-500/15 px-2 text-foreground [overflow-wrap:anywhere]"
            : line.type === "removed"
              ? "whitespace-pre-wrap break-words bg-destructive/10 px-2 text-foreground line-through decoration-destructive/60 [overflow-wrap:anywhere]"
              : "whitespace-pre-wrap break-words px-2 text-muted-foreground [overflow-wrap:anywhere]"
        }
      >
        <span aria-hidden="true">
          {line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}
        </span>
        <span className="sr-only">
          {line.type === "added"
            ? "Added: "
            : line.type === "removed"
              ? "Removed: "
              : ""}
        </span>
        {line.text || " "}
      </div>,
    );
  }
  return (
    <div className="grid min-w-0 justify-items-start gap-1">
      <div
        role="group"
        aria-label="Line changes"
        className="w-full min-w-0 rounded border border-border bg-muted/40 py-1 font-mono text-xs leading-5"
      >
        {rows}
      </div>
      {hidden || expanded ? (
        <button
          type="button"
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show only changes" : "Show all lines"}
        </button>
      ) : null}
    </div>
  );
}
