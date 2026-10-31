"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, Laptop, LoaderCircle } from "lucide-react";
import type { ExecutionProfile } from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "./api-client";
import { profileAgentLabel } from "./execution-labels";
import { PropertyMenu } from "./property-menu";
import { useToast } from "./toast";

export function IssueDelegate({
  issue,
  workspace,
  onBeforeStart,
}: {
  issue: CloudIssue;
  workspace: CloudWorkspace;
  onBeforeStart: (projectId: string) => Promise<number>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [profiles, setProfiles] = useState<ExecutionProfile[] | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<{ profiles: ExecutionProfile[] }>("execution-profiles", {
      signal: abort.signal,
    })
      .then((result) =>
        setProfiles(result.profiles.filter((profile) => profile.enabled)),
      )
      .catch((reason: Error) => {
        if (abort.signal.aborted) return;
        setProfiles([]);
        toast(reason.message, "error");
      });
    return () => abort.abort();
  }, [toast]);
  if (!profiles)
    return (
      <Button variant="ghost" size="sm" disabled>
        <Bot />
        Delegate
      </Button>
    );
  const available = profiles.filter(
    (profile) =>
      profile.teamId === issue.teamId &&
      (!issue.projectId || profile.projectId === issue.projectId),
  );
  async function start(profileId: string) {
    const profile = available.find((entry) => entry.id === profileId)!;
    setStarting(true);
    try {
      const revision =
        issue.projectId === profile.projectId
          ? issue.revision
          : await onBeforeStart(profile.projectId);
      const run = await cloudRequest<{ id: string }>("runs", {
        method: "POST",
        key: crypto.randomUUID(),
        body: {
          profileId,
          subject: { kind: "issue", id: issue.id, revision },
        },
      });
      router.push(`/cloud/tasks/${run.id}`);
    } catch (reason) {
      toast((reason as Error).message, "error");
      setStarting(false);
    }
  }
  if (!available.length) {
    const administrator = ["owner", "admin"].includes(workspace.actor.role);
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          administrator
            ? router.push("/cloud/execution")
            : toast("Ask an administrator to configure AI execution.")
        }
      >
        <Bot />
        Delegate
      </Button>
    );
  }
  return (
    <PropertyMenu
      label="Delegate to"
      align="end"
      options={available.map((profile) => {
        const project = workspace.projects.find(
          (entry) => entry.id === profile.projectId,
        );
        return {
          value: profile.id,
          label: `${profile.name} · ${profileAgentLabel(profile)}`,
          group:
            profile.target === "cloud"
              ? "Cloud sandbox"
              : `Connected client${issue.projectId ? "" : ` · ${project?.name ?? ""}`}`,
          icon:
            profile.target === "cloud" ? (
              <Bot size={14} aria-hidden="true" />
            ) : (
              <Laptop size={14} aria-hidden="true" />
            ),
        };
      })}
      onSelect={(value) => void start(value)}
    >
      <Button variant="ghost" size="sm" disabled={starting}>
        {starting ? <LoaderCircle className="animate-spin" /> : <Bot />}
        Delegate
      </Button>
    </PropertyMenu>
  );
}
