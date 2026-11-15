"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LoadingState } from "@machdoch/product-ui";
import type { CloudAiProvider } from "@machdoch/fleet-protocol/cloud-providers";
import {
  clientAgents,
  type ExecutionCheck,
  type ExecutionProfile,
  type ExecutionRepository,
} from "@machdoch/fleet-protocol/cloud-execution";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ExecutionChecks, type CheckDraft } from "./execution-checks";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import { clientAgentLabels, executionTargetLabels } from "./execution-labels";

const minutePresets = [15, 30, 60, 120, 240, 480];
const tokenPresets = [100_000, 300_000, 1_000_000, 3_000_000, 10_000_000];

function withCurrent(presets: number[], current: number | undefined) {
  return current === undefined || presets.includes(current)
    ? presets
    : [...presets, current].sort((left, right) => left - right);
}

function drafts(checks: ExecutionCheck[]): CheckDraft[] {
  return checks.map((check) => ({ ...check, key: crypto.randomUUID() }));
}

export function ExecutionProfileForm({
  open,
  profile,
  projectId,
  workspace,
  providers,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: ExecutionProfile | null;
  projectId?: string;
  workspace: CloudWorkspace;
  providers: CloudAiProvider[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const sender = useRef(createCommandSender());
  const [repositories, setRepositories] = useState<
    ExecutionRepository[] | null
  >(null);
  const [repository, setRepository] = useState("");
  const [target, setTarget] = useState<ExecutionProfile["target"]>("cloud");
  const [model, setModel] = useState("");
  const [checks, setChecks] = useState<CheckDraft[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const [checkPullRequests, setCheckPullRequests] = useState(false);
  const [error, setError] = useState("");
  const detection = useRef(0);
  const models = providers
    .filter(
      (provider) =>
        provider.enabled ||
        (profile?.target !== "client" && provider.id === profile?.providerId),
    )
    .flatMap((provider) =>
      provider.models.map((name) => ({
        value: `${provider.id}|${name}`,
        label: `${name} · ${provider.name}`,
      })),
    );

  useEffect(() => {
    if (!open) return;
    sender.current = createCommandSender();
    setError("");
    setRepository(profile?.repository ?? "");
    setTarget(profile?.target ?? "cloud");
    setModel(
      profile && profile.target !== "client"
        ? `${profile.providerId}|${profile.model}`
        : (models[0]?.value ?? ""),
    );
    setChecks(drafts(profile?.requiredChecks ?? []));
    setAutopilot(profile?.autopilot ?? false);
    setCheckPullRequests(profile?.checkPullRequests ?? false);
    const controller = new AbortController();
    void cloudRequest<{ repositories: ExecutionRepository[] }>(
      "execution-repositories",
      { signal: controller.signal },
    )
      .then((result) => {
        setRepositories(result.repositories);
        if (!profile && result.repositories.length === 1)
          void choose(result.repositories[0]!.url);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [open, profile]);

  async function choose(url: string) {
    setRepository(url);
    if (!url) return;
    const request = ++detection.current;
    setDetecting(true);
    try {
      const result = await cloudRequest<{ checks: ExecutionCheck[] }>(
        `execution-checks?repository=${encodeURIComponent(url)}`,
      );
      if (request === detection.current) setChecks(drafts(result.checks));
    } catch (reason) {
      if (request === detection.current) setError((reason as Error).message);
    } finally {
      if (request === detection.current) setDetecting(false);
    }
  }

  const selected = repositories?.find((entry) => entry.url === repository);
  const [providerId, modelName] = model.split("|") as [string, string];
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={profile ? "Edit AI setup" : "Set up AI for a project"}
      submitLabel={profile ? "Save" : "Set up"}
      submitDisabled={!repository || (target !== "client" && !model)}
      onSubmit={async (form) => {
        const definition = {
          name:
            formText(form, "name") ||
            selected?.fullName ||
            profile?.name ||
            "AI setup",
          target,
          repository,
          autopilot,
          checkPullRequests,
          ...(formText(form, "branch")
            ? { branch: formText(form, "branch") }
            : {}),
          ...(formText(form, "workspacePath")
            ? { workspacePath: formText(form, "workspacePath") }
            : {}),
          ...(target === "client"
            ? {
                agent: formText(form, "agent"),
                ...(formText(form, "clientModel")
                  ? { model: formText(form, "clientModel") }
                  : {}),
              }
            : { providerId, model: modelName }),
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
                enabled: formText(form, "enabled") !== "false",
              }
            : {
                ...definition,
                projectId: formText(form, "projectId") || projectId,
              },
          profile ? "PATCH" : "POST",
        );
        onSaved();
      }}
    >
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {!profile && !projectId && (
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
      <Field label="Repository" htmlFor="profile-repository">
        {repositories === null ? (
          <LoadingState label="Loading repositories…" />
        ) : repositories.length ? (
          <Select
            id="profile-repository"
            required
            value={repository}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="" disabled>
              Choose a repository
            </option>
            {repository && !selected && (
              <option value={repository}>{repository}</option>
            )}
            {repositories.map((entry) => (
              <option key={entry.url} value={entry.url}>
                {entry.fullName}
              </option>
            ))}
          </Select>
        ) : (
          <p className="cloud-setup-empty">
            <Link href="/cloud/settings?tab=git">Connect GitHub or GitLab</Link>{" "}
            to choose a repository.
          </p>
        )}
      </Field>
      {target !== "client" && (
        <Field label="Model" htmlFor="profile-model">
          {models.length ? (
            <Select
              id="profile-model"
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {model && !models.some((entry) => entry.value === model) && (
                <option value={model}>{modelName} (unavailable)</option>
              )}
              {models.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          ) : (
            <p className="cloud-setup-empty">
              <Link href="/cloud/providers">Add an AI provider</Link> to choose
              a model.
            </p>
          )}
        </Field>
      )}
      <div className="cloud-setup-toggle">
        <div>
          <span id="profile-autopilot-label">Autopilot</span>
          <p>Merges changes that pass the checks and the AI review.</p>
        </div>
        <button
          type="button"
          role="switch"
          className="cloud-automation-switch"
          aria-checked={autopilot}
          aria-labelledby="profile-autopilot-label"
          onClick={() => setAutopilot((value) => !value)}
        />
      </div>
      {target !== "client" && (
        <div className="cloud-setup-toggle">
          <div>
            <span id="profile-checks-label">Check pull requests</span>
            <p>
              Builds, tests and reviews every new pull request in a sandbox and
              comments the result.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            className="cloud-automation-switch"
            aria-checked={checkPullRequests}
            aria-labelledby="profile-checks-label"
            onClick={() => setCheckPullRequests((value) => !value)}
          />
        </div>
      )}
      {detecting ? (
        <LoadingState label="Finding checks…" />
      ) : (
        <ExecutionChecks checks={checks} onChange={setChecks} />
      )}
      <details className="cloud-setup-more">
        <summary>More options</summary>
        <div className="grid gap-4 pt-4">
          <Field label="Branch" htmlFor="profile-branch">
            <Input
              id="profile-branch"
              name="branch"
              maxLength={255}
              defaultValue={profile?.branch}
              placeholder={selected?.defaultBranch ?? "Default branch"}
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
          <Field label="Name" htmlFor="profile-name">
            <Input
              id="profile-name"
              name="name"
              maxLength={120}
              defaultValue={profile?.name}
              placeholder={selected?.fullName}
            />
          </Field>
          <Field label="Runs on" htmlFor="profile-target">
            <Select
              id="profile-target"
              value={target}
              onChange={(event) =>
                setTarget(event.target.value as ExecutionProfile["target"])
              }
            >
              {(["cloud", "client-linux", "client"] as const).map((value) => (
                <option key={value} value={value}>
                  {executionTargetLabels[value]}
                </option>
              ))}
            </Select>
          </Field>
          {target === "client" && (
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
              <Field label="Agent model" htmlFor="profile-client-model">
                <Input
                  id="profile-client-model"
                  name="clientModel"
                  maxLength={160}
                  defaultValue={
                    profile?.target === "client" ? profile.model : undefined
                  }
                  placeholder="Agent default"
                />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Time limit" htmlFor="profile-minutes">
              <Select
                id="profile-minutes"
                name="minutes"
                defaultValue={String(
                  profile ? profile.maxDurationSeconds / 60 : 60,
                )}
              >
                {withCurrent(
                  minutePresets,
                  profile ? profile.maxDurationSeconds / 60 : undefined,
                ).map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60
                      ? `${minutes} minutes`
                      : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Token limit" htmlFor="profile-tokens">
              <Select
                id="profile-tokens"
                name="maxTokens"
                defaultValue={String(profile?.maxTokens ?? 300_000)}
              >
                {withCurrent(tokenPresets, profile?.maxTokens).map((tokens) => (
                  <option key={tokens} value={tokens}>
                    {tokens.toLocaleString("en-US")} tokens
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {profile && (
            <Field label="Status" htmlFor="profile-enabled">
              <Select
                id="profile-enabled"
                name="enabled"
                defaultValue={String(profile.enabled)}
              >
                <option value="true">On</option>
                <option value="false">Paused</option>
              </Select>
            </Field>
          )}
        </div>
      </details>
      {profile && (
        <p className="text-sm text-muted-foreground">
          Saving stops tasks that are still running with the old setup.
        </p>
      )}
    </FormDialog>
  );
}
