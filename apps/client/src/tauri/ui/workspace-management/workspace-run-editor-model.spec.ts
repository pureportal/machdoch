import { describe, expect, it } from "vitest";
import {
  createEmptyWorkspaceRunDocument,
  type WorkspaceRunCompositeConfiguration,
  type WorkspaceRunConfigurationDocument,
  type WorkspaceRunTaskConfiguration,
} from "../../../shared/workspace-run.js";
import {
  addWorkspaceRunConfiguration,
  addWorkspaceRunInput,
  changeWorkspaceRunInputType,
  duplicateWorkspaceRunConfiguration,
  moveWorkspaceRunChild,
  parseWorkspaceRunDraft,
  parseWorkspaceRunEnvironment,
  parseWorkspaceRunPorts,
  parseWorkspaceRunUrls,
  removeWorkspaceRunConfiguration,
  setPrimaryWorkspaceRunConfiguration,
  toggleWorkspaceRunChild,
  uniqueWorkspaceRunId,
  updateWorkspaceRunConfiguration,
  workspaceRunChildCandidates,
  workspaceRunConfigurationIssues,
} from "./workspace-run-editor-model";
import {
  loadPreviewWorkspaceRunDocument,
  loadPreviewWorkspaceRunSnapshot,
  precheckPreviewWorkspaceRunJson,
} from "./workspace-preview-run";

const documentWith = (
  ...kinds: Array<"service" | "job" | "composite">
): WorkspaceRunConfigurationDocument =>
  kinds.reduce(
    (document, kind) => addWorkspaceRunConfiguration(document, kind).document,
    createEmptyWorkspaceRunDocument(),
  );

const task = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
): WorkspaceRunTaskConfiguration => {
  const configuration = document.configurations.find(
    (candidate) => candidate.id === id,
  );
  if (configuration?.kind !== "task") throw new Error(`No task ${id}`);
  return configuration;
};

const composite = (
  document: WorkspaceRunConfigurationDocument,
  id: string,
): WorkspaceRunCompositeConfiguration => {
  const configuration = document.configurations.find(
    (candidate) => candidate.id === id,
  );
  if (configuration?.kind !== "composite") throw new Error(`No group ${id}`);
  return configuration;
};

