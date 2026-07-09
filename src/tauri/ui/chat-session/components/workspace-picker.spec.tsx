import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../components/ui/tooltip";
import { WorkspacePicker } from "./workspace-picker";

interface RenderWorkspacePickerOptions {
  currentWorkspace?: string | null;
  workspaceLabel?: string;
  recentWorkspaces?: string[];
  hasActiveWorkspace?: boolean;
  workspaceLocked?: boolean;
  allowNotSet?: boolean;
}

const renderWorkspacePicker = ({
  currentWorkspace = "C:\\Development\\_others\\machdoch",
  workspaceLabel = "machdoch",
  recentWorkspaces = [
    "C:\\Development\\_others\\machdoch",
    "C:\\Development\\alphartis.cloud.morgana",
    "C:\\Development\\alphartis.cloud.malphite",
  ],
  hasActiveWorkspace = currentWorkspace !== null,
  workspaceLocked = false,
  allowNotSet = true,
}: RenderWorkspacePickerOptions = {}): {
  onSelectWorkspace: ReturnType<typeof vi.fn>;
  onRemoveWorkspace: ReturnType<typeof vi.fn>;
  onChooseNewWorkspace: ReturnType<typeof vi.fn>;
} => {
  const onSelectWorkspace = vi.fn();
  const onRemoveWorkspace = vi.fn();
  const onChooseNewWorkspace = vi.fn().mockResolvedValue(undefined);

  render(
    <TooltipProvider>
      <WorkspacePicker
        currentWorkspace={currentWorkspace}
        workspaceLabel={workspaceLabel}
        recentWorkspaces={recentWorkspaces}
        hasActiveWorkspace={hasActiveWorkspace}
        workspaceLocked={workspaceLocked}
        allowNotSet={allowNotSet}
        onSelectWorkspace={onSelectWorkspace}
        onRemoveWorkspace={onRemoveWorkspace}
        onChooseNewWorkspace={onChooseNewWorkspace}
      />
    </TooltipProvider>,
  );

  return { onSelectWorkspace, onRemoveWorkspace, onChooseNewWorkspace };
};

const openWorkspacePicker = async (
  buttonName: string | RegExp = "machdoch",
): Promise<HTMLElement> => {
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  return await screen.findByRole("searchbox", { name: "Search workspaces" });
};

describe("WorkspacePicker", () => {
  afterEach(() => {
    cleanup();
  });

  it("focuses the workspace search input when opened", async () => {
    renderWorkspacePicker();

    const searchInput = await openWorkspacePicker();

    await waitFor(() => {
      expect(document.activeElement).toBe(searchInput);
    });
  });

  it("filters workspace entries from typed search text", async () => {
    renderWorkspacePicker({
      currentWorkspace: null,
      workspaceLabel: "Not Set",
      hasActiveWorkspace: false,
    });

    const searchInput = await openWorkspacePicker("Not Set");
    fireEvent.change(searchInput, { target: { value: "morg" } });

    expect(screen.getByText("alphartis.cloud.morgana")).toBeTruthy();
    expect(screen.queryByText("alphartis.cloud.malphite")).toBeNull();
    expect(screen.queryByText("machdoch")).toBeNull();
  });

  it("selects the highest-ranked workspace when pressing Enter in search", async () => {
    const { onSelectWorkspace } = renderWorkspacePicker({
      currentWorkspace: null,
      workspaceLabel: "Not Set",
      recentWorkspaces: [
        "C:\\Development\\machdoch-old",
        "C:\\Development\\_others\\machdoch",
      ],
      hasActiveWorkspace: false,
    });

    const searchInput = await openWorkspacePicker("Not Set");
    fireEvent.change(searchInput, { target: { value: "machdoch" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(onSelectWorkspace).toHaveBeenCalledWith(
      "C:\\Development\\_others\\machdoch",
    );
  });
});
