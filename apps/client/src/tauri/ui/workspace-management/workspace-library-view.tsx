import { useCallback, useState, type JSX } from "react";
import { Tabs } from "radix-ui";
import { WorkspaceKnowledgePanel } from "./workspace-knowledge-panel";
import { WorkspaceResearchPanel } from "./workspace-research-panel";

export function WorkspaceLibraryView({
  roots,
  workspaceRoot,
  onWorkspaceChange,
  onDirtyChange,
}: {
  roots: string[];
  workspaceRoot: string | null;
  onWorkspaceChange: (root: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"knowledge" | "research">("knowledge");
  const [dirty, setDirty] = useState(false);
  const updateDirty = useCallback(
    (value: boolean): void => {
      setDirty(value);
      onDirtyChange(value);
    },
    [onDirtyChange],
  );
  const change = (action: () => void): void => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    updateDirty(false);
    action();
  };
  return (
    <main className="mx-auto min-h-0 w-full max-w-5xl flex-1 space-y-4 overflow-y-auto p-4">
      <select
        aria-label="Workspace"
        className="w-full rounded border border-slate-700 bg-slate-950 p-2"
        value={workspaceRoot ?? ""}
        onChange={(event) =>
          change(() => onWorkspaceChange(event.target.value))
        }
      >
        {!workspaceRoot && <option value="">Select workspace</option>}
        {roots.map((root) => (
          <option key={root} value={root}>
            {root}
          </option>
        ))}
      </select>
      <Tabs.Root
        value={tab}
        activationMode="manual"
        onValueChange={(value) => change(() => setTab(value as typeof tab))}
      >
        <Tabs.List aria-label="Workspace library" className="mb-4 flex gap-2">
          {(["knowledge", "research"] as const).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={`rounded px-3 py-2 text-sm ${tab === value ? "bg-slate-800" : "text-slate-400"}`}
            >
              {value === "knowledge" ? "Knowledge" : "Research"}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="knowledge">
          {workspaceRoot && (
            <WorkspaceKnowledgePanel
              key={workspaceRoot}
              workspaceRoot={workspaceRoot}
            />
          )}
        </Tabs.Content>
        <Tabs.Content value="research">
          {workspaceRoot && (
            <WorkspaceResearchPanel
              key={workspaceRoot}
              workspaceRoot={workspaceRoot}
              onDirtyChange={updateDirty}
            />
          )}
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}