describe("workspace run editor model", () => {
  it("parses valid drafts and reports invalid ones", () => {
    expect(parseWorkspaceRunDraft("{").error).toBeTruthy();
    expect(parseWorkspaceRunDraft("[]").document).toBeNull();
    expect(
      parseWorkspaceRunDraft(
        '{"schemaVersion":1,"inputs":[],"configurations":[]}',
      ).error,
    ).toContain("schemaVersion");
    expect(
      parseWorkspaceRunDraft(
        '{"schemaVersion":2,"inputs":[],"configurations":[{"id":"a"}]}',
      ).error,
    ).toContain("configurations.0.kind");
    expect(
      parseWorkspaceRunDraft(JSON.stringify(createEmptyWorkspaceRunDocument()))
        .document,
    ).toEqual(createEmptyWorkspaceRunDocument());
  });

  it("rejects malformed configuration and input shapes before opening the form", () => {
    const valid = loadPreviewWorkspaceRunDocument();
    const serialized = JSON.stringify(valid);
    expect(parseWorkspaceRunDraft(serialized).document).toEqual(valid);
    for (const changes of [
      { configurations: [{ id: "broken", kind: "task" }] },
      { configurations: [null] },
      { inputs: [{ id: "broken", type: "select", options: "invalid" }] },
      {
        configurations: valid.configurations.map((configuration) => ({
          ...configuration,
          name: 123,
        })),
      },
    ]) {
      const json = JSON.stringify({ ...valid, ...changes });
      expect(parseWorkspaceRunDraft(json).document).toBeNull();
      expect(() => precheckPreviewWorkspaceRunJson(json)).toThrow();
    }
  });

  it("validates references and preserves the preview group order", () => {
    const valid = loadPreviewWorkspaceRunDocument();
    const snapshot = loadPreviewWorkspaceRunSnapshot("C:\\Projects\\sample");
    const group = snapshot.configurations.find(
      (status) => status.configuration.id === "stack",
    );
    expect(group?.children.map((child) => child.configuration.id)).toEqual([
      "api",
      "web",
    ]);
    const invalid = {
      ...valid,
      configurations: valid.configurations.filter(({ id }) => id !== "api"),
    };
    expect(parseWorkspaceRunDraft(JSON.stringify(invalid)).error).toContain(
      "Composite children",
    );
  });

  it("creates unique ids and makes the first configuration the default", () => {
    const document = documentWith("service", "service", "job", "composite");

    expect(document.configurations.map(({ id }) => id)).toEqual([
      "new-service",
      "new-service-2",
      "new-job",
      "new-group",
    ]);
    expect(document.configurations.map(({ primary }) => primary)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(task(document, "new-job").runType).toBe("job");
    expect(task(document, "new-service").workingDirectory).toBe(".");
    expect(uniqueWorkspaceRunId([], "  Web App! ")).toBe("web-app");
    expect(uniqueWorkspaceRunId([], "!!!")).toBe("run");
  });

  it("duplicates configurations next to the source without the default flag", () => {
    const result = duplicateWorkspaceRunConfiguration(
      documentWith("service", "job"),
      "new-service",
    );

    expect(result.id).toBe("new-service-copy");
    expect(result.document.configurations.map(({ id }) => id)).toEqual([
      "new-service",
      "new-service-copy",
      "new-job",
    ]);
    expect(task(result.document, "new-service-copy")).toMatchObject({
      name: "New service copy",
      primary: false,
    });
    expect(() =>
      duplicateWorkspaceRunConfiguration(result.document, "missing"),
    ).toThrow("Run configuration `missing` does not exist.");
  });

  it("removes configurations from groups and reassigns the default", () => {
    let document = documentWith("service", "job", "composite");
    document = updateWorkspaceRunConfiguration(
      document,
      "new-group",
      toggleWorkspaceRunChild(
        composite(document, "new-group"),
        "new-service",
        true,
      ),
    );
    document = removeWorkspaceRunConfiguration(document, "new-service");

    expect(composite(document, "new-group").children).toEqual([]);
    expect(
      document.configurations.map(({ id, primary }) => [id, primary]),
    ).toEqual([
      ["new-job", true],
      ["new-group", false],
    ]);
  });

  it("keeps exactly one default configuration", () => {
    const document = setPrimaryWorkspaceRunConfiguration(
      documentWith("service", "job"),
      "new-job",
    );

    expect(document.configurations.map(({ primary }) => primary)).toEqual([
      false,
      true,
    ]);
  });

  it("renames ids inside groups and clears service-only settings for jobs", () => {
    let document = documentWith("service", "composite");
    document = updateWorkspaceRunConfiguration(
      document,
      "new-group",
      toggleWorkspaceRunChild(
        composite(document, "new-group"),
        "new-service",
        true,
      ),
    );
    const service = task(document, "new-service");
    document = updateWorkspaceRunConfiguration(document, "new-service", {
      ...service,
      id: "web",
      runType: "job",
      healthCheck: { kind: "tcp", port: 3000, restartOnFailure: true },
      restartPolicy: { ...service.restartPolicy, onCrash: true },
    });

    expect(composite(document, "new-group").children).toEqual(["web"]);
    expect(task(document, "web").healthCheck).toBeNull();
    expect(task(document, "web").restartPolicy.onCrash).toBe(false);
  });

  it("offers only tasks that no other group owns and reorders children", () => {
    let document = documentWith("service", "job", "composite", "composite");
    document = updateWorkspaceRunConfiguration(
      document,
      "new-group",
      toggleWorkspaceRunChild(
        composite(document, "new-group"),
        "new-service",
        true,
      ),
    );

    expect(
      workspaceRunChildCandidates(document, "new-group-2").map(({ id }) => id),
    ).toEqual(["new-job"]);
    expect(
      workspaceRunChildCandidates(document, "new-group").map(({ id }) => id),
    ).toEqual(["new-service", "new-job"]);

    const group = toggleWorkspaceRunChild(
      composite(document, "new-group"),
      "new-job",
      true,
    );
    expect(moveWorkspaceRunChild(group, "new-job", -1).children).toEqual([
      "new-job",
      "new-service",
    ]);
    expect(moveWorkspaceRunChild(group, "new-job", 1)).toBe(group);
  });

  it("parses ports, environment, and URLs with actionable errors", () => {
    expect(parseWorkspaceRunPorts("3000, 8080 9229")).toEqual({
      ports: [3000, 8080, 9229],
      error: null,
    });
    expect(parseWorkspaceRunPorts("3000 70000").error).toBe(
      "70000 is not a port between 1 and 65535.",
    );
    expect(parseWorkspaceRunPorts("3000 3000").error).toBe(
      "Port 3000 is listed twice.",
    );
    expect(parseWorkspaceRunEnvironment("A=1\n\nB = two=2")).toEqual({
      environment: { A: "1", B: " two=2" },
      error: null,
    });
    expect(parseWorkspaceRunEnvironment("broken").error).toBe(
      'Use KEY=value for "broken".',
    );
    expect(
      parseWorkspaceRunUrls("http://localhost:3000 http://localhost:3000"),
    ).toEqual({
      urls: ["http://localhost:3000"],
      error: null,
    });
    expect(parseWorkspaceRunUrls("ftp://host").error).toBe(
      "ftp://host is not an http or https URL.",
    );
  });

  it("reports missing fields per configuration", () => {
    let document = documentWith("service", "composite");
    const service = task(document, "new-service");
    document = updateWorkspaceRunConfiguration(document, "new-service", {
      ...service,
      name: " padded",
      healthCheck: { kind: "http", url: "", restartOnFailure: false },
    });

    expect(workspaceRunConfigurationIssues(document)).toEqual([
      {
        configurationId: "new-service",
        message: "Enter a name without leading or trailing spaces.",
      },
      { configurationId: "new-service", message: "Enter a command." },
      {
        configurationId: "new-service",
        message: "The HTTP health check needs a URL.",
      },
      {
        configurationId: "new-group",
        message: "Choose at least one configuration to start.",
      },
    ]);
  });

  it("adds inputs and switches input types with valid defaults", () => {
    const document = addWorkspaceRunInput(
      addWorkspaceRunInput(createEmptyWorkspaceRunDocument()),
    );
    const input = document.inputs[1]!;

    expect(document.inputs.map(({ id }) => id)).toEqual(["input", "input-2"]);
    expect(changeWorkspaceRunInputType(input, "select")).toEqual({
      id: "input-2",
      label: "Input",
      description: undefined,
      type: "select",
      options: [{ value: "default" }],
      default: "default",
    });
    expect(changeWorkspaceRunInputType(input, "boolean")).toMatchObject({
      type: "boolean",
      default: false,
      trueValue: "true",
      falseValue: "false",
    });
  });
});
