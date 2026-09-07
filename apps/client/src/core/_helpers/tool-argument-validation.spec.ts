import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "./tool-argument-validation.js";

afterEach(() => vi.restoreAllMocks());

describe("Tool schema dialects", () => {
  it.each([
    "http://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-07/schema",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2019-09/schema#",
    "https://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema#",
  ])("validates arguments using the declared dialect %s", ($schema) => {
    const schema = {
      $schema,
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status"] },
        port: { type: "integer", minimum: 1, maximum: 65535 },
      },
      required: ["action"],
      additionalProperties: false,
    };

    expect(validateToolArguments(schema, { action: "status" })).toBeUndefined();
    expect(
      validateToolArguments(schema, { action: "start", port: 9223 }),
    ).toBeUndefined();
    for (const args of [
      {},
      { action: "invalid" },
      { action: "start", port: "9223" },
      { action: "status", extra: true },
    ]) {
      expect(validateToolArguments(schema, args)).toContain(
        "Tool arguments do not match the input schema",
      );
    }
  });

  it.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
  ])("enforces tuple items and local references in %s", ($schema) => {
    const schema = {
      $schema,
      type: "object",
      definitions: { label: { type: "string", minLength: 1 } },
      properties: {
        pair: {
          type: "array",
          items: [{ $ref: "#/definitions/label" }, { type: "integer" }],
          minItems: 2,
          additionalItems: false,
        },
      },
      required: ["pair"],
    };

    expect(
      validateToolArguments(schema, { pair: ["value", 2] }),
    ).toBeUndefined();
    for (const pair of [
      ["", 2],
      ["value", "2"],
      ["value", 2, 3],
    ]) {
      expect(validateToolArguments(schema, { pair })).toContain(
        "Tool arguments do not match the input schema",
      );
    }
  });

  it("enforces 2019-09 dependent and unevaluated properties", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      type: "object",
      allOf: [
        { properties: { host: { type: "string" }, port: { type: "integer" } } },
      ],
      dependentRequired: { host: ["port"] },
      unevaluatedProperties: false,
    };

    expect(
      validateToolArguments(schema, { host: "localhost", port: 9223 }),
    ).toBeUndefined();
    expect(validateToolArguments(schema, { host: "localhost" })).toContain(
      "port",
    );
    expect(validateToolArguments(schema, { extra: true })).toContain(
      "unevaluated",
    );
  });

  it.each([undefined, "https://json-schema.org/draft/2020-12/schema"])(
    "enforces 2020-12 prefix items with dialect %s",
    ($schema) => {
      const schema = {
        ...($schema ? { $schema } : {}),
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            minItems: 2,
            items: false,
          },
        },
      };

      expect(
        validateToolArguments(schema, { pair: ["value", 2] }),
      ).toBeUndefined();
      for (const pair of [
        [2, "value"],
        ["value", 2, 3],
      ]) {
        expect(validateToolArguments(schema, { pair })).toContain(
          "Tool arguments do not match the input schema",
        );
      }
    },
  );

  it("does not reinterpret an undeclared schema as Draft-07", () => {
    expect(
      validateToolArguments(
        {
          type: "object",
          properties: { pair: { type: "array", items: [{ type: "string" }] } },
        },
        { pair: ["value"] },
      ),
    ).toContain("schema is invalid");
  });

  it("reports unsupported dialects explicitly", () => {
    expect(
      validateToolArguments(
        {
          $schema: "https://example.com/custom-schema",
          type: "object",
        },
        {},
      ),
    ).toContain(
      "Unsupported JSON Schema dialect: https://example.com/custom-schema",
    );
  });

  it.each([null, 7, {}, []])("rejects a non-string dialect %j", ($schema) => {
    expect(validateToolArguments({ $schema, type: "object" }, {})).toContain(
      "$schema must be a string",
    );
  });
});

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
