import { Cpu, GitBranch, Workflow } from "lucide-react";
import type { RunDetail } from "@machdoch/fleet-protocol/cloud-execution";
import { clientAgentLabels, executionTargetLabels } from "./execution-labels";
import { Timestamp } from "./timestamp";

export function TaskExecution({ run }: { run: RunDetail }) {
  const { profile, provider } = run.manifest;
  return (
    <aside className="cloud-task-sidebar" aria-label="Task execution">
      <section className="cloud-card">
        <h2>
          <Workflow size={16} aria-hidden="true" />
          Execution
        </h2>
        <dl className="cloud-task-properties">
          <div>
            <dt>Setup</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>Runs on</dt>
            <dd>{executionTargetLabels[profile.target]}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <Timestamp value={run.createdAt} />
            </dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>
              <Timestamp value={run.deadlineAt} />
            </dd>
          </div>
        </dl>
      </section>
      <section className="cloud-card">
        <h2>
          <Cpu size={16} aria-hidden="true" />
          Model
        </h2>
        <dl className="cloud-task-properties">
          {profile.target === "client" ? (
            <div>
              <dt>Agent</dt>
              <dd>{clientAgentLabels[profile.agent]}</dd>
            </div>
          ) : (
            <div>
              <dt>Provider</dt>
              <dd>{provider?.name}</dd>
            </div>
          )}
          {profile.model && (
            <div>
              <dt>Model</dt>
              <dd>{profile.model}</dd>
            </div>
          )}
          <div>
            <dt>Token limit</dt>
            <dd>{profile.maxTokens.toLocaleString()}</dd>
          </div>
          {run.usage.usedTokens > 0 && (
            <div>
              <dt>Tokens used</dt>
              <dd>{run.usage.usedTokens.toLocaleString()}</dd>
            </div>
          )}
          {run.usage.reservedTokens > 0 && (
            <div>
              <dt>Tokens reserved</dt>
              <dd>{run.usage.reservedTokens.toLocaleString()}</dd>
            </div>
          )}
        </dl>
      </section>
      <section className="cloud-card">
        <h2>
          <GitBranch size={16} aria-hidden="true" />
          Source
        </h2>
        <dl className="cloud-task-properties">
          <div>
            <dt>Repository</dt>
            <dd>
              {new URL(profile.repository).pathname
                .slice(1)
                .replace(/\.git$/, "")}
            </dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{run.manifest.branch ?? "Default branch"}</dd>
          </div>
          {run.baseCommit && (
            <div>
              <dt>Started from</dt>
              <dd className="font-mono text-xs" title={run.baseCommit}>
                {run.baseCommit.slice(0, 7)}
              </dd>
            </div>
          )}
          {run.delivery && (
            <div>
              <dt>
                {run.delivery.kind === "check"
                  ? "Pull request branch"
                  : "Change branch"}
              </dt>
              <dd className="font-mono text-xs">{run.delivery.branch}</dd>
            </div>
          )}
          {profile.workspacePath && (
            <div>
              <dt>Directory</dt>
              <dd>{profile.workspacePath}</dd>
            </div>
          )}
        </dl>
      </section>
    </aside>
  );
}
