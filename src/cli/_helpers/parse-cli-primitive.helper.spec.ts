import {
  assertNoAdditionalPositionals,
  normalizeContextPaths,
  normalizeImagePaths,
  parseBooleanToggle,
  parseMemoryOverride,
  parseOptionalInteger,
  parseOptionalPositiveInteger,
  parseOptionalPositiveNumber,
  parsePositiveInteger,
  parsePositiveNumber,
} from "./parse-cli-primitive.helper.ts";

describe("parse CLI primitive helpers", () => {
  it("parses boolean toggles and memory overrides", () => {
    expect(parseBooleanToggle("on", "--flag")).toBe(true);
    expect(parseBooleanToggle("off", "--flag")).toBe(false);
    expect(parseMemoryOverride("inherit", "--memory")).toBeUndefined();
    expect(parseMemoryOverride("on", "--memory")).toBe(true);
    expect(parseMemoryOverride("off", "--memory")).toBe(false);
  });

  it.each(["", "maybe", "true"])("rejects invalid toggle value %s", (value) => {
    expect(() => parseBooleanToggle(value, "--flag")).toThrow(
      "Expected --flag to be followed by on or off.",
    );
  });

  it.each(["", "maybe", "true"])(
    "rejects invalid memory override value %s",
    (value) => {
      expect(() => parseMemoryOverride(value, "--memory")).toThrow(
        "Expected --memory to be followed by inherit, on, or off.",
      );
    },
  );

  it("parses positive integer and number boundaries", () => {
    expect(parsePositiveInteger("1", "--count")).toBe(1);
    expect(parsePositiveInteger("9007199254740991", "--count")).toBe(
      9_007_199_254_740_991,
    );
    expect(parsePositiveNumber("0.1", "--factor")).toBe(0.1);
    expect(parseOptionalInteger("-3", "--priority")).toBe(-3);
    expect(parseOptionalInteger(undefined, "--priority")).toBeUndefined();
    expect(parseOptionalPositiveInteger(undefined, "--count")).toBeUndefined();
    expect(parseOptionalPositiveNumber(undefined, "--factor")).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity"])(
    "rejects invalid positive integer %s",
    (value) => {
      expect(() => parsePositiveInteger(value, "--count")).toThrow(
        "Expected --count to be followed by a positive integer.",
      );
    },
  );

  it.each(["0", "-1", "NaN", "Infinity"])(
    "rejects invalid positive number %s",
    (value) => {
      expect(() => parsePositiveNumber(value, "--factor")).toThrow(
        "Expected --factor to be followed by a positive number.",
      );
    },
  );

  it("normalizes repeated context and image paths", () => {
    expect(normalizeContextPaths(undefined)).toBeUndefined();
    expect(normalizeImagePaths(undefined)).toBeUndefined();
    expect(normalizeContextPaths([" docs/a.md ", "", "docs/a.md"])).toEqual([
      "docs/a.md",
    ]);
    expect(normalizeImagePaths([" screen.png ", "mockup.webp"])).toEqual([
      "screen.png",
      "mockup.webp",
    ]);
  });

  it("rejects empty repeated path flags after trimming", () => {
    expect(() => normalizeContextPaths([" ", ""])).toThrow(
      "Expected --context to be followed by a file or folder path.",
    );
    expect(() => normalizeImagePaths([" ", ""])).toThrow(
      "Expected --image to be followed by an image file path.",
    );
  });

  it("rejects positional arguments for summary commands", () => {
    expect(() => assertNoAdditionalPositionals("config", ["extra"])).toThrow(
      "Command `config` does not accept positional arguments: extra",
    );
    expect(() => assertNoAdditionalPositionals("run", ["task"])).not.toThrow();
  });
});
