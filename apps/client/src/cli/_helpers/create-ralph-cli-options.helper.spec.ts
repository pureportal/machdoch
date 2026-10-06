import { describe, expect, it } from "vitest";
import { createRalphCliOptions } from "./create-ralph-cli-options.helper.js";
import { CliUsageError } from "./cli-error.js";

type TokenValues = NonNullable<
  Parameters<typeof createRalphCliOptions>[0]["values"]
>;

describe("createRalphCliOptions", () => {
  const parse = (rest: string[], values: TokenValues) =>
    createRalphCliOptions({
      rest,
      values,
      quickRunRequested: false,
      rawTask: undefined,
    });
  const validCases: [
    string[],
    TokenValues,
    ReturnType<typeof createRalphCliOptions>,
  ][] = [
    [
      [],
      {},
      {
        action: "list",
      },
    ],
    [
      ["run", "flow"],
      {
        scope: "user",
        param: ["a=1", "", " b=2 "],
        "max-transitions": "5",
        isolated: true,
      },
      {
        action: "run",
        subject: "flow",
        scope: "user",
        params: ["a=1", "b=2"],
        maxTransitions: 5,
        isolated: true,
      },
    ],
    [
      ["resume", "id"],
      {
        "retry-current": true,
      },
      {
        action: "resume",
        subject: "id",
        retryCurrent: true,
      },
    ],
    [
      ["create"],
      {
        prompt: " task ",
        name: " flow ",
        "max-rounds": "2",
        "flow-target": "refactor",
        "generation-mode": "do-it",
      },
      {
        action: "create",
        prompt: "task",
        name: "flow",
        maxRounds: 2,
        target: "refactor",
        generationMode: "do-it",
      },
    ],
    [
      ["watches"],
      {},
      {
        action: "watches",
        watchAction: "list",
      },
    ],
    [
      ["watches", "delete", "id"],
      {},
      {
        action: "watches",
        watchAction: "delete",
        subject: "id",
      },
    ],
    [
      ["watches", "create"],
      {
        "watch-json": "{}",
      },
      {
        action: "watches",
        watchAction: "create",
        watchJson: "{}",
      },
    ],
  ];
  it.each(validCases)("constructs options for %j", (rest, values, expected) => {
    expect(parse(rest, values)).toEqual(expected);
  });
  const invalidCases: [string[], TokenValues, string][] = [
    [["run"], {}, "Expected a flow id after `machdoch ralph run`."],
    [
      ["resume", "id"],
      {},
      "`machdoch ralph resume` expects --input-json, --input-json-file, or --retry-current.",
    ],
    [
      ["resume", "id"],
      {
        "retry-current": true,
        "input-json": "{}",
      },
      "Use either --retry-current or an input response for `machdoch ralph resume`, not both.",
    ],
    [
      ["resume", "id"],
      {
        "input-json": "{}",
        "input-json-file": "x",
      },
      "Use either --input-json or --input-json-file for `machdoch ralph resume`, not both.",
    ],
    [
      ["save", "id"],
      {
        "flow-json": "{}",
        "flow-json-file": "x",
      },
      "Use either --flow-json or --flow-json-file for `machdoch ralph save`, not both.",
    ],
    [
      ["create"],
      {},
      "`machdoch ralph create` expects --prompt or --prompt-file.",
    ],
    [
      ["create"],
      {
        prompt: "x",
        "existing-flow-json": "{}",
        "existing-flow-json-file": "x",
      },
      "Use either --existing-flow-json or --existing-flow-json-file for `machdoch ralph create`, not both.",
    ],
    [
      ["run", "id"],
      {
        "max-transitions": "0",
      },
      "Expected --max-transitions to be followed by a positive integer.",
    ],
    [
      ["interview"],
      {
        prompt: "x",
        "max-rounds": "-1",
      },
      "Expected --max-rounds to be followed by a positive integer.",
    ],
    [
      ["watches", "delete"],
      {},
      "Expected a watch id after `machdoch ralph watches delete`.",
    ],
    [
      ["watches", "create"],
      {
        "watch-json": "{}",
        "watch-json-file": "x",
      },
      "Use either --watch-json or --watch-json-file for `machdoch ralph watches create`, not both.",
    ],
    [
      ["list"],
      {
        scope: "invalid",
      },
      "Expected Ralph --scope to be followed by user or workspace.",
    ],
  ];
  it.each(invalidCases)(
    "rejects invalid options for %j",
    (rest, values, message) => {
      expect(() => parse(rest, values)).toThrow(new CliUsageError(message));
    },
  );
});
