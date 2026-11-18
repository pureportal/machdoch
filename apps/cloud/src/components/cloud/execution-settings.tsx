"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Cpu,
  FolderKanban,
  GitBranch,
  ListChecks,
  Plus,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { CloudAiProvider } from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import type { ExecutionSandbox } from "@machdoch/fleet-protocol/cloud-sandbox";
import { Button } from "@/components/ui/button";
import { ExecutionProfileForm } from "./execution-profile-form";
import { ExecutionRunners } from "./execution-runners";
import { ExecutionSandboxSettings } from "./execution-sandbox";
import { cloudRequest } from "./api-client";
import { executionTargetLabels, profileAgentLabel } from "./execution-labels";

function repositoryName(url: string): string {
  return new URL(url).pathname.slice(1).replace(/\.git$/, "");
}

export function ExecutionSettings({
  workspace,
  profiles,
  providers,
  focusProjectId,
}: {
  workspace: CloudWorkspace;
  profiles: ExecutionProfile[];
  providers: CloudAiProvider[];
  focusProjectId: string | null;
}) {
  const router = useRouter();
  const focused = workspace.projects.some(
    (project) => project.id === focusProjectId,
  )
    ? focusProjectId
    : null;
  const [editing, setEditing] = useState<ExecutionProfile | "new" | null>(() =>
    focused
      ? (profiles.find((profile) => profile.projectId === focused) ?? "new")
      : null,
  );
  const [selected, setSelected] = useState<ExecutionProfile | null>(null);
  const [sandbox, setSandbox] = useState<ExecutionSandbox | null>(null);
  const [sandboxError, setSandboxError] = useState("");
  useEffect(() => {
    cloudRequest<{ sandbox: ExecutionSandbox | null }>("execution-sandbox")
      .then((result) => setSandbox(result.sandbox))
      .catch((reason: Error) => setSandboxError(reason.message));
  }, []);
  return (
    <>
      <header className="cloud-page-header">
        <h1>AI setup</h1>
        {workspace.projects.length > 0 && (
          <Button onClick={() => setEditing("new")}>
            <Plus />
            Set up a project
          </Button>
        )}
      </header>
      {!profiles.length ? (
        <div className="cloud-empty">
          <Workflow aria-hidden="true" />
          <p>
            {workspace.projects.length
              ? "Connect a repository so AI can work on your issues."
              : "Create a project first."}
          </p>
          {workspace.projects.length > 0 && (
            <Button onClick={() => setEditing("new")}>Set up a project</Button>
          )}
        </div>
      ) : (
        <div className="cloud-grid">
          {profiles.map((entry) => (
            <section className="cloud-card cloud-setup-card" key={entry.id}>
              <div className="cloud-card-heading">
                <span className="cloud-icon-tile">
                  <Workflow size={20} aria-hidden="true" />
                </span>
                {entry.autopilot && entry.enabled && (
                  <span className="cloud-task-state" data-state="running">
                    <Sparkles size={12} aria-hidden="true" /> Autopilot
                  </span>
                )}
                {!entry.enabled && (
                  <span className="cloud-task-state" data-state="paused">
                    Paused
                  </span>
                )}
              </div>
              <h2>{repositoryName(entry.repository)}</h2>
              <div className="cloud-card-metadata">
                <span>
                  <FolderKanban size={14} aria-hidden="true" />
                  {
                    workspace.projects.find(
                      (project) => project.id === entry.projectId,
                    )?.name
                  }
                </span>
                <span>
                  <GitBranch size={14} aria-hidden="true" />
                  {entry.branch ?? "Default branch"}
                </span>
                <span>
                  <ListChecks size={14} aria-hidden="true" />
                  {entry.requiredChecks.length
                    ? `${entry.requiredChecks.length} ${entry.requiredChecks.length === 1 ? "check" : "checks"}`
                    : "No checks"}
                </span>
                <span>
                  <Cpu size={14} aria-hidden="true" />
                  {profileAgentLabel(entry)}
                  {entry.target !== "cloud" &&
                    ` · ${executionTargetLabels[entry.target]}`}
                </span>
              </div>
              <div className="cloud-card-actions">
                <Button variant="outline" onClick={() => setEditing(entry)}>
                  Edit
                </Button>
                <Button
                  variant="outline"
                  aria-pressed={selected?.id === entry.id}
                  onClick={() =>
                    setSelected(selected?.id === entry.id ? null : entry)
                  }
                >
                  Runners
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
      {selected && <ExecutionRunners profile={selected} sandbox={sandbox} />}
      {sandboxError && (
        <p role="alert" className="cloud-error mt-8">
          {sandboxError}
        </p>
      )}
      {sandbox && (
        <ExecutionSandboxSettings sandbox={sandbox} onSaved={setSandbox} />
      )}
      <ExecutionProfileForm
        open={editing !== null}
        profile={editing && editing !== "new" ? editing : null}
        projectId={editing === "new" && focused ? focused : undefined}
        workspace={workspace}
        providers={providers}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setSelected(null);
          router.refresh();
        }}
      />
    </>
  );
}
