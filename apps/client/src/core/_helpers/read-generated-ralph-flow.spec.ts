import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGeneratedRalphFlow } from "./read-generated-ralph-flow.helper.js";
import type { TaskExecutionResult } from "../types.js";

const temporaryRoots: string[] = [];

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-generated-ralph-flow-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const createFlowJson = (id: string): string => {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    variables: [],
    blocks: [],
    edges: [],
  });
};

const createResult = (
  overrides: Partial<Pick<TaskExecutionResult, "summary" | "outputSections" | "response">>,
): TaskExecutionResult => ({
  task: "Generate a Ralph flow",
  mode: "machdoch",
  status: "executed",
  summary: "",
  executedTools: [],
  outputSections: [],
  ...overrides,
});

describe("readGeneratedRalphFlow", () => {
  it("reads tagged flow JSON from the generator response", async () => {
    const result = createResult({
      response: {
        markdown: `<ralph_flow_json>${createFlowJson("tagged")}</ralph_flow_json>`,
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    await expect(readGeneratedRalphFlow("missing.json", result)).resolves.toMatchObject({
      source: "tagged-response",
      flow: { id: "tagged" },
    });
  });

  it("reads fenced flow JSON from output sections", async () => {
    const result = createResult({
      outputSections: [
        {
          title: "Generated",
          lines: ["```json", createFlowJson("fenced"), "```"],
        },
      ],
    });

    await expect(readGeneratedRalphFlow("missing.json", result)).resolves.toMatchObject({
      source: "fenced-response",
      flow: { id: "fenced" },
    });
  });

  it("reads raw flow JSON from the summary", async () => {
    const result = createResult({ summary: createFlowJson("raw") });

    await expect(readGeneratedRalphFlow("missing.json", result)).resolves.toMatchObject({
      source: "raw-response",
      flow: { id: "raw" },
    });
  });

  it("deduplicates repeated invalid response candidates before reporting errors", async () => {
    const invalidTagged = "<ralph_flow_json>{invalid</ralph_flow_json>";
    const result = createResult({
      response: {
        markdown: invalidTagged,
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
      outputSections: [{ title: "Duplicate", lines: [invalidTagged] }],
      summary: invalidTagged,
    });

    const readResult = await readGeneratedRalphFlow("missing.json", result);

    expect(readResult.flow).toBeUndefined();
    expect(readResult.error?.match(/tagged-response/g)).toHaveLength(1);
  });

  it("falls back to the generated file when response candidates are missing", async () => {
    const root = await createTemporaryRoot();
    const filePath = join(root, "flow.json");
    await writeFile(filePath, createFlowJson("file"));

    await expect(readGeneratedRalphFlow(filePath, createResult({}))).resolves.toMatchObject({
      source: "file",
      flow: { id: "file" },
    });
  });

  it("reports invalid generated file JSON", async () => {
    const root = await createTemporaryRoot();
    const filePath = join(root, "flow.json");
    await writeFile(filePath, "{invalid");

    const readResult = await readGeneratedRalphFlow(filePath, createResult({}));

    expect(readResult.flow).toBeUndefined();
    expect(readResult.error).toContain("Generated file was not valid Ralph JSON");
  });

  it("reports missing parseable output when there are no response or file candidates", async () => {
    const readResult = await readGeneratedRalphFlow(
      "missing.json",
      createResult({ summary: "No JSON here." }),
    );

    expect(readResult).toEqual({
      error:
        "The generator did not create a parseable Ralph flow JSON object in its file output or final response.",
    });
  });
});
