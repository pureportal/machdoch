import { Cpu, GitBranch, Workflow } from "lucide-react";
import type { RunDetail } from "@machdoch/fleet-protocol/cloud-execution";
import { executionTargetLabels } from "./execution-labels";
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
            <dt>Profile</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>Target</dt>
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
          <div>
            <dt>Provider</dt>
            <dd>{provider.name}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{profile.model}</dd>
          </div>
          <div>
            <dt>Token limit</dt>
            <dd>{profile.maxTokens.toLocaleString()}</dd>
          </div>
          {run.usage.requests > 0 && (
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
      <details className="cloud-card cloud-task-repository">
        <summary>
          <GitBranch size={16} aria-hidden="true" />
          Repository
        </summary>
        <dl className="cloud-task-properties">
          <div>
            <dt>Repository</dt>
            <dd>{profile.repository}</dd>
          </div>
          {profile.workspacePath && (
            <div>
              <dt>Directory</dt>
              <dd>{profile.workspacePath}</dd>
            </div>
          )}
          <div>
            <dt>Base commit</dt>
            <dd className="font-mono text-xs">{profile.baseCommit}</dd>
          </div>
        </dl>
      </details>
    </aside>
  );
}
