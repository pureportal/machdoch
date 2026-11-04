import { describe, expect, it } from "vitest";
import {
  convertDetectedRunOutput,
  type DetectedRunConfiguration,
  type DetectedRunInput,
} from "./workspace-run-detection-output.helper.js";

const configuration = (
  overrides: Partial<DetectedRunConfiguration>,
): DetectedRunConfiguration => ({
  id: "web",
  name: "Web",
  kind: "task",
  runType: "service",
  group: null,
  primary: false,
  command: "pnpm run dev",
  workingDirectory: ".",
  environment: [],
  hotReload: true,
  ports: [],
  urls: [],
  healthCheckKind: "none",
  healthCheckPort: null,
  healthCheckUrl: null,
  children: [],
  startOrder: "parallel",
  confidence: "high",
  evidence: ["package.json"],
  uncertainFields: [],
  ...overrides,
});

const input = (overrides: Partial<DetectedRunInput>): DetectedRunInput => ({
  id: "env",
  type: "select",
  label: "Environment",
  description: null,
  options: [
    { value: "dev", label: "Development" },
    { value: "prod", label: null },
  ],
  defaultText: "dev",
  defaultBoolean: null,
  required: false,
  trueValue: null,
  falseValue: null,
  ...overrides,
});

describe("convertDetectedRunOutput", () => {
  it("builds services, jobs, composites, groups, and referenced inputs", () => {
    const result = convertDetectedRunOutput(
      {
        inputs: [
          input({}),
          input({
            id: "dryRun",
            type: "boolean",
            label: "Dry run",
            options: [],
            defaultText: null,
            defaultBoolean: true,
            trueValue: "--dry-run",
            falseValue: "",
          }),
          input({ id: "unused", type: "text", options: [], defaultText: "" }),
        ],
        configurations: [
          configuration({
            id: "api",
            name: "API",
            workingDirectory: "./apps\\api/",
            ports: [3000, 3000, 0],
            urls: ["http://localhost:3000", "javascript:alert(1)"],
            healthCheckKind: "http",
            healthCheckUrl: "http://localhost:3000/health",
          }),
          configuration({ id: "web", workingDirectory: "apps/web" }),
          configuration({
            id: "Write-Env",
            name: "Write .env files",
            runType: "job",
            group: "Runtime Config",
            command: "npm run env:sync -- --env ${input:env} ${input:dryRun}",
            hotReload: true,
            healthCheckKind: "tcp",
            healthCheckPort: 1234,
          }),
          configuration({
            id: "fullstack",
            name: "Full stack",
            kind: "composite",
            primary: true,
            command: null,
            children: ["api", "web", "missing"],
          }),
        ],
      },
      () => true,
    );

    expect(result.document.inputs.map((entry) => entry.id)).toEqual([
      "env",
      "dryRun",
    ]);
    expect(result.document.inputs[1]).toEqual({
      id: "dryRun",
      label: "Dry run",
      type: "boolean",
      default: true,
      trueValue: "--dry-run",
      falseValue: "",
    });
    const [api, , writeEnv, fullstack] = result.document.configurations;
    expect(api).toMatchObject({
      workingDirectory: "apps/api",
      ports: [3000],
      urls: ["http://localhost:3000"],
      healthCheck: { kind: "http", url: "http://localhost:3000/health" },
      primary: false,
    });
    expect(writeEnv).toMatchObject({
      id: "write-env",
      runType: "job",
      group: "Runtime Config",
      hotReload: false,
      healthCheck: null,
    });
    expect(fullstack).toMatchObject({
      kind: "composite",
      primary: true,
      children: ["api", "web"],
    });
    expect(result.detections.map((entry) => entry.configurationId)).toEqual([
      "api",
      "web",
      "write-env",
      "fullstack",
    ]);
  });

  it("drops configurations that cannot run and always keeps one primary", () => {
    const result = convertDetectedRunOutput(
      {
        inputs: [],
        configurations: [
          configuration({ id: "missing-directory", workingDirectory: "nope" }),
          configuration({ id: "undefined-input", command: "run ${input:x}" }),
          configuration({ id: "empty", command: "  " }),
          configuration({ id: "lint", runType: "job", hotReload: false }),
          configuration({ id: "lint", name: "Duplicate" }),
          configuration({ id: "dev" }),
        ],
      },
      (directory) => directory === ".",
    );

    expect(
      result.document.configurations.map(({ id, primary }) => [id, primary]),
    ).toEqual([
      ["lint", false],
      ["dev", true],
    ]);
  });
});
