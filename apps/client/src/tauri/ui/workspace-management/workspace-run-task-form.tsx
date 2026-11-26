import type { JSX } from "react";
import type {
  WorkspaceRunHealthCheck,
  WorkspaceRunTaskConfiguration,
} from "../../../shared/workspace-run.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { ChoiceButtons } from "../chat-session/components/settings-dialog-panels/shared";
import {
  formatWorkspaceRunEnvironment,
  parseWorkspaceRunEnvironment,
  parseWorkspaceRunPorts,
  parseWorkspaceRunUrls,
} from "./workspace-run-editor-model";
import {
  RUN_INPUT_CLASS,
  RUN_MONO_INPUT_CLASS,
  RUN_SELECT_CLASS,
  RunAdvancedDetails,
  RunCheckbox,
  RunField,
  RunNumberField,
  RunParsedField,
  RunSection,
} from "./workspace-run-form-fields";

const RUN_TYPE_OPTIONS = [
  { value: "service", label: "Service" },
  { value: "job", label: "Job" },
] as const;

type HealthKind = "none" | WorkspaceRunHealthCheck["kind"];

const healthCheckFor = (
  kind: HealthKind,
  current: WorkspaceRunHealthCheck | null | undefined,
  ports: readonly number[],
): WorkspaceRunHealthCheck | null => {
  if (kind === "none") return null;
  const restartOnFailure = current?.restartOnFailure ?? false;
  return kind === "tcp"
    ? {
        kind,
        host: current?.host ?? null,
        port: current?.port ?? ports[0] ?? null,
        restartOnFailure,
      }
    : {
        kind,
        url: current?.url ?? (ports[0] ? `http://127.0.0.1:${ports[0]}` : null),
        restartOnFailure,
      };
};

