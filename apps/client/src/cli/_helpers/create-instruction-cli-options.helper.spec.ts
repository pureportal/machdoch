import { describe, expect, it } from "vitest";
import { createInstructionCliOptions } from "./create-instruction-cli-options.helper.js";
import { CliUsageError } from "./cli-error.js";

type TokenValues = NonNullable<
  Parameters<typeof createInstructionCliOptions>[0]["values"]
>;

describe("createInstructionCliOptions", () => {
  const parse = (
    rest: string[],
    values: NonNullable<
      Parameters<typeof createInstructionCliOptions>[0]["values"]
    >,
  ) =>
    createInstructionCliOptions({
      rest,
      values,
      quickRunRequested: false,
      rawTask: undefined,
      suppliedOptionNames: Object.keys(values),
    });
  const validCases: [
    string[],
    TokenValues,
    ReturnType<typeof createInstructionCliOptions>,
  ][] = [
    [
      [],
      {},
      {
        action: "profile-list",
        group: "profiles",
      },
    ],
    [
      ["profiles", "create"],
      {
        name: " test ",
        description: "",
        prompt: "",
      },
      {
        action: "profile-create",
        group: "profiles",
        name: "test",
        description: "",
        prompt: "",
      },
    ],
    [
      ["assignments", "set", "id"],
      {
        path: "src",
        profile: ["a", "", " b "],
        "expected-revision": "0",
      },
      {
        action: "assignment-set",
        group: "assignments",
        subject: "id",
        path: "src",
        profileIds: ["a", "b"],
        expectedRevision: 0,
      },
    ],
    [
      ["assignments", "relink", "id", "src"],
      {
        path: "new",
      },
      {
        action: "assignment-relink",
        group: "assignments",
        subject: "id",
        secondarySubject: "src",
        path: "new",
      },
    ],
    [
      ["resolve"],
      {
        surface: "cli",
        "ralph-flow": "flow",
        "flow-scope": "user",
      },
      {
        action: "resolve",
        surface: "cli",
        ralphFlow: "flow",
        ralphFlowScope: "user",
      },
    ],
  ];
  it.each(validCases)("constructs options for %j", (rest, values, expected) => {
    expect(parse(rest, values)).toEqual(expected);
  });
  const invalidCases: [string[], TokenValues, string][] = [
    [
      ["profiles", "list"],
      {
        name: "",
      },
      "Expected --name to contain a non-empty name.",
    ],
    [
      ["profiles", "list"],
      {
        name: "x",
      },
      "--name is not valid for `machdoch instructions profile list`.",
    ],
    [
      ["profiles", "create", "x"],
      {
        name: "y",
      },
      "Use either a positional profile name or --name, not both.",
    ],
    [
      ["assignments", "set", "id"],
      {
        profile: [""],
      },
      "Expected --profile to contain a profile UUID.",
    ],
    [
      ["assignments", "set", "id"],
      {},
      "`machdoch instructions assignment set` requires --path.",
    ],
    [
      ["assignments", "relink", "id"],
      {
        path: "x",
      },
      "Assignment relink requires the current relative folder.",
    ],
    [
      ["profiles", "show"],
      {},
      "`machdoch instructions profile show` requires a subject.",
    ],
    [
      ["resolve", "extra"],
      {},
      "`machdoch instructions resolve` does not accept positional arguments.",
    ],
    [
      ["resolve"],
      {
        surface: "other",
      },
      "Expected --surface to be followed by api or cli.",
    ],
    [
      ["profiles", "edit", "id"],
      {
        "expected-revision": "-1",
      },
      "--expected-revision must be zero or greater.",
    ],
  ];
  it.each(invalidCases)(
    "rejects invalid options for %j",
    (rest, values, message) => {
      expect(() => parse(rest, values)).toThrow(new CliUsageError(message));
    },
  );
});

it("retains supplied options even when their values are empty", () => {
  expect(() =>
    createInstructionCliOptions({
      rest: ["profiles", "list"],
      quickRunRequested: false,
      rawTask: undefined,
      values: {},
      suppliedOptionNames: ["scope"],
    }),
  ).toThrow(
    new CliUsageError("--scope is not valid for `machdoch instructions`."),
  );
});

it("omits disabled content flags and validates enabled flags by action", () => {
  const input = {
    rest: ["profiles", "show", "id"],
    quickRunRequested: false,
    rawTask: undefined,
    values: { "include-content": false },
    suppliedOptionNames: ["include-content"],
  };
  expect(createInstructionCliOptions(input)).toEqual({
    action: "profile-show",
    group: "profiles",
    subject: "id",
  });
  expect(() =>
    createInstructionCliOptions({
      ...input,
      values: { "include-content": true },
    }),
  ).toThrow(
    new CliUsageError(
      "--include-content is not valid for `machdoch instructions profile show`.",
    ),
  );
});
