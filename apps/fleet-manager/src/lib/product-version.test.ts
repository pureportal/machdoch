import { describe, expect, it } from "vitest";
import { productVersionStatus } from "./product-version";

describe("device version comparison", () => {
  it.each([
    ["29.0.0", "29.0.0", "current"],
    ["28.10.0", "29.0.0", "outdated"],
    ["29.0.0", "29.0.1", "outdated"],
    ["29.0.0", "28.0.0", "newer"],
    ["29.0.0-rc.9", "29.0.0-rc.10", "outdated"],
    ["29.0.0-rc.10", "29.0.0-rc.9", "newer"],
    ["29.0.0-rc.1", "29.0.0", "outdated"],
    ["29.0.0", "29.0.0-rc.1", "newer"],
    ["29.0.0+desktop", "29.0.0+headless", "current"],
    ["29.0.0-rc", "29.0.0-rc.1", "outdated"],
    ["29.0.0-1", "29.0.0-alpha", "outdated"],
    ["v29.0.0", "29.0.0", "unknown"],
    ["29.0.0-01", "29.0.0", "unknown"],
    ["29.0", "29.0.0", "unknown"],
  ])("compares %s with %s", (device, manager, expected) => {
    expect(productVersionStatus(device, manager, 4, 4)).toBe(expected);
  });

  it("rejects a different gateway protocol even with matching product versions", () => {
    expect(productVersionStatus("29.0.0", "29.0.0", 3, 4)).toBe("incompatible");
  });
});
