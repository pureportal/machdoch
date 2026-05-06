/// <reference types="vitest/globals" />
import type { AgentToolExecutionContext } from "./agent-tools-shared.js";
import { createUtilityToolDefinitions } from "./utility-tool-definitions.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const createContext = (): AgentToolExecutionContext => {
  return {
    workspaceRoot: "C:/workspace",
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
  };
};

const getTool = (name: string) => {
  const tool = createUtilityToolDefinitions().find(
    (entry) => entry.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Expected utility tool ${name} to be registered.`);
  }

  return tool;
};

describe("createUtilityToolDefinitions", () => {
  it("registers low-risk UUID and random string tools", () => {
    const tools = createUtilityToolDefinitions();

    expect(tools.map((tool) => tool.spec.name)).toEqual([
      "generate_uuid",
      "generate_random_string",
    ]);
    expect(tools.map((tool) => tool.backingTool)).toEqual([
      "utilities",
      "utilities",
    ]);
    expect(tools.map((tool) => tool.riskLevel)).toEqual(["low", "low"]);
  });

  it("generates requested UUID counts", async () => {
    const result = await getTool("generate_uuid").execute(
      { count: 3 },
      createContext(),
    );
    const generated = result.sections.find(
      (section) => section.title === "Generated UUIDs",
    )?.lines;

    expect(result.toolResult.isError).toBeUndefined();
    expect(generated).toHaveLength(3);
    expect(generated?.every((uuid) => UUID_PATTERN.test(uuid))).toBe(true);
  });

  it("rejects UUID counts outside the bounded range", async () => {
    const result = await getTool("generate_uuid").execute(
      { count: 101 },
      createContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("between 1 and 100");
  });

  it("generates random strings with the selected charset", async () => {
    const result = await getTool("generate_random_string").execute(
      { length: 16, count: 4, charset: "hex" },
      createContext(),
    );
    const generated = result.sections.find(
      (section) => section.title === "Generated random strings",
    )?.lines;

    expect(result.toolResult.isError).toBeUndefined();
    expect(generated).toHaveLength(4);
    expect(generated?.every((value) => /^[0-9a-f]{16}$/u.test(value))).toBe(
      true,
    );
  });

  it("uses a custom alphabet when requested", async () => {
    const result = await getTool("generate_random_string").execute(
      { length: 12, charset: "custom", customAlphabet: "AB" },
      createContext(),
    );
    const generated = result.sections.find(
      (section) => section.title === "Generated random strings",
    )?.lines[0];

    expect(result.toolResult.isError).toBeUndefined();
    expect(generated).toMatch(/^[AB]{12}$/u);
  });

  it("rejects invalid random string options", async () => {
    const invalidLength = await getTool("generate_random_string").execute(
      { length: 0 },
      createContext(),
    );
    const invalidCustomAlphabet = await getTool(
      "generate_random_string",
    ).execute({ charset: "custom", customAlphabet: "A" }, createContext());

    expect(invalidLength.toolResult.isError).toBe(true);
    expect(invalidLength.toolResult.output).toContain("length");
    expect(invalidCustomAlphabet.toolResult.isError).toBe(true);
    expect(invalidCustomAlphabet.toolResult.output).toContain(
      "customAlphabet",
    );
  });
});
