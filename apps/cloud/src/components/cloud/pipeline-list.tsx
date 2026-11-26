"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { GitRepositoryOption } from "@/lib/cloud-git-contract";
import { holderCan } from "@/lib/cloud-permissions";
import {
  pipelineSourceLabels,
  type PipelineSummary,
} from "@/lib/cloud-release-pipeline-contract";
import { cloudRequest } from "./api-client";
import { PipelineFormDialog } from "./pipeline-form-dialog";
import { PipelineWebhookDialog } from "./pipeline-webhook-dialog";
import { RelativeTime } from "./relative-time";
import { useToast } from "./toast";

export function PipelineList({
  workspace,
  repositories,
  initial,
}: {
  workspace: CloudWorkspace;
  repositories: GitRepositoryOption[];
  initial: PipelineSummary[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pipelines, setPipelines] = useState(initial);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(
    null,
  );
  const canWrite = holderCan(workspace.actor, "releases.edit");
  useEffect(() => {
    if (!query && !archived) {
      setPipelines(initial);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ query, archived: String(archived) });
      cloudRequest<PipelineSummary[]>(`release-pipelines?${params}`, {
        signal: controller.signal,
      })
        .then(setPipelines)
        .catch((reason: Error) => {
          if (!controller.signal.aborted) toast(reason.message, "error");
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, archived, initial, toast]);
  return (
    <>
      <header className="cloud-page-header">
        <h1>Pipelines</h1>
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New pipeline
          </Button>
        )}
      </header>
      <div className="cloud-release-filter" role="group" aria-label="Filter">
        <label className="cloud-pipeline-search">
          <Search size={13} aria-hidden="true" />
          <Input
            type="search"
            value={query}
            placeholder="Filter by name"
            aria-label="Name"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="cloud-automation-spacer" />
        <div className="cloud-segmented" role="group" aria-label="State">
          <button
            type="button"
            aria-pressed={!archived}
            onClick={() => setArchived(false)}
          >
            Active
          </button>
          <button
            type="button"
            aria-pressed={archived}
            onClick={() => setArchived(true)}
          >
            Archived
          </button>
        </div>
      </div>
      {!pipelines.length ? (
        <div className="cloud-empty">
          <Workflow aria-hidden="true" />
          <p>
            {query || archived ? "No matching pipelines." : "No pipelines yet."}
          </p>
        </div>
      ) : (
        <div className="cloud-table-scroll">
          <table className="cloud-pipeline-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Teams</th>
                <th scope="col">Type</th>
                <th scope="col">Source</th>
                <th scope="col">Environments</th>
                <th scope="col">Releases</th>
                <th scope="col">Latest release</th>
              </tr>
            </thead>
            <tbody>
              {pipelines.map((pipeline) => (
                <tr key={pipeline.id}>
                  <th scope="row">
                    <Link href={`/cloud/releases/pipelines/${pipeline.id}`}>
                      {pipeline.name}
                    </Link>
                    {pipeline.repository && <span>{pipeline.repository}</span>}
                  </th>
                  <td>{pipeline.teams.map((team) => team.key).join(", ")}</td>
                  <td>
                    {pipeline.type === "continuous"
                      ? "Continuous"
                      : "Scheduled"}
                  </td>
                  <td>{pipelineSourceLabels[pipeline.source]}</td>
                  <td>{pipeline.environments.join(" → ")}</td>
                  <td>{pipeline.releaseCount}</td>
                  <td>
                    {pipeline.latestRelease ? (
                      <Link
                        href={`/cloud/releases/pipelines/${pipeline.id}/${pipeline.latestRelease.id}`}
                      >
                        {pipeline.latestRelease.version} ·{" "}
                        {pipeline.latestRelease.environment} ·{" "}
                        <RelativeTime
                          value={pipeline.latestRelease.deployedAt}
                          compact
                        />
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <PipelineFormDialog
          workspace={workspace}
          repositories={repositories}
          pipeline={null}
          onClose={() => setCreating(false)}
          onSaved={(result) => {
            if (result.webhookToken)
              setCreated({ id: result.id, token: result.webhookToken });
            else router.push(`/cloud/releases/pipelines/${result.id}`);
            router.refresh();
          }}
        />
      )}
      {created && (
        <PipelineWebhookDialog
          token={created.token}
          onClose={() => {
            router.push(`/cloud/releases/pipelines/${created.id}`);
            setCreated(null);
          }}
        />
      )}
    </>
  );
}
