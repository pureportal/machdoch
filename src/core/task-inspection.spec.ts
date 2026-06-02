import { resolveReadOnlyInspectionTarget } from "./task-inspection.ts";

describe("resolveReadOnlyInspectionTarget", () => {
  it("detects workspace and backend metadata inspection tasks", () => {
    expect(
      resolveReadOnlyInspectionTarget(
        "scan this workspace and explain the setup",
      ),
    ).toBe("workspace");
    expect(resolveReadOnlyInspectionTarget("inspect config")).toBe(
      "runtime-config",
    );
    expect(resolveReadOnlyInspectionTarget("show tools")).toBe("tools");
    expect(resolveReadOnlyInspectionTarget("show profiles")).toBe("profiles");
  });

  it("prefers a generic customization inspection when multiple customization types are requested", () => {
    expect(
      resolveReadOnlyInspectionTarget(
        "inspect prompts and skills for this workspace",
      ),
    ).toBe("customizations");
    expect(resolveReadOnlyInspectionTarget("inspect instructions")).toBe(
      "instructions",
    );
    expect(resolveReadOnlyInspectionTarget("list prompts")).toBe("prompts");
    expect(resolveReadOnlyInspectionTarget("show skills")).toBe("skills");
  });

  it("avoids deterministic matching when the task also includes mutating work", () => {
    expect(
      resolveReadOnlyInspectionTarget("inspect config and update profiles"),
    ).toBeUndefined();
    expect(
      resolveReadOnlyInspectionTarget(
        "show prompts, then install the missing package",
      ),
    ).toBeUndefined();
  });
});
