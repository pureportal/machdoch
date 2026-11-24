import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  csvDelimiter,
  flattenJsonTree,
  parseCsv,
  parseJsonPreview,
  type StructuredPreviewKind,
} from "./workspace-file-structured-preview";

const CsvPreview = ({
  name,
  text,
}: {
  name: string;
  text: string;
}): JSX.Element => {
  const table = useMemo(
    () => parseCsv(text, csvDelimiter(name, text)),
    [name, text],
  );
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-collapse text-left font-mono text-[11px] text-slate-300">
        <thead className="sticky top-0 bg-slate-900">
          <tr>
            {table.header.map((cell, index) => (
              <th
                key={index}
                className="border-b border-slate-700 px-2 py-1 font-medium whitespace-nowrap text-slate-100"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-slate-900/30">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="max-w-80 truncate border-b border-slate-800/60 px-2 py-0.5"
                  title={cell}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated ? (
        <p className="px-2 py-2 text-[11px] text-slate-500">
          Showing the first {table.rows.length} rows.
        </p>
      ) : null}
    </div>
  );
};

const KIND_COLORS: Record<string, string> = {
  string: "text-emerald-300",
  number: "text-sky-300",
  boolean: "text-violet-300",
  null: "text-slate-500",
};

const JsonPreview = ({ text }: { text: string }): JSX.Element => {
  const parsed = useMemo(() => parseJsonPreview(text), [text]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  const tree = useMemo(
    () => ("value" in parsed ? flattenJsonTree(parsed.value, expanded) : null),
    [expanded, parsed],
  );
  if (!tree) {
    return (
      <p role="alert" className="p-3 text-xs text-red-300">
        {"error" in parsed ? parsed.error : null}
      </p>
    );
  }
  const toggle = (path: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <ul className="h-full overflow-auto py-1 font-mono text-[12px]" role="tree">
      {tree.nodes.map((node) => {
        const open = expanded.has(node.path);
        const branch = node.childCount > 0;
        return (
          <li
            key={node.path || "root"}
            role="treeitem"
            aria-expanded={branch ? open : undefined}
            style={{ paddingLeft: `${node.depth * 14 + 6}px` }}
            className="flex items-center gap-1 whitespace-nowrap"
          >
            {branch ? (
              <button
                type="button"
                aria-label={open ? "Collapse" : "Expand"}
                onClick={() => toggle(node.path)}
                className="text-slate-500 hover:text-slate-200"
              >
                {open ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            ) : (
              <span className="w-3" />
            )}
            {node.key ? (
              <span className="text-slate-300">{node.key}:</span>
            ) : null}
            <span className={cn(KIND_COLORS[node.kind] ?? "text-slate-500")}>
              {node.summary}
            </span>
          </li>
        );
      })}
      {tree.truncated ? (
        <li className="px-2 py-1 text-[11px] text-slate-500">
          Too many entries to show.
        </li>
      ) : null}
    </ul>
  );
};

export const WorkspaceStructuredPreview = ({
  kind,
  name,
  text,
}: {
  kind: StructuredPreviewKind;
  name: string;
  text: string;
}): JSX.Element =>
  kind === "csv" ? (
    <CsvPreview name={name} text={text} />
  ) : (
    <JsonPreview text={text} />
  );
