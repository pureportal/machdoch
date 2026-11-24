import { describe, expect, it } from "vitest";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunInput,
  WorkspaceRunTaskConfiguration,
} from "../../../shared/workspace-run.js";
import {
  terminalRunCommand,
  terminalRunTasks,
  terminalShellKind,
} from "./workspace-terminal-run";

const task = (
  overrides: Partial<WorkspaceRunTaskConfiguration> = {},
): WorkspaceRunTaskConfiguration => ({
  id: "api",
  name: "API",
  kind: "task",
  primary: true,
  runType: "service",
  command: "pnpm --filter ${input:package} dev",
  workingDirectory: "./apps/api/",
  environment: { PORT: "${input:port}", "BAD-KEY": "x" },
  hotReload: false,
  ports: [],
  urls: [],
  restartPolicy: {
    onCrash: false,
    maxRestarts: 0,
    windowMs: 0,
    backoffMs: 0,
    maxBackoffMs: 0,
  },
  ...overrides,
});

const inputs: WorkspaceRunInput[] = [
  {
    id: "package",
    label: "Package",
    type: "text",
    default: "api",
    required: true,
  },
  { id: "port", label: "Port", type: "text", default: "3000", required: true },
];

const status = (
  configuration: WorkspaceRunConfigurationStatus["configuration"],
  children: WorkspaceRunConfigurationStatus[] = [],
): WorkspaceRunConfigurationStatus => ({
  configuration,
  state: "stopped",
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health: null,
  recentFailures: [],
  logs: [],
  inputValues: { port: "4000" },
  children,
});

describe("run configurations in a terminal", () => {
  it("resolves inputs, folder and environment for each shell", () => {
    const configuration = task();
    expect(
      terminalRunCommand(
        configuration,
        inputs,
        status(configuration),
        "powershell",
      ),
    ).toEqual({
      id: "api",
      name: "API",
      cwd: "apps/api",
      command: "$env:PORT='4000'; pnpm --filter api dev",
    });
    expect(
      terminalRunCommand(configuration, inputs, null, "posix").command,
    ).toBe("PORT='3000' pnpm --filter api dev");
    expect(terminalRunCommand(configuration, inputs, null, "cmd").command).toBe(
      'set "PORT=3000" && pnpm --filter api dev',
    );
    expect(
      terminalRunCommand(
        task({ environment: {}, workingDirectory: "." }),
        inputs,
        null,
        "posix",
      ),
    ).toMatchObject({ cwd: null, command: "pnpm --filter api dev" });
    expect(terminalShellKind("zsh")).toBe("posix");
  });

  it("lists every task once, including composite children", () => {
    const api = task();
    const web = task({ id: "web", name: "Web" });
    const composite = status(
      {
        id: "all",
        name: "All",
        kind: "composite",
        primary: false,
        children: ["api", "web"],
      } as never,
      [status(api), status(web)],
    );
    expect(
      terminalRunTasks([status(api), composite]).map((entry) => entry.task.id),
    ).toEqual(["api", "web"]);
  });
});
