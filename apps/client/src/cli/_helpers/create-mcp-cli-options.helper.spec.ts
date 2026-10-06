import { describe, expect, it } from "vitest";
import { createMcpCliOptions } from "./create-mcp-cli-options.helper.js";
import { CliUsageError } from "./cli-error.js";

type TokenValues = NonNullable<
  Parameters<typeof createMcpCliOptions>[0]["values"]
>;

describe("createMcpCliOptions", () => {
  const parse = (rest: string[], values: TokenValues) =>
    createMcpCliOptions({
      rest,
      values,
      quickRunRequested: false,
      rawTask: undefined,
    });
  const validCases: [
    string[],
    TokenValues,
    ReturnType<typeof createMcpCliOptions>,
  ][] = [
    [
      [],
      {},
      {
        action: "servers",
      },
    ],
    [
      ["call-tool", " server ", " tool "],
      {
        "arguments-json": " {} ",
      },
      {
        action: "call-tool",
        serverId: "server",
        target: "tool",
        argumentsJson: "{}",
      },
    ],
    [
      ["cleanup"],
      {
        "unused-days": "3",
        "never-used-days": "4",
        apply: true,
      },
      {
        action: "cleanup",
        unusedDays: 3,
        neverUsedDays: 4,
        apply: true,
      },
    ],
    [
      ["proxy", "server"],
      {
        scope: "user",
      },
      {
        action: "proxy",
        scope: "user",
        serverId: "server",
      },
    ],
    [
      ["proxy", "server"],
      {
        scope: "",
      },
      {
        action: "proxy",
        serverId: "server",
      },
    ],
    [
      ["lifecycle-hook"],
      {
        agent: "a",
        phase: "before",
      },
      {
        action: "lifecycle-hook",
        agent: "a",
        phase: "before",
      },
    ],
  ];
  it.each(validCases)("constructs options for %j", (rest, values, expected) => {
    expect(parse(rest, values)).toEqual(expected);
  });
  const invalidCases: [string[], TokenValues, string][] = [
    [["call-tool"], {}, "Expected a server id after `machdoch mcp call-tool`."],
    [
      ["call-tool", "server"],
      {},
      "Expected a target after `machdoch mcp call-tool server`.",
    ],
    [
      ["servers", "server"],
      {},
      "Command `mcp servers` does not accept a server id.",
    ],
    [
      ["discover", "server", "target"],
      {},
      "Command `mcp discover` does not accept a target.",
    ],
    [
      ["servers"],
      {
        "arguments-json": "{}",
      },
      "--arguments-json is only valid for `machdoch mcp call-tool` or `machdoch mcp get-prompt`.",
    ],
    [
      ["proxy", "server"],
      {
        scope: "workspace",
      },
      "Expected `machdoch mcp --scope` to be followed by user.",
    ],
    [
      ["servers"],
      {
        scope: "user",
      },
      "--scope is only valid for `machdoch mcp proxy` and MCP OAuth commands.",
    ],
    [
      ["lifecycle-hook"],
      {},
      "--phase is required for `machdoch mcp lifecycle-hook`.",
    ],
    [
      ["cleanup"],
      {
        "unused-days": "0",
      },
      "Expected --unused-days to be followed by a positive integer.",
    ],
    [
      ["cleanup"],
      {
        "never-used-days": "no",
      },
      "Expected --never-used-days to be followed by a positive integer.",
    ],
    [
      ["cache"],
      {
        "include-disabled": true,
      },
      "--include-disabled is only valid for `machdoch mcp servers`.",
    ],
    [
      ["servers"],
      {
        apply: true,
      },
      "--apply is only valid for `machdoch mcp cleanup`.",
    ],
  ];
  it.each(invalidCases)(
    "rejects invalid options for %j",
    (rest, values, message) => {
      expect(() => parse(rest, values)).toThrow(new CliUsageError(message));
    },
  );
});
