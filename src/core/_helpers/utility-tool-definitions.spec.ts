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
      "get_current_datetime",
      "generate_random_number",
      "generate_ulid",
      "hash_text",
      "encode_text",
      "decode_text",
      "validate_json",
      "format_slug",
      "parse_url",
      "build_url",
      "compare_versions",
      "test_regex",
      "diff_text",
      "sort_unique_lines",
    ]);
    expect(tools.every((tool) => tool.backingTool === "utilities")).toBe(true);
    expect(tools.every((tool) => tool.riskLevel === "low")).toBe(true);
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

  it("returns current date and time details for a requested timezone", async () => {
    const result = await getTool("get_current_datetime").execute(
      { timeZone: "UTC" },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("time zone: UTC");
    expect(result.toolResult.output).toContain("UTC offset: +00:00");
    expect(result.toolResult.output).toContain("UTC ISO:");
  });

  it("rejects invalid timezones", async () => {
    const result = await getTool("get_current_datetime").execute(
      { timeZone: "Not/AZone" },
      createContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("valid IANA timezone");
  });

  it("generates bounded unique random integers", async () => {
    const result = await getTool("generate_random_number").execute(
      { min: 1, max: 5, count: 5, integer: true, unique: true },
      createContext(),
    );
    const generated = result.sections.find(
      (section) => section.title === "Generated random numbers",
    )?.lines;

    expect(result.toolResult.isError).toBeUndefined();
    expect(generated).toHaveLength(5);
    expect(new Set(generated).size).toBe(5);
    expect(
      generated?.every((value) => Number(value) >= 1 && Number(value) <= 5),
    ).toBe(true);
  });

  it("rejects impossible unique random integer requests", async () => {
    const result = await getTool("generate_random_number").execute(
      { min: 1, max: 2, count: 3, integer: true, unique: true },
      createContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("unique integers");
  });

  it("generates sortable ULID-compatible identifiers", async () => {
    const result = await getTool("generate_ulid").execute(
      { count: 3 },
      createContext(),
    );
    const generated = result.sections.find(
      (section) => section.title === "Generated ULIDs",
    )?.lines;

    expect(result.toolResult.isError).toBeUndefined();
    expect(generated).toHaveLength(3);
    expect(
      generated?.every((ulid) =>
        /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(ulid),
      ),
    ).toBe(true);
    expect(generated).toEqual([...(generated ?? [])].sort());
  });

  it("hashes text with the selected algorithm and output encoding", async () => {
    const result = await getTool("hash_text").execute(
      { text: "hello", algorithm: "sha256" },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("encodes and decodes text values", async () => {
    const encoded = await getTool("encode_text").execute(
      { text: "hello world", format: "base64url" },
      createContext(),
    );
    const decoded = await getTool("decode_text").execute(
      { value: encoded.toolResult.output, format: "base64url" },
      createContext(),
    );

    expect(encoded.toolResult.output).toBe("aGVsbG8gd29ybGQ");
    expect(decoded.toolResult.output).toBe("hello world");
  });

  it("rejects malformed encoded text", async () => {
    const result = await getTool("decode_text").execute(
      { value: "abc", format: "hex" },
      createContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("hexadecimal");
  });

  it("validates, pretty-prints, and minifies JSON", async () => {
    const pretty = await getTool("validate_json").execute(
      { text: "{\"name\":\"machdoch\"}", outputStyle: "pretty", indent: 2 },
      createContext(),
    );
    const invalid = await getTool("validate_json").execute(
      { text: "{\"name\":" },
      createContext(),
    );

    expect(pretty.toolResult.isError).toBeUndefined();
    expect(pretty.toolResult.output).toContain("valid: true");
    expect(pretty.toolResult.output).toContain('"name": "machdoch"');
    expect(invalid.toolResult.isError).toBeUndefined();
    expect(invalid.toolResult.output).toContain("valid: false");
  });

  it("formats text as slug and identifier styles", async () => {
    const slug = await getTool("format_slug").execute(
      { text: "Machdoch Utility Tools!" },
      createContext(),
    );
    const pascal = await getTool("format_slug").execute(
      { text: "Machdoch utility tools", style: "pascal" },
      createContext(),
    );

    expect(slug.toolResult.output).toBe("machdoch-utility-tools");
    expect(pascal.toolResult.output).toBe("MachdochUtilityTools");
  });

  it("parses absolute and base-relative URLs", async () => {
    const result = await getTool("parse_url").execute(
      {
        url: "/docs?topic=tools#utilities",
        baseUrl: "https://example.com/base/",
      },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain(
      "href: https://example.com/docs?topic=tools#utilities",
    );
    expect(result.toolResult.output).toContain("query: topic=tools");
  });

  it("builds URLs with encoded query params and hash fragments", async () => {
    const result = await getTool("build_url").execute(
      {
        baseUrl: "https://example.com/search",
        queryParams: [
          { name: "q", value: "utility tools" },
          { name: "page", value: "1" },
        ],
        hash: "top",
      },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toBe(
      "https://example.com/search?q=utility+tools&page=1#top",
    );
  });

  it("compares semver-like version strings", async () => {
    const greater = await getTool("compare_versions").execute(
      { left: "1.2.10", right: "1.2.3" },
      createContext(),
    );
    const prerelease = await getTool("compare_versions").execute(
      { left: "1.0.0-alpha", right: "1.0.0" },
      createContext(),
    );

    expect(greater.toolResult.output).toContain("order: greater");
    expect(prerelease.toolResult.output).toContain("order: less");
  });

  it("tests regular expressions with captures", async () => {
    const result = await getTool("test_regex").execute(
      {
        pattern: "id=(\\d+)",
        text: "first id=12, second id=34",
        maxMatches: 2,
      },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("match 1: index=6, text=id=12");
    expect(result.toolResult.output).toContain("group 1: 12");
    expect(result.toolResult.output).toContain("match 2: index=20, text=id=34");
  });

  it("rejects invalid regex flags", async () => {
    const result = await getTool("test_regex").execute(
      { pattern: "a", text: "a", flags: "x" },
      createContext(),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("flags");
  });

  it("creates compact text diffs", async () => {
    const result = await getTool("diff_text").execute(
      {
        left: "alpha\nbeta\ngamma",
        right: "alpha\nbravo\ngamma",
        contextLines: 1,
      },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("-beta");
    expect(result.toolResult.output).toContain("+bravo");
  });

  it("sorts and deduplicates newline-separated lists", async () => {
    const result = await getTool("sort_unique_lines").execute(
      {
        text: " banana\nApple\napple\nbanana\n",
        caseSensitive: false,
      },
      createContext(),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toBe("Apple\nbanana");
  });
});
