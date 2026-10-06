import { describe, expect, it } from "vitest";
import { createFleetCliOptions } from "./create-fleet-cli-options.helper.js";
import { CliUsageError } from "./cli-error.js";

type TokenValues = NonNullable<
  Parameters<typeof createFleetCliOptions>[0]["values"]
>;

describe("createFleetCliOptions", () => {
  const parse = (rest: string[], values: TokenValues) =>
    createFleetCliOptions({
      rest,
      values,
      quickRunRequested: false,
      rawTask: undefined,
      runtimeOverridesProvided: false,
    });
  const validCases: [
    string[],
    TokenValues,
    ReturnType<typeof createFleetCliOptions>,
  ][] = [
    [
      ["service"],
      {},
      {
        action: "service",
        serviceAction: "run",
      },
    ],
    [
      ["service", "unit"],
      {},
      {
        action: "service",
        serviceAction: "unit",
      },
    ],
    [
      ["enroll"],
      {
        "manager-url": " https://manager ",
        "enrollment-key": " key ",
        "display-name": " host ",
      },
      {
        action: "enroll",
        managerUrl: "https://manager",
        enrollmentKey: "key",
        displayName: "host",
      },
    ],
  ];
  it.each(validCases)("constructs options for %j", (rest, values, expected) => {
    expect(parse(rest, values)).toEqual(expected);
  });
  const invalidCases: [string[], TokenValues, string][] = [
    [["enroll"], {}, "Expected --manager-url for `machdoch fleet enroll`."],
    [
      ["enroll"],
      {
        "manager-url": "x",
      },
      "Expected --enrollment-key for `machdoch fleet enroll`.",
    ],
    [
      ["enroll"],
      {
        "manager-url": "x",
        "enrollment-key": "k",
      },
      "Expected --display-name for `machdoch fleet enroll`.",
    ],
    [
      ["status"],
      {
        "display-name": "",
      },
      "Fleet enrollment options are only valid for `machdoch fleet enroll`.",
    ],
    [
      ["service", "bad", "extra"],
      {},
      "Expected `fleet service` action to be run, install, uninstall, start, stop, restart, status, or unit.",
    ],
    [
      ["status", "extra"],
      {},
      "Command `fleet status` has unexpected positional arguments: extra",
    ],
  ];
  it.each(invalidCases)(
    "rejects invalid options for %j",
    (rest, values, message) => {
      expect(() => parse(rest, values)).toThrow(new CliUsageError(message));
    },
  );
});

it("rejects runtime overrides after action and positional validation", () => {
  const input = {
    rest: ["status"],
    values: undefined,
    quickRunRequested: false,
    rawTask: undefined,
    runtimeOverridesProvided: true,
  };
  expect(() => createFleetCliOptions(input)).toThrow(
    new CliUsageError(
      "`machdoch fleet` cannot be combined with runtime override options.",
    ),
  );
  expect(() =>
    createFleetCliOptions({ ...input, rest: ["status", "extra"] }),
  ).toThrow(
    new CliUsageError(
      "Command `fleet status` has unexpected positional arguments: extra",
    ),
  );
});
