import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "./tool-argument-validation.js";

afterEach(() => vi.restoreAllMocks());

describe("Tool schema cache", () => {
  it("compiles equivalent reloaded schemas once and still validates each argument", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "reload", type: "object", required: ["query"] };
    expect(validateToolArguments(schema, { query: "one" })).toBeUndefined();
    expect(validateToolArguments(structuredClone(schema), {})).toContain(
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
    expect(validateToolArguments(schema, { old: true })).toBeUndefined();
    expect(
      validateToolArguments({ ...schema, required: ["new"] }, { old: true }),
    ).toContain("new");
    expect(validateToolArguments(schema, { old: true })).toBeUndefined();
  });

  it("caches invalid schemas without repeatedly compiling them", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "invalid-cache", type: "not-a-json-schema-type" };
    expect(validateToolArguments(schema, {})).toContain("schema is invalid");
    expect(validateToolArguments(structuredClone(schema), {})).toContain(
      "schema is invalid",
    );
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("evicts older compiled schemas and rejects oversized schemas before compiling", () => {
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const schema = { title: "eviction-first", type: "object" };
    validateToolArguments(schema, {});
    for (let i = 0; i < 128; i++) {
      validateToolArguments({ title: `eviction-${i}`, type: "object" }, {});
    }
    validateToolArguments(schema, {});
    expect(compile).toHaveBeenCalledTimes(130);
    expect(
      validateToolArguments({ description: "x".repeat(256 * 1024) }, {}),
    ).toContain("exceeds 256 KB");
    expect(compile).toHaveBeenCalledTimes(130);
  });
});
