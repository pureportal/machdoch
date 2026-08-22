import { getSchedulerFrontmatterBoolean } from "./get-scheduler-frontmatter-boolean.helper.ts";

describe("getSchedulerFrontmatterBoolean", () => {
  it.each([true, false])("returns boolean frontmatter values %#", (value) => {
    expect(getSchedulerFrontmatterBoolean({ enabled: value }, "enabled")).toBe(value);
  });

  it.each(["true", "yes", "on", "1", " TRUE "])(
    "parses truthy string value %#",
    (value) => {
      expect(getSchedulerFrontmatterBoolean({ enabled: value }, "enabled")).toBe(true);
    },
  );

  it.each(["false", "no", "off", "0", " FALSE "])(
    "parses falsy string value %#",
    (value) => {
      expect(getSchedulerFrontmatterBoolean({ enabled: value }, "enabled")).toBe(
        false,
      );
    },
  );

  it.each(["", "maybe", 1, null, undefined])(
    "returns undefined for unsupported values %#",
    (value) => {
      expect(
        getSchedulerFrontmatterBoolean({ enabled: value }, "enabled"),
      ).toBeUndefined();
    },
  );
});
