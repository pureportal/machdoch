"use client";

import { holderCan } from "@/lib/cloud-permissions";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, FolderKanban } from "lucide-react";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";

export function IssueDelegate({
  issue,
  workspace,
  onAssign,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  onAssign: (changes: IssueChangeSet) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [projects, setProjects] = useState<Set<string> | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<{ profiles: ExecutionProfile[] }>("execution-profiles", {
      signal: abort.signal,
    })
      .then((result) =>
        setProjects(
          new Set(
            result.profiles
              .filter((profile) => profile.enabled)
              .map((profile) => profile.projectId),
          ),
        ),
      )
      .catch((reason: Error) => {
        if (abort.signal.aborted) return;
        setProjects(new Set());
        toast(reason.message, "error");
      });
    return () => abort.abort();
  }, [toast]);
  if (issue.aiAssigned) return null;
  const button = (
    <Button variant="ghost" size="sm" disabled={!projects}>
      <Bot />
      Assign to AI
    </Button>
  );
  if (!projects) return button;
  const assign = () => onAssign({ aiAssigned: true });
  if (issue.projectId && projects.has(issue.projectId))
    return (
      <Button variant="ghost" size="sm" onClick={assign}>
        <Bot />
        Assign to AI
      </Button>
    );
  const candidates = issue.projectId
    ? []
    : workspace.projects.filter(
        (project) =>
          project.teamId === issue.teamId && projects.has(project.id),
      );
  if (candidates.length)
    return (
      <PropertyMenu
        label="Assign to AI in project"
        align="end"
        options={candidates.map((project) => ({
          value: project.id,
          label: project.name,
          icon: <FolderKanban size={14} aria-hidden="true" />,
        }))}
        onSelect={(projectId) => onAssign({ projectId, aiAssigned: true })}
      >
        {button}
      </PropertyMenu>
    );
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        holderCan(workspace.actor, "ai.manage")
          ? router.push("/cloud/execution")
          : toast(
              issue.projectId
                ? "Ask an administrator to set up AI for this project."
                : "Add the issue to a project with AI set up.",
            )
      }
    >
      <Bot />
      Assign to AI
    </Button>
  );
}