export const WorkspaceRunTaskForm = ({
  configuration,
  groups,
  disabled,
  onChange,
  onMakeDefault,
}: {
  configuration: WorkspaceRunTaskConfiguration;
  groups: readonly string[];
  disabled: boolean;
  onChange: (next: WorkspaceRunTaskConfiguration) => void;
  onMakeDefault: () => void;
}): JSX.Element => {
  const update = (patch: Partial<WorkspaceRunTaskConfiguration>): void =>
    onChange({ ...configuration, ...patch });
  const service = configuration.runType === "service";
  const health = configuration.healthCheck ?? null;
  const policy = configuration.restartPolicy;
  const groupListId = `run-groups-${configuration.id}`;

  return (
    <div className="grid gap-6">
      <RunSection title="General">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <RunField label="Name">
            <Input
              value={configuration.name}
              disabled={disabled}
              onChange={(event) => update({ name: event.target.value })}
              className={RUN_INPUT_CLASS}
            />
          </RunField>
          <RunField label="Type">
            <ChoiceButtons
              label="Type"
              value={configuration.runType}
              options={RUN_TYPE_OPTIONS}
              disabled={disabled}
              onChange={(runType) => update({ runType })}
            />
          </RunField>
        </div>
        <RunField label="Command">
          <Input
            value={configuration.command}
            disabled={disabled}
            spellCheck={false}
            placeholder="pnpm run dev"
            onChange={(event) => update({ command: event.target.value })}
            className={RUN_MONO_INPUT_CLASS}
          />
        </RunField>
        <div className="grid gap-3 md:grid-cols-2">
          <RunField label="Working directory">
            <Input
              value={configuration.workingDirectory}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) =>
                update({ workingDirectory: event.target.value })
              }
              className={RUN_MONO_INPUT_CLASS}
            />
          </RunField>
          <RunField label="Group">
            <Input
              list={groupListId}
              value={configuration.group ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const { group: _previous, ...rest } = configuration;
                const group = event.target.value;
                onChange(group ? { ...rest, group } : rest);
              }}
              className={RUN_INPUT_CLASS}
            />
            <datalist id={groupListId}>
              {groups.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
          </RunField>
        </div>
        <div className="flex flex-wrap gap-x-6">
          <RunCheckbox
            label="Default configuration"
            checked={configuration.primary}
            disabled={disabled || configuration.primary}
            onChange={onMakeDefault}
          />
          {service ? (
            <RunCheckbox
              label="Hot reload"
              checked={configuration.hotReload}
              disabled={disabled}
              onChange={(hotReload) => update({ hotReload })}
            />
          ) : null}
        </div>
      </RunSection>

      <RunSection title="Network">
        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <RunParsedField
            fieldKey={`task:${configuration.id}:ports`}
            label="Ports"
            initialText={configuration.ports.join(", ")}
            placeholder="3000"
            disabled={disabled}
            parse={(text) => {
              const result = parseWorkspaceRunPorts(text);
              return { value: result.ports, error: result.error };
            }}
            onCommit={(ports) => update({ ports })}
          />
          <RunParsedField
            fieldKey={`task:${configuration.id}:urls`}
            label="URLs"
            initialText={configuration.urls.join(" ")}
            placeholder="http://127.0.0.1:3000"
            disabled={disabled}
            parse={(text) => {
              const result = parseWorkspaceRunUrls(text);
              return { value: result.urls, error: result.error };
            }}
            onCommit={(urls) => update({ urls })}
          />
        </div>
      </RunSection>

      <RunSection title="Environment">
        <RunParsedField
          fieldKey={`task:${configuration.id}:environment`}
          label="Variables"
          multiline
          initialText={formatWorkspaceRunEnvironment(configuration.environment)}
          placeholder="NODE_ENV=development"
          disabled={disabled}
          parse={(text) => {
            const result = parseWorkspaceRunEnvironment(text);
            return { value: result.environment, error: result.error };
          }}
          onCommit={(environment) => update({ environment })}
        />
      </RunSection>

      <RunAdvancedDetails>
        <RunSection title="Identity">
          <RunField label="ID" className="md:max-w-sm">
            <Input
              value={configuration.id}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => update({ id: event.target.value.trim() })}
              className={RUN_MONO_INPUT_CLASS}
            />
          </RunField>
        </RunSection>
        {service ? (
          <>
            <RunSection title="Health check">
              <div className="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)_8rem]">
                <RunField label="Check">
                  <select
                    value={health?.kind ?? "none"}
                    disabled={disabled}
                    onChange={(event) =>
                      update({
                        healthCheck: healthCheckFor(
                          event.target.value as HealthKind,
                          health,
                          configuration.ports,
                        ),
                      })
                    }
                    className={RUN_SELECT_CLASS}
                  >
                    <option value="none">None</option>
                    <option value="tcp">TCP port</option>
                    <option value="http">HTTP URL</option>
                  </select>
                </RunField>
                {health?.kind === "tcp" ? (
                  <>
                    <RunField label="Host">
                      <Input
                        value={health.host ?? ""}
                        placeholder="127.0.0.1"
                        disabled={disabled}
                        onChange={(event) =>
                          update({
                            healthCheck: {
                              ...health,
                              host: event.target.value || null,
                            },
                          })
                        }
                        className={RUN_MONO_INPUT_CLASS}
                      />
                    </RunField>
                    <RunNumberField
                      label="Port"
                      value={health.port ?? 0}
                      min={0}
                      max={65_535}
                      disabled={disabled}
                      onChange={(port) =>
                        update({
                          healthCheck: { ...health, port: port || null },
                        })
                      }
                    />
                  </>
                ) : null}
                {health?.kind === "http" ? (
                  <RunField label="URL" className="md:col-span-2">
                    <Input
                      value={health.url ?? ""}
                      placeholder="http://127.0.0.1:3000/health"
                      disabled={disabled}
                      onChange={(event) =>
                        update({
                          healthCheck: {
                            ...health,
                            url: event.target.value || null,
                          },
                        })
                      }
                      className={RUN_MONO_INPUT_CLASS}
                    />
                  </RunField>
                ) : null}
              </div>
              {health ? (
                <RunCheckbox
                  label="Restart when unhealthy"
                  checked={health.restartOnFailure}
                  disabled={disabled}
                  onChange={(restartOnFailure) =>
                    update({ healthCheck: { ...health, restartOnFailure } })
                  }
                />
              ) : null}
            </RunSection>

            <RunSection title="Restart policy">
              <RunCheckbox
                label="Restart on crash"
                checked={policy.onCrash}
                disabled={disabled}
                onChange={(onCrash) =>
                  update({ restartPolicy: { ...policy, onCrash } })
                }
              />
              {policy.onCrash ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <RunNumberField
                    label="Max restarts"
                    value={policy.maxRestarts}
                    min={0}
                    max={100}
                    disabled={disabled}
                    onChange={(maxRestarts) =>
                      update({ restartPolicy: { ...policy, maxRestarts } })
                    }
                  />
                  <RunNumberField
                    label="Window (ms)"
                    value={policy.windowMs}
                    min={1_000}
                    max={86_400_000}
                    disabled={disabled}
                    onChange={(windowMs) =>
                      update({ restartPolicy: { ...policy, windowMs } })
                    }
                  />
                  <RunNumberField
                    label="Backoff (ms)"
                    value={policy.backoffMs}
                    min={0}
                    max={300_000}
                    disabled={disabled}
                    onChange={(backoffMs) =>
                      update({
                        restartPolicy: {
                          ...policy,
                          backoffMs,
                          maxBackoffMs: Math.max(
                            policy.maxBackoffMs,
                            backoffMs,
                          ),
                        },
                      })
                    }
                  />
                  <RunNumberField
                    label="Max backoff (ms)"
                    value={policy.maxBackoffMs}
                    min={policy.backoffMs}
                    max={600_000}
                    disabled={disabled}
                    onChange={(maxBackoffMs) =>
                      update({ restartPolicy: { ...policy, maxBackoffMs } })
                    }
                  />
                </div>
              ) : null}
            </RunSection>
          </>
        ) : null}
      </RunAdvancedDetails>
    </div>
  );
};
