import { hasJsonOutputFlag, isBrokenPipeError } from "./cli-error.ts";
import { formatKeyValueRows, shouldUseColor } from "./cli-terminal.ts";

describe("terminal formatting", () => {
  it("uses color only when supported and honors standard overrides", () => {
    expect(shouldUseColor({ env: {}, isTTY: false })).toBe(false);
    expect(shouldUseColor({ env: {}, isTTY: true })).toBe(true);
    expect(shouldUseColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe(false);
    expect(shouldUseColor({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(
      true,
    );
    expect(shouldUseColor({ env: { FORCE_COLOR: "" }, isTTY: false })).toBe(
      true,
    );
    expect(shouldUseColor({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(
      false,
    );
  });

  it("stacks key/value rows in narrow terminals", () => {
    expect(
      formatKeyValueRows([["workspace.github-customizations", "enabled"]], {
        terminalWidth: 40,
      }),
    ).toEqual(["  workspace.github-customizations", "    enabled"]);
  });

  it("recognizes broken pipes across Linux and Windows Node streams", () => {
    expect(isBrokenPipeError({ code: "EPIPE" })).toBe(true);
    expect(isBrokenPipeError({ code: "EINVAL" })).toBe(false);
    expect(isBrokenPipeError(new Error("closed"))).toBe(false);
  });

  it("does not mistake task text after -- for the JSON output flag", () => {
    expect(hasJsonOutputFlag(["run", "task", "--json"])).toBe(true);
    expect(hasJsonOutputFlag(["run", "--", "--json"])).toBe(false);
  });
});
