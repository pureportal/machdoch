import type { InstructionWorkspaceView } from "../runtime";
import {
  createManagedWorkspaceViews,
  createWorkspaceRootKey,
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
} from "./workspace-management-model";

const createInstructionWorkspace = (
  overrides: Partial<InstructionWorkspaceView> = {},
): InstructionWorkspaceView => ({
  id: "instruction-workspace",
  root: "C:\\Projects\\machdoch",
  displayName: "Machdoch Desktop",
  tags: ["desktop"],
  scopes: [{ path: ".", profiles: ["profile-one"] }],
  ...overrides,
});

describe("workspace management model", () => {
  it("lists global workspace roots when the instruction registry is empty", () => {
    const workspaces = createManagedWorkspaceViews(
      ["C:\\Projects\\machdoch", "C:\\Projects\\alphartis.ashe"],
      [],
    );

    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((workspace) => workspace.root)).toEqual([
      "C:\\Projects\\machdoch",
      "C:\\Projects\\alphartis.ashe",
    ]);
    expect(workspaces.every((workspace) => !workspace.instructionWorkspace)).toBe(
      true,
    );
    expect(workspaces.map(getManagedWorkspaceName)).toEqual([
      "machdoch",
      "alphartis.ashe",
    ]);
  });

  it("enriches roots with matching instruction metadata without changing the list", () => {
    const matching = createInstructionWorkspace({
      root: "c:/projects/machdoch/",
    });
    const registryOnly = createInstructionWorkspace({
      id: "registry-only",
      root: "C:\\Projects\\registry-only",
    });
    const workspaces = createManagedWorkspaceViews(
      ["C:\\Projects\\machdoch"],
      [matching, registryOnly],
    );

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.root).toBe("C:\\Projects\\machdoch");
    expect(workspaces[0]?.instructionWorkspace).toBe(matching);
    expect(getManagedWorkspaceName(workspaces[0]!)).toBe("Machdoch Desktop");
    expect(getManagedWorkspaceTags(workspaces[0]!)).toEqual(["desktop"]);
  });

  it("deduplicates equivalent global roots with a stable path key", () => {
    const workspaces = createManagedWorkspaceViews(
      [" C:\\Projects\\machdoch ", "c:/projects/machdoch/"],
      [],
    );

    expect(workspaces).toHaveLength(1);
    expect(createWorkspaceRootKey("C:\\Projects\\machdoch\\")).toBe(
      createWorkspaceRootKey("c:/projects/machdoch"),
    );
  });
});
