"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, KeyRound, Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import { holderCan } from "@/lib/cloud-permissions";
import {
  pipelineSourceLabels,
  type CloudPipeline,
  type CreatedPipeline,
} from "@/lib/cloud-release-pipeline-contract";
import { cloudRequest } from "./api-client";
import { PipelineFormDialog } from "./pipeline-form-dialog";
import { PipelineWebhookDialog } from "./pipeline-webhook-dialog";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

export function PipelineDetail({
  workspace,
  repositories,
  pipeline,
  policies,
}: {
  workspace: CloudWorkspace;
  repositories: GitRepositoryOption[];
  pipeline: CloudPipeline;
  policies: { teamId: string; completeOnRelease: boolean }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = holderCan(workspace.actor, "releases.edit");
  const canManageTeams = holderCan(workspace.actor, "teams.manage");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      router.refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Try again.", "error");
    } finally {
      setBusy(false);
    }
  }
  function toggleArchived() {
    return run(async () => {
      await cloudRequest<CreatedPipeline>(`release-pipelines/${pipeline.id}`, {
        method: "PATCH",
        body: {
          name: pipeline.name,
          teamIds: pipeline.teams.map((team) => team.id),
          repositoryId: pipeline.repositoryId,
          paths: pipeline.paths,
          type: pipeline.type,
          source: pipeline.source,
          environments: pipeline.environments,
          revision: pipeline.revision,
          archived: !pipeline.archived,
        },
      });
    });
  }
  function rotateWebhook() {
    return run(async () => {
      const result = await cloudRequest<CreatedPipeline>(
        `release-pipelines/${pipeline.id}/webhook`,
        { method: "POST" },
      );
      setToken(result.webhookToken);
    });
  }
  function setPolicy(teamId: string, completeOnRelease: boolean) {
    return run(async () => {
      await cloudRequest(`release-policies/${teamId}`, {
        method: "PUT",
        body: { completeOnRelease },
      });
    });
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>
          <Link href="/cloud/releases/pipelines">Pipelines</Link> ›{" "}
          {pipeline.name}
        </h1>
        {canWrite && (
          <div className="cloud-release-actions">
            {pipeline.source === "webhook" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void rotateWebhook()}
              >
                <KeyRound />
                Rotate webhook
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void toggleArchived()}
            >
              {pipeline.archived ? <ArchiveRestore /> : <Archive />}
              {pipeline.archived ? "Restore" : "Archive"}
            </Button>
            <Button disabled={busy} onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
          </div>
        )}
      </header>
      <dl className="cloud-pipeline-fields">
        <dt>Teams</dt>
        <dd>{pipeline.teams.map((team) => team.name).join(", ")}</dd>
        <dt>Type</dt>
        <dd>{pipeline.type === "continuous" ? "Continuous" : "Scheduled"}</dd>
        <dt>Source</dt>
        <dd>{pipelineSourceLabels[pipeline.source]}</dd>
        {pipeline.repository && (
          <>
            <dt>Repository</dt>
            <dd>{pipeline.repository}</dd>
          </>
        )}
        {pipeline.paths.length > 0 && (
          <>
            <dt>Paths</dt>
            <dd>
              {pipeline.paths.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </dd>
          </>
        )}
        <dt>Environments</dt>
        <dd>{pipeline.environments.join(" → ")}</dd>
      </dl>
      <section className="cloud-pipeline-section" aria-labelledby="policy">
        <h2 id="policy">Complete issues on release</h2>
        {pipeline.teams.map((team) => {
          const policy = policies.find((entry) => entry.teamId === team.id);
          return (
            <label key={team.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policy?.completeOnRelease ?? false}
                disabled={!canManageTeams || busy}
                onChange={(event) =>
                  void setPolicy(team.id, event.target.checked)
                }
              />
              {team.name}
            </label>
          );
        })}
      </section>
      <section className="cloud-pipeline-section" aria-labelledby="releases">
        <h2 id="releases">Releases</h2>
        {!pipeline.releases.length ? (
          <div className="cloud-empty">
            <p>No releases yet.</p>
          </div>
        ) : (
          <ul className="cloud-release-list" aria-labelledby="releases">
            {pipeline.releases.map((release) => (
              <li key={release.id}>
                <Link
                  href={`/cloud/releases/pipelines/${pipeline.id}/${release.id}`}
                >
                  <span className="cloud-release-title">
                    <strong>{release.version}</strong>
                    <span>{release.environment}</span>
                  </span>
                  <span className="cloud-release-meta">
                    <span title="Issues">{release.issueCount}</span>
                    {release.toSha && (
                      <code title="Commit">{release.toSha.slice(0, 7)}</code>
                    )}
                  </span>
                  <span className="cloud-release-updated">
                    <RelativeTime value={release.deployedAt} compact />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && (
        <PipelineFormDialog
          workspace={workspace}
          repositories={repositories}
          pipeline={pipeline}
          onClose={() => setEditing(false)}
          onSaved={(result) => {
            if (result.webhookToken) setToken(result.webhookToken);
            router.refresh();
          }}
        />
      )}
      {token && (
        <PipelineWebhookDialog token={token} onClose={() => setToken(null)} />
      )}
    </>
  );
}
