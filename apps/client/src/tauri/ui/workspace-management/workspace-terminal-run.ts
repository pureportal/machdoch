import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunInput,
  WorkspaceRunTaskConfiguration,
} from "../../../shared/workspace-run.js";
import { resolveWorkspaceRunInputText } from "../../../shared/workspace-run-inputs.js";

export type TerminalShellKind = "powershell" | "cmd" | "posix";

export interface TerminalRunCommand {
  id: string;
  name: string;
  cwd: string | null;
  command: string;
}

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const terminalShellKind = (kind: string): TerminalShellKind =>
  kind === "powershell" ? "powershell" : kind === "cmd" ? "cmd" : "posix";

const quote = (value: string, shell: TerminalShellKind): string => {
  switch (shell) {
    case "powershell":
      return `'${value.replaceAll("'", "''")}'`;
    case "cmd":
      return value.replaceAll('"', "");
    case "posix":
      return `'${value.replaceAll("'", `'\\''`)}'`;
  }
};

const withEnvironment = (
  command: string,
  environment: readonly [string, string][],
  shell: TerminalShellKind,
): string => {
  if (environment.length === 0) return command;
  switch (shell) {
    case "powershell":
      return `${environment.map(([key, value]) => `$env:${key}=${quote(value, shell)}`).join("; ")}; ${command}`;
    case "cmd":
      return `${environment.map(([key, value]) => `set "${key}=${quote(value, shell)}"`).join(" && ")} && ${command}`;
    case "posix":
      return `${environment.map(([key, value]) => `${key}=${quote(value, shell)}`).join(" ")} ${command}`;
  }
};

const normalizeCwd = (workingDirectory: string): string | null => {
  const cwd = workingDirectory
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/?/u, "")
    .replace(/\/+$/u, "");
  return cwd ? cwd : null;
};

export const terminalRunCommand = (
  task: WorkspaceRunTaskConfiguration,
  inputs: readonly WorkspaceRunInput[],
  status: Pick<WorkspaceRunConfigurationStatus, "inputValues"> | null,
  shell: TerminalShellKind,
): TerminalRunCommand => {
  const values = status?.inputValues ?? {};
  const environment = Object.entries(task.environment)
    .filter(([key]) => ENVIRONMENT_KEY.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]): [string, string] => [
      key,
      resolveWorkspaceRunInputText(value, inputs, values),
    ]);
  return {
    id: task.id,
    name: task.name,
    cwd: normalizeCwd(task.workingDirectory),
    command: withEnvironment(
      resolveWorkspaceRunInputText(task.command, inputs, values),
      environment,
      shell,
    ),
  };
};

export interface TerminalRunTask {
  task: WorkspaceRunTaskConfiguration;
  status: WorkspaceRunConfigurationStatus;
}

export const terminalRunTasks = (
  configurations: readonly WorkspaceRunConfigurationStatus[],
): TerminalRunTask[] => {
  const tasks = new Map<string, TerminalRunTask>();
  const visit = (
    statuses: readonly WorkspaceRunConfigurationStatus[],
  ): void => {
    for (const status of statuses) {
      if (
        status.configuration.kind === "task" &&
        !tasks.has(status.configuration.id)
      ) {
        tasks.set(status.configuration.id, {
          task: status.configuration,
          status,
        });
      }
      visit(status.children);
    }
  };
  visit(configurations);
  return [...tasks.values()];
};
