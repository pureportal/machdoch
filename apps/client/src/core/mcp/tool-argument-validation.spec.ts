import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMcpToolArguments } from "./tool-argument-validation.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP tool schema cache", () => {
  it("compiles equivalent reloaded schemas once and still validates each argument", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "reload", type: "object", required: ["query"] };
    expect(validateMcpToolArguments(schema, { query: "one" })).toBeUndefined();
    expect(validateMcpToolArguments(structuredClone(schema), {})).toContain(
      "query",
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("allows a server to revise a schema while keeping its $id", () => {
    const schema = {
      $id: "https://test.example/revised",
      type: "object",
      required: ["old"],
    };
    expect(validateMcpToolArguments(schema, { old: true })).toBeUndefined();
    expect(
      validateMcpToolArguments({ ...schema, required: ["new"] }, { old: true }),
    ).toContain("new");
    expect(validateMcpToolArguments(schema, { old: true })).toBeUndefined();
  });

  it("caches invalid schemas without repeatedly compiling them", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "invalid-cache", type: "not-a-json-schema-type" };
    expect(validateMcpToolArguments(schema, {})).toContain("schema is invalid");
    expect(validateMcpToolArguments(structuredClone(schema), {})).toContain(
      "schema is invalid",
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("evicts older compiled schemas and rejects oversized schemas before compiling", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "eviction-first", type: "object" };
    validateMcpToolArguments(schema, {});
    for (let i = 0; i < 128; i++) {
      validateMcpToolArguments({ title: `eviction-${i}`, type: "object" }, {});
    }
    validateMcpToolArguments(schema, {});
    expect(compile).toHaveBeenCalledTimes(130);
    expect(
      validateMcpToolArguments({ description: "x".repeat(256 * 1024) }, {}),
    ).toContain("exceeds 256 KB");
    expect(compile).toHaveBeenCalledTimes(130);
  });
});
