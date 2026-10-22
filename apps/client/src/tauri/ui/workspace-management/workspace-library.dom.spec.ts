// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ResearchProject } from "@machdoch/fleet-protocol/workspace-library";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceKnowledgePanel } from "./workspace-knowledge-panel";
import { WorkspaceResearchPanel } from "./workspace-research-panel";
import { WorkspaceLibraryView } from "./workspace-library-view";
import { invokeWorkspaceLibrary } from "./workspace-library-client";

vi.mock("./workspace-library-client", () => ({
  invokeWorkspaceLibrary: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("searches knowledge and opens the selected source with its line range", async () => {
  vi.mocked(invokeWorkspaceLibrary)
    .mockResolvedValueOnce({
      hits: [
        {
          path: "guide.md",
          startLine: 2,
          endLine: 2,
          excerpt: "Relevant passage",
          fingerprint: "a".repeat(64),
        },
      ],
      indexedFiles: 1,
      skippedFiles: 0,
      indexedAt: 1,
    })
    .mockResolvedValueOnce({
      path: "guide.md",
      content: "Heading\nRelevant passage",
      fingerprint: "a".repeat(64),
    });
  render(
    createElement(WorkspaceKnowledgePanel, { workspaceRoot: "C:/project" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search workspace knowledge" }),
    { target: { value: "passage" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("button", { name: "guide.md:2–2" }));
  expect(
    await screen.findByRole("region", { name: "Source preview" }),
  ).toBeTruthy();
  expect(invokeWorkspaceLibrary).toHaveBeenCalledWith("C:/project", {
    action: "search",
    query: "passage",
    limit: 20,
  });
  expect(invokeWorkspaceLibrary).toHaveBeenCalledWith("C:/project", {
    action: "source",
    path: "guide.md",
  });
});

it("keeps unsaved research protected when selecting the already active tab", async () => {
  const user = userEvent.setup();
  vi.mocked(invokeWorkspaceLibrary).mockResolvedValue([]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const changed = vi.fn();
  render(
    createElement(WorkspaceLibraryView, {
      roots: ["C:/project"],
      workspaceRoot: "C:/project",
      onWorkspaceChange: vi.fn(),
      onDirtyChange: changed,
    }),
  );
  await user.click(screen.getByRole("tab", { name: "Research" }));
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Unsaved research" },
  });
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  await user.click(screen.getByRole("tab", { name: "Research" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("tab", { name: "Knowledge" }));
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Discard your unsaved changes?",
  );
  expect(
    (screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value,
  ).toBe("Unsaved research");
  confirm.mockRestore();
});

it("creates a research project and retains the saved revision for later edits", async () => {
  const changed = vi.fn();
  vi.mocked(invokeWorkspaceLibrary).mockImplementation(
    async (_root, request) => {
      if (request.action === "projects") return [];
      if (request.action === "save-project")
        return {
          ...request.project,
          id: "36eb17ed-4a50-44f0-ad58-e25c591338d4",
          revision: request.project.revision + 1,
          createdAt: 1,
          updatedAt: 2,
        };
      return [];
    },
  );
  render(
    createElement(WorkspaceResearchPanel, {
      workspaceRoot: "C:/project",
      onDirtyChange: changed,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Retrieval study" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Research question" }), {
    target: { value: "Which evidence is relevant?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
    target: { value: "New finding" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  await waitFor(() =>
    expect(invokeWorkspaceLibrary).toHaveBeenCalledWith(
      "C:/project",
      expect.objectContaining({
        action: "save-project",
        project: expect.objectContaining({ revision: 1, notes: "New finding" }),
      }),
    ),
  );
});

it("reloads the selected project after a conflict and saves with its current revision", async () => {
  const project: ResearchProject = {
    id: "36eb17ed-4a50-44f0-ad58-e25c591338d4",
    revision: 1,
    title: "Study",
    question: "What changed?",
    notes: "Original",
    status: "active",
    sources: [],
    findings: [],
    createdAt: 1,
    updatedAt: 2,
  };
  let latest = project;
  vi.mocked(invokeWorkspaceLibrary).mockImplementation(
    async (_root, request) => {
      if (request.action === "projects") return [latest];
      if (request.action === "save-project")
        return {
          ...request.project,
          revision: request.project.revision + 1,
          createdAt: 1,
          updatedAt: 3,
        };
      return [];
    },
  );
  render(
    createElement(WorkspaceResearchPanel, {
      workspaceRoot: "C:/project",
      onDirtyChange: vi.fn(),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Study active" }));
  latest = { ...project, revision: 2, notes: "Updated elsewhere" };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Updated elsewhere"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
    target: { value: "My update" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  await waitFor(() =>
    expect(invokeWorkspaceLibrary).toHaveBeenCalledWith(
      "C:/project",
      expect.objectContaining({
        action: "save-project",
        project: expect.objectContaining({ revision: 2, notes: "My update" }),
      }),
    ),
  );
});

it("prevents project selection from being overwritten by an in-flight save", async () => {
  const first: ResearchProject = {
    id: "36eb17ed-4a50-44f0-ad58-e25c591338d4",
    revision: 1,
    title: "First",
    question: "Why?",
    notes: "",
    status: "active",
    sources: [],
    findings: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const second = {
    ...first,
    id: "46eb17ed-4a50-44f0-ad58-e25c591338d4",
    title: "Second",
  };
  let resolveSave!: (project: ResearchProject) => void;
  vi.mocked(invokeWorkspaceLibrary).mockImplementation(
    async (_root, request) => {
      if (request.action === "projects") return [first, second];
      return new Promise<ResearchProject>((resolve) => {
        resolveSave = resolve;
      });
    },
  );
  render(
    createElement(WorkspaceResearchPanel, {
      workspaceRoot: "C:/project",
      onDirtyChange: vi.fn(),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "First active" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
    target: { value: "Pending" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  expect(
    (screen.getByRole("button", { name: "Second active" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () =>
    resolveSave({ ...first, notes: "Pending", revision: 2 }),
  );
});
