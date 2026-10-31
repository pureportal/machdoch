"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Workflow } from "lucide-react";
import {
  isCloudCliProvider,
  type CloudAiProvider,
} from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  clientAgents,
  type ExecutionProfile,
  type ExecutionWorker,
} from "@machdoch/fleet-protocol/cloud-execution";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ExecutionChecks, type CheckDraft } from "./execution-checks";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import {
  clientAgentLabels,
  executionTargetLabels,
  profileAgentLabel,
} from "./execution-labels";

export function ExecutionSettings({
  workspace,
  profiles,
  providers,
}: {
  workspace: CloudWorkspace;
  profiles: ExecutionProfile[];
  providers: CloudAiProvider[];
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState<ExecutionProfile | "new" | null>(null);
  const [enrolling, setEnrolling] = useState<ExecutionProfile | null>(null);
  const [selected, setSelected] = useState<ExecutionProfile | null>(null);
  const [workers, setWorkers] = useState<ExecutionWorker[]>([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const workerRequest = useRef(0);
  const [revoking, setRevoking] = useState<ExecutionWorker | null>(null);
  const [rotating, setRotating] = useState<ExecutionWorker | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [target, setTarget] = useState<ExecutionProfile["target"]>("cloud");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [checks, setChecks] = useState<CheckDraft[]>([]);
  const connection = providers.find((item) => item.id === providerId);
  const profile = editing && editing !== "new" ? editing : null;
  function editProfile(entry: ExecutionProfile | "new") {
    sender.current = createCommandSender();
    setTarget(entry === "new" ? "cloud" : entry.target);
    setProviderId(
      entry === "new" || entry.target === "client" ? "" : entry.providerId,
    );
    setModel(entry === "new" ? "" : (entry.model ?? ""));
    setChecks(
      (entry === "new"
        ? [{ name: "", command: "", timeoutSeconds: 60 }]
        : entry.requiredChecks
      ).map((check) => ({ ...check, key: crypto.randomUUID() })),
    );
    setEditing(entry);
  }
  async function showWorkers(entry: ExecutionProfile) {
    const request = ++workerRequest.current;
    setWorkersLoading(true);
    try {
      const result = await cloudRequest<{ workers: ExecutionWorker[] }>(
        `execution-workers?profileId=${entry.id}`,
      );
      if (request !== workerRequest.current) return;
      setWorkers(result.workers);
      setSelected(entry);
      setError("");
    } catch (reason) {
      if (request === workerRequest.current)
        setError((reason as Error).message);
    } finally {
      if (request === workerRequest.current) setWorkersLoading(false);
    }
  }
  return (
    <>
      <header className="cloud-page-header">
        <h1>AI execution</h1>
        {workspace.projects.length > 0 && (
          <Button onClick={() => editProfile("new")}>
            <Plus />
            New profile
          </Button>
        )}
      </header>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {!profiles.length ? (
        <div className="cloud-empty">
          <Workflow aria-hidden="true" />
          <p>
            {workspace.projects.length
              ? "No execution profiles yet."
              : "Create a project before configuring execution."}
          </p>
        </div>
      ) : (
        <div className="cloud-grid">
          {profiles.map((entry) => (
            <section className="cloud-card" key={entry.id}>
              <span className="cloud-icon-tile">
                <Workflow size={20} />
              </span>
              <h2>{entry.name}</h2>
              <p>
                {
                  workspace.projects.find(
                    (project) => project.id === entry.projectId,
                  )?.name
                }
              </p>
              <p>
                {executionTargetLabels[entry.target]} ·{" "}
                {profileAgentLabel(entry)}
              </p>
              {!entry.enabled && <span>Disabled</span>}
              <div className="cloud-card-actions">
                <Button variant="outline" onClick={() => editProfile(entry)}>
                  Edit profile
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void showWorkers(entry)}
                >
                  Runners
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
      {selected && (
        <section className="cloud-settings-section mt-8">
          <header>
            <h2>{selected.name} runners</h2>
            <Button
              variant="outline"
              disabled={workersLoading}
              onClick={() => void showWorkers(selected)}
              aria-label="Refresh runners"
            >
              Refresh
            </Button>
            <Button
              disabled={!selected.enabled}
              onClick={() => {
                setToken("");
                setEnrolling(selected);
              }}
            >
              Enroll runner
            </Button>
          </header>
          {!workers.length ? (
            <p>No runners enrolled.</p>
          ) : (
            <ul className="cloud-member-list">
              {workers.map((worker) => (
                <li key={worker.id}>
                  <div>
                    <strong>{worker.name}</strong>
                    {worker.workspaceBinding && (
                      <span>Workspace: {worker.workspaceBinding.name}</span>
                    )}
                    <span>
                      {worker.enabled
                        ? worker.lastSeenAt
                          ? `Last seen ${new Date(worker.lastSeenAt).toLocaleString()}`
                          : "Not connected"
                        : "Revoked"}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    disabled={!selected.enabled}
                    aria-label={`Rotate token for ${worker.name}`}
                    onClick={() => {
                      setToken("");
                      setRotating(worker);
                    }}
                  >
                    Rotate token
                  </Button>
                  {worker.enabled && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        sender.current = createCommandSender();
                        setRevoking(worker);
                      }}
                    >
                      Revoke runner
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {token && (
        <section className="cloud-card mt-6 max-w-xl">
          <Field label="Runner token" htmlFor="runner-token">
            <Input
              id="runner-token"
              type="password"
              readOnly
              value={token}
              autoComplete="off"
            />
          </Field>
          <p>
            Save this token now. It grants this runner access to tasks using the
            selected profile.
          </p>
          <div className="cloud-editor-actions">
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token)
                  .catch(() =>
                    setError(
                      "Could not copy the token. Select and copy it from the field.",
                    ),
                  )
              }
            >
              Copy token
            </Button>
            <Button variant="ghost" onClick={() => setToken("")}>
              Dismiss
            </Button>
          </div>
        </section>
      )}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={profile ? "Edit execution profile" : "New execution profile"}
        submitLabel="Save profile"
        onSubmit={async (form) => {
          const definition = {
            name: formText(form, "name"),
            target,
            workspacePath: formText(form, "workspacePath") || undefined,
            repository: formText(form, "repository"),
            baseCommit: formText(form, "baseCommit"),
            ...(target === "client"
              ? {
                  agent: formText(form, "agent"),
                  model: formText(form, "model") || undefined,
                }
              : {
                  providerId: formText(form, "providerId"),
                  model: formText(form, "model"),
                }),
            maxDurationSeconds: Number(formText(form, "minutes")) * 60,
            maxTokens: Number(formText(form, "maxTokens")),
            requiredChecks: checks.map(({ key: _, ...check }) => check),
          };
          await sender.current(
            profile ? `execution-profiles/${profile.id}` : "execution-profiles",
            profile
              ? {
                  ...definition,
                  revision: profile.revision,
                  enabled: formText(form, "enabled") === "true",
                }
              : { ...definition, projectId: formText(form, "projectId") },
            profile ? "PATCH" : "POST",
          );
          setSelected(null);
          router.refresh();
        }}
      >
        <Field label="Name" htmlFor="profile-name">
          <Input
            id="profile-name"
            name="name"
            required
            maxLength={120}
            defaultValue={profile?.name}
          />
        </Field>
        {!profile && (
          <Field label="Project" htmlFor="profile-project">
            <Select id="profile-project" name="projectId" required>
              {workspace.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Target" htmlFor="profile-target">
          <Select
            id="profile-target"
            name="target"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value as ExecutionProfile["target"]);
              setModel("");
            }}
          >
            {(["cloud", "client", "client-linux"] as const).map((value) => (
              <option key={value} value={value}>
                {executionTargetLabels[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Repository URL" htmlFor="profile-repository">
          <Input
            id="profile-repository"
            name="repository"
            type="url"
            required
            defaultValue={profile?.repository}
          />
        </Field>
        <Field label="Base commit (SHA)" htmlFor="profile-commit">
          <Input
            id="profile-commit"
            name="baseCommit"
            required
            pattern="[0-9a-f]{40}"
            minLength={40}
            maxLength={40}
            defaultValue={profile?.baseCommit}
          />
        </Field>
        <Field label="Directory" htmlFor="profile-directory">
          <Input
            id="profile-directory"
            name="workspacePath"
            maxLength={1024}
            defaultValue={profile?.workspacePath}
            placeholder="Repository root"
          />
        </Field>
        {target === "client" ? (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Agent" htmlFor="profile-agent">
              <Select
                id="profile-agent"
                name="agent"
                defaultValue={
                  profile?.target === "client" ? profile.agent : "codex-cli"
                }
              >
                {clientAgents.map((agent) => (
                  <option key={agent} value={agent}>
                    {clientAgentLabels[agent]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model" htmlFor="profile-model">
              <Input
                id="profile-model"
                name="model"
                maxLength={160}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Agent default"
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Provider" htmlFor="profile-provider">
              <Select
                id="profile-provider"
                name="providerId"
                required
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setModel("");
                }}
              >
                <option value="" disabled>
                  Select a provider
                </option>
                {providers
                  .filter((provider) => !isCloudCliProvider(provider.provider))
                  .filter(
                    (provider) =>
                      provider.enabled ||
                      (profile?.target !== "client" &&
                        provider.id === profile?.providerId),
                  )
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                      {provider.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Model" htmlFor="profile-model">
              <Select
                id="profile-model"
                name="model"
                required
                disabled={!connection}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="" disabled>
                  Select a model
                </option>
                {model && !connection?.models.includes(model) && (
                  <option value={model}>{model} (unavailable)</option>
                )}
                {connection?.models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Time limit (minutes)" htmlFor="profile-minutes">
            <Input
              id="profile-minutes"
              name="minutes"
              type="number"
              required
              min={1}
              max={1440}
              step={1}
              defaultValue={profile ? profile.maxDurationSeconds / 60 : 60}
            />
          </Field>
          <Field label="Token limit" htmlFor="profile-tokens">
            <Input
              id="profile-tokens"
              name="maxTokens"
              type="number"
              required
              min={1}
              max={10000000}
              step={1}
              defaultValue={profile?.maxTokens ?? 100000}
            />
          </Field>
        </div>
        <ExecutionChecks checks={checks} onChange={setChecks} />
        {profile && (
          <>
            <Field label="Status" htmlFor="profile-enabled">
              <Select
                id="profile-enabled"
                name="enabled"
                defaultValue={String(profile.enabled)}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </Select>
            </Field>
            <p>
              Saving changes ends queued tasks and asks active runners to stop.
              Rotate runner tokens to reconnect.
            </p>
          </>
        )}
      </FormDialog>
      <FormDialog
        open={enrolling !== null}
        onOpenChange={(open) => {
          if (!open) setEnrolling(null);
        }}
        title="Enroll runner"
        submitLabel="Create token"
        onSubmit={async (form) => {
          if (!enrolling) return;
          const result = await cloudRequest<{ token: string }>(
            "execution-workers",
            {
              method: "POST",
              body: { profileId: enrolling.id, name: formText(form, "name") },
            },
          );
          setToken(result.token);
          await showWorkers(enrolling);
        }}
      >
        <Field label="Name" htmlFor="runner-name">
          <Input id="runner-name" name="name" required maxLength={120} />
        </Field>
      </FormDialog>
      <FormDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke runner"
        submitLabel="Revoke runner"
        onSubmit={async () => {
          if (!revoking || !selected) return;
          await sender.current(`execution-workers/${revoking.id}/revoke`, {});
          setToken("");
          await showWorkers(selected);
        }}
      >
        <p>
          This runner will lose permission to claim or continue tasks. Active
          tasks will wait for confirmation that it stopped.
        </p>
      </FormDialog>
      <FormDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate runner token"
        submitLabel="Rotate token"
        onSubmit={async () => {
          if (!rotating || !selected) return;
          const result = await cloudRequest<{ token: string }>(
            `execution-workers/${rotating.id}/rotate`,
            { method: "POST", body: {} },
          );
          setToken(result.token);
          await showWorkers(selected);
        }}
      >
        <p>
          The old token will stop working and active tasks will be asked to
          stop.
        </p>
      </FormDialog>
    </>
  );
}
