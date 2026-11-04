import { describe, expect, it } from "vitest";
import type { WorkspaceRunInput } from "./workspace-run.js";
import {
  resolveWorkspaceRunInputText,
  resolveWorkspaceRunTaskInputs,
  workspaceRunDefaultInputValue,
  workspaceRunInputValueError,
  workspaceRunTaskInputIds,
} from "./workspace-run-inputs.js";

const inputs: WorkspaceRunInput[] = [
  {
    type: "select",
    id: "env",
    label: "Environment",
    options: [{ value: "dev", label: "Development" }, { value: "prod" }],
  },
  {
    type: "boolean",
    id: "dryRun",
    label: "Dry run",
    default: true,
    trueValue: "--dry-run",
    falseValue: "",
  },
  {
    type: "text",
    id: "repos",
    label: "Repositories",
    default: "",
    required: false,
  },
  {
    type: "text",
    id: "name",
    label: "Migration name",
    default: "",
    required: true,
  },
];

describe("workspace run inputs", () => {
  it("lists unique references from the command and sorted environment keys", () => {
    expect(
      workspaceRunTaskInputIds({
        command: "sync ${input:env} ${input:dryRun} ${input:env}",
        environment: { ZED: "${input:name}", ALPHA: "${input:repos}" },
      }),
    ).toEqual(["env", "dryRun", "repos", "name"]);
  });

  it("uses the first option, configured defaults, and boolean argument values", () => {
    expect(workspaceRunDefaultInputValue(inputs[0]!)).toBe("dev");
    expect(workspaceRunDefaultInputValue(inputs[1]!)).toBe(true);
    expect(
      resolveWorkspaceRunInputText(
        "sync --env ${input:env} ${input:dryRun} --repos=${input:repos}",
        inputs,
        { env: "prod", dryRun: false, repos: "api,app" },
      ),
    ).toBe("sync --env prod  --repos=api,app");
    expect(resolveWorkspaceRunInputText("${input:missing}", inputs, {})).toBe(
      "${input:missing}",
    );
  });

  it("reports values that the run cannot use", () => {
    expect(workspaceRunInputValueError(inputs[0]!, "staging")).toBe(
      "Choose one of the options for Environment.",
    );
    expect(workspaceRunInputValueError(inputs[1]!, "yes")).toBe(
      "Dry run must be true or false.",
    );
    expect(workspaceRunInputValueError(inputs[2]!, "a\nb")).toContain(
      "single line",
    );
    expect(workspaceRunInputValueError(inputs[3]!, "  ")).toBe(
      "Migration name is required.",
    );
    expect(workspaceRunInputValueError(inputs[3]!, "add-users")).toBeNull();
  });

  it("resolves task commands and environment values or rejects invalid inputs", () => {
    const task = {
      id: "migrate",
      command: "pnpm db:create ${input:name}",
      environment: { TARGET: "${input:env}" },
    };

    expect(
      resolveWorkspaceRunTaskInputs(task, inputs, { name: "add-users" }),
    ).toEqual({
      id: "migrate",
      command: "pnpm db:create add-users",
      environment: { TARGET: "dev" },
    });
    expect(() => resolveWorkspaceRunTaskInputs(task, inputs, {})).toThrow(
      "Migration name is required.",
    );
    expect(() =>
      resolveWorkspaceRunTaskInputs(
        { command: "${input:unknown}", environment: {} },
        inputs,
        {},
      ),
    ).toThrow("Run input `unknown` does not exist.");
  });
});
