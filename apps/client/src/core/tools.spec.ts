import { getToolDefinition, getToolRegistry } from "./tools.ts";

describe("getToolRegistry", () => {
  it("returns defensive copies of tool definitions", () => {
    const registry = getToolRegistry();
    const originalFilesystemKeywords = [...(registry[0]?.keywords ?? [])];

    registry[0]?.keywords.push("mutated-keyword");

    expect(getToolRegistry()[0]?.keywords).toEqual(originalFilesystemKeywords);
  });
});

describe("getToolDefinition", () => {
  it("returns a tool definition for a known tool name", () => {
    expect(getToolDefinition("filesystem")).toMatchObject({
      name: "filesystem",
      title: "Filesystem",
    });
  });

  it("returns undefined for an unknown tool name", () => {
    expect(getToolDefinition("unknown" as never)).toBeUndefined();
  });
});
