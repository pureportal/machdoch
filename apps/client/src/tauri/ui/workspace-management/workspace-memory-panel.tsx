import { MemoryManagementTable } from "@machdoch/product-ui";
import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import type { ConversationMemoryEntry } from "../../../core/types.js";
import {
  createMemoryManagementEntries,
  type MemorySourceSession,
} from "../components/memory-management-entries";

export const WorkspaceMemoryPanel = ({
  entries,
  sourceSessions,
  loading,
  disabled,
  error,
  onForget,
}: {
  entries: readonly ConversationMemoryEntry[];
  sourceSessions: readonly MemorySourceSession[];
  loading: boolean;
  disabled: boolean;
  error: string | null;
  onForget: (id: string) => Promise<unknown> | unknown;
}): JSX.Element => (
  <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
    <h3 className="text-sm font-medium text-slate-200">Workspace memory</h3>
    {error ? (
      <p role="alert" className="text-sm text-red-300">
        {error}
      </p>
    ) : null}
    {loading ? (
      <div
        role="status"
        aria-label="Loading workspace memory"
        className="grid h-24 place-items-center"
      >
        <LoaderCircle className="size-5 animate-spin text-slate-500" />
      </div>
    ) : (
      <MemoryManagementTable
        entries={createMemoryManagementEntries(entries, sourceSessions)}
        emptyLabel="No workspace memory saved."
        disabled={disabled}
        onForget={onForget}
      />
    )}
  </section>
);
