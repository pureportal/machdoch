import type { ProductShell, ProductSnapshot } from "@machdoch/fleet-protocol";
import { FolderKanban, Layers3, ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { Tabs } from "radix-ui";
import { InspectorContextPacks } from "./inspector-context-packs";
import { InspectorTasks } from "./inspector-tasks";
import type { ProductCommandHandler } from "./product-runtime";

type InspectorTab = "tasks" | "context" | "workspaces";

export function Inspector({
  snapshot,
  shell,
  activeSessionId,
  pending,
  onCommand,
}: {
  snapshot: ProductSnapshot;
  shell: ProductShell;
  activeSessionId: string | undefined;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [tab, setTab] = useState<InspectorTab>("tasks");
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigate: ProductCommandHandler = async (command) => {
    if (pending) return false;
    setNavigationError(null);
    const accepted = await onCommand(command);
    if (!accepted) setNavigationError("Chat could not be opened. Try again.");
    return accepted;
  };
  return (
    <Tabs.Root
      asChild
      value={tab}
      onValueChange={(value) => setTab(value as InspectorTab)}
    >
      <aside className="m-product-inspector" aria-label="Activity">
        <Tabs.List
          className="m-product-inspector-tabs"
          aria-label="Activity views"
        >
          <Tab value="tasks" label="Tasks" icon={<ListChecks />} />
          <Tab value="context" label="Context" icon={<Layers3 />} />
          <Tab value="workspaces" label="Workspaces" icon={<FolderKanban />} />
        </Tabs.List>
        <Tabs.Content value={tab} className="m-product-inspector-content">
          {navigationError ? (
            <p role="alert" className="m-product-inline-error">
              {navigationError}
            </p>
          ) : null}
          {tab === "tasks" ? (
            <InspectorTasks
              snapshot={snapshot}
              pending={pending}
              onCommand={onCommand}
              onOpenChat={(sessionId) =>
                navigate({ kind: "activate-session", sessionId })
              }
            />
          ) : null}
          {tab === "context" ? (
            <InspectorContextPacks
              shell={shell}
              activeSessionId={activeSessionId}
              pending={pending}
              onCommand={onCommand}
            />
          ) : null}
          {tab === "workspaces" ? (
            <Workspaces shell={shell} pending={pending} onCommand={navigate} />
          ) : null}
        </Tabs.Content>
      </aside>
    </Tabs.Root>
  );
}

function Workspaces({
  shell,
  pending,
  onCommand,
}: {
  shell: ProductShell;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  if (!shell.workspaces.length) {
    return <p className="m-product-empty-small">No workspaces</p>;
  }
  return (
    <div className="m-product-card-list">
      {shell.workspaces.map((workspace) => (
        <article key={workspace.root} className="m-product-card">
          <div className="m-product-card-heading">
            <strong>{workspace.label}</strong>
            <span>{workspace.sessionCount}</span>
          </div>
          <p title={workspace.root}>{workspace.root}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void onCommand({
                kind: "create-session",
                workspace: workspace.root,
              })
            }
          >
            <Plus aria-hidden="true" />
            New chat
          </button>
        </article>
      ))}
    </div>
  );
}

function Tab({
  value,
  icon,
  label,
}: {
  value: InspectorTab;
  icon: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <Tabs.Trigger
      type="button"
      value={value}
      onFocus={(event) =>
        event.currentTarget.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        })
      }
    >
      {icon}
      <span>{label}</span>
    </Tabs.Trigger>
  );
}
